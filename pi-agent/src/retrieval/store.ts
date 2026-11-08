import * as lancedb from "@lancedb/lancedb";
import type { Candidate, IndexRow, SourceKind } from "./types.js";
import {IndexAccess} from "./indexAccess.js";

export const sqlString = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const columns = ["id", "source_id", "source_version", "kind", "name", "scope_id", "goal_name", "skill_id",
  "chunk_id", "ordinal", "text", "heading", "locator_json", "source_ref", "lexical_text", "embedding_hash", "has_vector"];

export class LocalRetrievalIndex {
  private connection?: lancedb.Connection;
  private table?: lancedb.Table;
  private ftsReady = false;
  private readonly access: IndexAccess;
  constructor(readonly path: string, readonly dimensions: number) {this.access = new IndexAccess(path);}
  private async openUnsafe(): Promise<void> {
    this.connection = await lancedb.connect(this.path, { readConsistencyInterval: 0 });
    if ((await this.connection.tableNames()).includes("chunks")) this.table = await this.connection.openTable("chunks");
    if (this.table) this.ftsReady = (await this.table.listIndices()).some(index => index.columns.includes("lexical_text"));
  }
  private async refreshTable() {
    if (!this.connection) await this.openUnsafe();
    if (!this.table && (await this.connection!.tableNames()).includes("chunks")) {
      this.table = await this.connection!.openTable("chunks");
    }
    // 另一进程可能刚清掉最后一行及旧FTS；缓存true不能让后续写入永远跳过重建。
    if (this.table) this.ftsReady = (await this.table.listIndices()).some(index => index.columns.includes("lexical_text"));
  }
  private async upsertUnsafe(rows: IndexRow[]): Promise<void> {
    if (!rows.length) return;
    if (rows.some(row => row.vector.length !== this.dimensions)) throw new Error("Index generation vector dimension mismatch");
    // 另一进程可能在本连接启动后建立表；取得写锁后的操作同样要重新发现它。
    await this.refreshTable();
    const records = rows.map(row => ({ ...row }));
    if (!this.table) this.table = await this.connection!.createTable("chunks", records);
    else await this.table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(records);
    if (!this.ftsReady) {
      await this.table.createIndex("lexical_text", { config: lancedb.Index.fts({
        baseTokenizer: "whitespace", stem: false, removeStopWords: false, maxTokenLength: 1024 }) });
      this.ftsReady = true;
    }
  }
  private async removeSourceUnsafe(sourceId: string): Promise<void> {
    await this.refreshTable();
    if (this.table) await this.table.delete("source_id = " + sqlString(sourceId));
  }
  private async sourceRowsUnsafe(sourceId: string): Promise<IndexRow[]> {
    await this.refreshTable();
    if (!this.table) return [];
    return await this.table.query().where("source_id = " + sqlString(sourceId)).toArray() as IndexRow[];
  }
  private filter(scopes: string[], kinds?: SourceKind[], materialId?: string): string {
    let filter = "scope_id IN (" + scopes.map(sqlString).join(",") + ")";
    if (kinds?.length) filter += " AND kind IN (" + kinds.map(sqlString).join(",") + ")";
    if (materialId) filter += " AND source_id = " + sqlString("material:" + materialId);
    return filter;
  }
  private candidates(rows: Record<string, any>[], stage: string): Candidate[] {
    return rows.map(row => {
      const score = Number(stage === "bm25" ? row._score : 1 - row._distance);
      const selected = Object.fromEntries(columns.map(column => [column, row[column]]));
      return { ...selected, ordinal: Number(row.ordinal), score, score_parts: { [stage]: score } } as Candidate;
    });
  }
  private async lexicalUnsafe(query: string, scopes: string[], kinds?: SourceKind[], materialId?: string, limit = 20): Promise<Candidate[]> {
    await this.refreshTable();
    if (!this.table || !this.ftsReady || !query || !scopes.length) return [];
    const rows = await this.table.query().fullTextSearch(query, { columns: "lexical_text" })
      .where(this.filter(scopes, kinds, materialId)).select([...columns, "_score"]).limit(limit).toArray();
    return this.candidates(rows, "bm25");
  }
  private async denseUnsafe(vector: number[], scopes: string[], kinds?: SourceKind[], materialId?: string, limit = 20): Promise<Candidate[]> {
    await this.refreshTable();
    if (!this.table || !scopes.length) return [];
    if (vector.length !== this.dimensions) throw new Error("Query vector generation mismatch");
    const rows = await this.table.vectorSearch(vector).distanceType("cosine").ef(200).refineFactor(10)
      .where(this.filter(scopes, kinds, materialId) + " AND has_vector = true").select([...columns, "_distance"]).limit(limit).toArray();
    return this.candidates(rows, "dense");
  }
  private async maintainUnsafe(): Promise<void> {
    if (!this.table) return;
    await this.table.optimize();
    const count = await this.table.countRows("has_vector = true");
    if (count >= 10_000 && !(await this.table.listIndices()).some(index => index.columns.includes("vector"))) {
      await this.table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "cosine" }) });
    }
  }
  private async referencesUnsafe(refs: string[], scopes: string[], kinds?: SourceKind[], materialId?: string): Promise<Candidate[]> {
    await this.refreshTable();
    if (!this.table || !refs.length || !scopes.length) return [];
    const rows = await this.table.query().where(this.filter(scopes, kinds, materialId) +
      " AND source_ref IN (" + refs.slice(0, 30).map(sqlString).join(",") + ")").select(columns).limit(30).toArray();
    return rows.map(row => ({...row, ordinal: Number(row.ordinal), score: 0, score_parts: {}} as Candidate));
  }
  open(): Promise<void> {return this.access.read(() => this.openUnsafe());}
  upsert(rows: IndexRow[]): Promise<void> {return this.access.read(() => this.upsertUnsafe(rows));}
  removeSource(id: string): Promise<void> {return this.access.read(() => this.removeSourceUnsafe(id));}
  sourceRows(id: string): Promise<IndexRow[]> {return this.access.read(() => this.sourceRowsUnsafe(id));}
  lexical(query: string, scopes: string[], kinds?: SourceKind[], materialId?: string, limit = 20): Promise<Candidate[]> {
    return this.access.read(() => this.lexicalUnsafe(query, scopes, kinds, materialId, limit));
  }
  dense(vector: number[], scopes: string[], kinds?: SourceKind[], materialId?: string, limit = 20): Promise<Candidate[]> {
    return this.access.read(() => this.denseUnsafe(vector, scopes, kinds, materialId, limit));
  }
  references(refs: string[], scopes: string[], kinds?: SourceKind[], materialId?: string): Promise<Candidate[]> {
    return this.access.read(() => this.referencesUnsafe(refs, scopes, kinds, materialId));
  }
  maintain(): Promise<void> {return this.access.read(() => this.maintainUnsafe());}
  count(): Promise<number> {return this.access.read(async () => {await this.refreshTable(); return this.table ? this.table.countRows() : 0;});}
  /** 调用方仍须持有目录writer.lock；access另保证没有其他进程的在途原生读取。 */
  eraseSources(ids: string[]): Promise<void> {
    return this.access.maintenance(async () => {
      await this.refreshTable();
      if (!this.table || !ids.length) return;
      for (let at = 0; at < ids.length; at += 256)
        await this.table.delete("source_id IN (" + ids.slice(at, at + 256).map(sqlString).join(",") + ")");
      // 否则旧FTS/向量索引文件及历史版本可能继续保留被删除的正文。
      for (const index of await this.table.listIndices()) await this.table.dropIndex(index.name);
      this.ftsReady = false;
      await this.table.optimize({cleanupOlderThan: new Date(), deleteUnverified: true});
      if (await this.table.countRows()) {
        await this.table.createIndex("lexical_text", {config: lancedb.Index.fts({
          baseTokenizer: "whitespace", stem: false, removeStopWords: false, maxTokenLength: 1024})});
        this.ftsReady = true;
      }
      await this.table.optimize({cleanupOlderThan: new Date(), deleteUnverified: true});
    });
  }
  close(): void { this.table?.close(); this.connection?.close(); this.table = undefined; this.connection = undefined; }
}
