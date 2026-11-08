import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, stat, lstat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import type {SourceBackend} from "./types.js";
import {IndexAccess} from "./indexAccess.js";

const materialId = /^mat-[0-9a-f]{32}$/;
const generationId = /^[0-9a-f]{24}$/;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const traceFile = /^[0-9a-f-]{36}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/;
interface Ledger {version: 1; deleted: Record<string, string>; cleaned: Record<string, string>}

/** Kernel拥有永久失效，Node只保存无正文的清理进度；旧索引代与诊断不可因重开重新成为有效来源。 */
export class MaterialDeletionCache {
  private deleted = new Map<string, string>();
  private blocked = new Set<string>();
  private cleaned = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private pendingOriginals = new Set<string>();
  private readonly traces: IndexAccess;
  constructor(private readonly directory: string, private readonly backend: SourceBackend,
    private readonly onDeleted: (sourceId: string) => void) {this.traces = new IndexAccess(join(directory, "traces"));}
  withTrace<T>(work: () => Promise<T>): Promise<T> {return this.traces.read(work);}
  block(id: string): void {
    if (!materialId.test(id)) throw new Error("INVALID_MATERIAL_ID");
    if (!this.blocked.has(id)) {this.blocked.add(id); this.onDeleted("material:" + id);}
  }
  has(sourceId: string): boolean {return sourceId.startsWith("material:") && this.blocked.has(sourceId.slice(9));}
  get sourceIds(): string[] {return [...this.blocked].sort().map(id => "material:" + id);}
  private get fingerprint(): string {return digest([...this.deleted].sort());}
  private async load(): Promise<void> {
    const path = join(this.directory, "material-deletions.json");
    let value: Ledger;
    try {
      if ((await lstat(path)).isSymbolicLink() || (await stat(path)).size > 8 * 1024 * 1024) throw new Error("DELETION_CACHE_INVALID");
      const data = JSON.parse(await readFile(path, "utf8"));
      const {checksum, ...saved} = data;
      if (Object.keys(saved).sort().join(",") !== "cleaned,deleted,version" || saved.version !== 1 || checksum !== digest(saved)
        || !saved.deleted || !saved.cleaned || typeof saved.deleted !== "object" || typeof saved.cleaned !== "object"
        || Array.isArray(saved.deleted) || Array.isArray(saved.cleaned)
        || Object.entries(saved.deleted).some(([id, hash]) => !materialId.test(id) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
        || Object.entries(saved.cleaned).some(([id, hash]) => !generationId.test(id) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)))
        throw new Error("DELETION_CACHE_INVALID");
      value = saved as Ledger;
    } catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e;}
    for (const [id, hash] of Object.entries(value.deleted)) this.remember(id, hash);
    for (const [id, hash] of Object.entries(value.cleaned)) if (!this.cleaned.has(id)) this.cleaned.set(id, hash);
  }
  private remember(id: string, hash: string): void {
    if (!materialId.test(id) || !/^[0-9a-f]{64}$/.test(hash) || this.deleted.has(id) && this.deleted.get(id) !== hash)
      throw new Error("DELETION_CACHE_CONFLICT");
    this.deleted.set(id, hash); this.block(id);
  }
  refresh(): Promise<void> {
    const next = this.tail.catch(() => undefined).then(async () => {
      await this.load();
      if (!this.backend.materialDeletions) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        let offset = 0, version: string | undefined, changed = false;
        for (;;) {
          const page = await this.backend.materialDeletions(offset);
          if (page.version !== 1 || !Array.isArray(page.deletions) || page.deletions.length > 100 || typeof page.catalog_version !== "string")
            throw new Error("DELETION_PROTOCOL_INVALID");
          if (version && version !== page.catalog_version) {changed = true; break;}
          version = page.catalog_version;
          for (const row of page.deletions) {
            this.remember(row.id, row.source_hash);
            if (row.original_cleanup === "pending") this.pendingOriginals.add(row.id);
            else if (row.original_cleanup === "complete") this.pendingOriginals.delete(row.id);
            else throw new Error("DELETION_PROTOCOL_INVALID");
          }
          if (page.next_offset === null) break;
          if (!Number.isSafeInteger(page.next_offset) || page.next_offset <= offset) throw new Error("DELETION_PROTOCOL_INVALID");
          offset = page.next_offset;
        }
        if (!changed) return;
      }
      throw new Error("DELETION_CATALOG_CHANGED");
    });
    this.tail = next; return next;
  }
  async persist(): Promise<void> {
    await mkdir(this.directory, {recursive: true});
    const value: Ledger = {version: 1, deleted: Object.fromEntries(this.deleted), cleaned: Object.fromEntries(this.cleaned)};
    const path = join(this.directory, "material-deletions.json"), temporary = path + "." + randomUUID() + ".tmp";
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error("DELETION_CACHE_INVALID");
    const encoded = JSON.stringify({...value, checksum: digest(value)});
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error("DELETION_CACHE_LIMIT");
    await writeFile(temporary, encoded, {mode: 0o600});
    await rename(temporary, path);
  }
  needsCleanup(id: string): boolean {return this.deleted.size > 0 && this.cleaned.get(id) !== this.fingerprint;}
  markCleaned(id: string): void {this.cleaned.set(id, this.fingerprint);}
  async retryOriginals(): Promise<void> {
    if (!this.backend.retryMaterialDeletion) return;
    const end = Date.now() + 5000;
    for (const id of [...this.pendingOriginals].slice(0, 10)) {
      const remaining = end - Date.now(); if (remaining <= 0) break;
      await this.backend.retryMaterialDeletion(id, AbortSignal.timeout(Math.min(1000, remaining))).catch(() => undefined);
      this.pendingOriginals.delete(id); this.pendingOriginals.add(id);
    }
  }
  containsDeleted(value: unknown): boolean {
    if (typeof value === "string") {
      if ([...this.blocked].some(id => value.includes(id))) return true;
      if (value.length <= 4096 && /^[A-Za-z0-9_-]{20,}$/.test(value)) {
        try {const ref = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); return typeof ref.source_id === "string" && this.has(ref.source_id);}
        catch {return false;}
      }
      return false;
    }
    if (Array.isArray(value)) return value.some(v => this.containsDeleted(v));
    return !!value && typeof value === "object" && Object.values(value).some(v => this.containsDeleted(v));
  }
  async cleanTraces(): Promise<void> {
    if (!this.blocked.size) return;
    return this.traces.maintenance(async () => {
      const directory = join(this.directory, "traces");
      for (const file of await readdir(directory).catch((e: NodeJS.ErrnoException) => {if (e.code === "ENOENT") return []; throw e;})) {
        if (!traceFile.test(file)) continue;
        const path = join(directory, file);
        if ((await lstat(path)).isSymbolicLink()) throw new Error("DELETION_TRACE_PATH_INVALID");
        let discard = true;
        try {discard = this.containsDeleted(JSON.parse(await readFile(path, "utf8")));} catch {}
        if (discard) await rm(path, {force: true});
      }
    });
  }
}
