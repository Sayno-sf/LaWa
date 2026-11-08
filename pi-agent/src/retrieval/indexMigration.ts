import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {cp, lstat, mkdir, readFile, readdir, rename, stat, writeFile} from "node:fs/promises";
import {basename, dirname, join, relative, resolve} from "node:path";
import {IndexAccess} from "./indexAccess.js";

const generation = /^[a-f0-9]{24}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface IndexMigrationEntry {
  generation: string;
  state: "PENDING" | "MIGRATED";
  manifestSha256: string;
}

export interface IndexMigrationInspection {
  root: string;
  activeGeneration: string | null;
  entries: IndexMigrationEntry[];
  pending: number;
}

export interface IndexMigrationResult extends IndexMigrationInspection {
  applied: boolean;
  backup: string | null;
  backupTreeSha256: string | null;
  originalTreeSha256: string;
  migratedTreeSha256: string;
  report: string;
}

async function exists(path: string): Promise<boolean> {
  try {await lstat(path); return true;} catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function treeFiles(root: string): Promise<Array<{path: string; size: number}>> {
  const found: Array<{path: string; size: number}> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("INDEX_MIGRATION_SYMLINK");
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) found.push({path: relative(root, path).replaceAll("\\", "/"), size: info.size});
      else throw new Error("INDEX_MIGRATION_ENTRY_INVALID");
    }
  };
  await walk(root);
  return found;
}

export async function treeSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await treeFiles(root)) {
    hash.update(file.path).update("\0").update(String(file.size)).update("\0");
    for await (const chunk of createReadStream(join(root, file.path))) hash.update(chunk as Buffer);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertWriterStopped(root: string): Promise<void> {
  const path = join(root, "writer.lock");
  if (!await exists(path)) return;
  let age = 0;
  try {age = Date.now() - (await stat(path)).mtimeMs;} catch {}
  let pid = 0;
  try {pid = Number((await readFile(path, "utf8")).trim());} catch {}
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      throw new Error("RETRIEVAL_WRITER_RUNNING");
    } catch (error) {
      if (error instanceof Error && error.message === "RETRIEVAL_WRITER_RUNNING") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("RETRIEVAL_WRITER_STATE_UNKNOWN");
    }
  } else if (age < 30_000) {
    throw new Error("RETRIEVAL_WRITER_STARTING");
  }
  throw new Error("RETRIEVAL_WRITER_LOCK_STALE");
}

export async function inspectIndexAccessMigration(rootValue: string): Promise<IndexMigrationInspection> {
  const root = resolve(rootValue);
  if (!(await exists(root))) throw new Error("INDEX_MIGRATION_ROOT_MISSING");
  if ((await lstat(root)).isSymbolicLink()) throw new Error("INDEX_MIGRATION_SYMLINK");
  let activeGeneration: string | null = null;
  const activePath = join(root, "active.json");
  if (await exists(activePath)) {
    if ((await lstat(activePath)).isSymbolicLink()) throw new Error("INDEX_MIGRATION_SYMLINK");
    const active = JSON.parse(await readFile(activePath, "utf8")) as {generation?: unknown};
    if (typeof active.generation !== "string" || !generation.test(active.generation))
      throw new Error("INDEX_MIGRATION_ACTIVE_INVALID");
    activeGeneration = active.generation;
  }
  const entries: IndexMigrationEntry[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (!generation.test(name)) continue;
    const directory = join(root, name), manifestPath = join(directory, "manifest.json");
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("INDEX_MIGRATION_SYMLINK");
    if (!(await exists(manifestPath))) throw new Error("INDEX_MIGRATION_MANIFEST_MISSING:" + name);
    if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error("INDEX_MIGRATION_SYMLINK");
    const raw = await readFile(manifestPath);
    const manifest = JSON.parse(raw.toString("utf8")) as {index_access?: unknown; config?: unknown};
    if (!manifest || typeof manifest !== "object" || !manifest.config || typeof manifest.config !== "object")
      throw new Error("INDEX_MIGRATION_MANIFEST_INVALID:" + name);
    if (manifest.index_access !== undefined && manifest.index_access !== 1)
      throw new Error("INDEX_MIGRATION_PROTOCOL_UNKNOWN:" + name);
    entries.push({
      generation: name,
      state: manifest.index_access === 1 ? "MIGRATED" : "PENDING",
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    });
  }
  if (activeGeneration && !entries.some(entry => entry.generation === activeGeneration))
    throw new Error("INDEX_MIGRATION_ACTIVE_MISSING");
  return {root, activeGeneration, entries, pending: entries.filter(entry => entry.state === "PENDING").length};
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = path + "." + digest([process.pid, Date.now(), Math.random()]).slice(0, 16) + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2), {mode: 0o600});
  await rename(temporary, path);
}

/**
 * 只能在所有使用该索引目录的 Gateway/CLI/旧客户端停止后执行。
 * 原维护锁只能排除新版访问者；旧进程是否停止必须由运维窗口核验。
 */
export async function applyIndexAccessMigration(rootValue: string, backupValue?: string): Promise<IndexMigrationResult> {
  const root = resolve(rootValue);
  return new IndexAccess(root).maintenance(async () => {
    await assertWriterStopped(root);
    const before = await inspectIndexAccessMigration(root);
    if (before.pending === 0) {
      const stable = await treeSha256(root);
      return {
        ...before,
        applied: false,
        backup: null,
        backupTreeSha256: null,
        originalTreeSha256: stable,
        migratedTreeSha256: stable,
        report: "already-migrated",
      };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = resolve(backupValue ?? join(dirname(root), `${basename(root)}.backup-${stamp}`));
    if (backup === root || backup.startsWith(root + "\\") || backup.startsWith(root + "/"))
      throw new Error("INDEX_MIGRATION_BACKUP_INSIDE_ROOT");
    if (await exists(backup)) throw new Error("INDEX_MIGRATION_BACKUP_EXISTS");
    const originalTreeSha256 = await treeSha256(root);
    await mkdir(dirname(backup), {recursive: true});
    await cp(root, backup, {recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true});
    const backupTreeSha256 = await treeSha256(backup);
    if (backupTreeSha256 !== originalTreeSha256) throw new Error("INDEX_MIGRATION_BACKUP_MISMATCH");

    const migrated: string[] = [];
    for (const entry of before.entries.filter(value => value.state === "PENDING")) {
      const path = join(root, entry.generation, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const now = await readFile(path);
      if (createHash("sha256").update(now).digest("hex") !== entry.manifestSha256)
        throw new Error("INDEX_MIGRATION_MANIFEST_CHANGED:" + entry.generation);
      await atomicJson(path, {...manifest, index_access: 1});
      migrated.push(entry.generation);
    }
    const after = await inspectIndexAccessMigration(root);
    if (after.pending !== 0) throw new Error("INDEX_MIGRATION_INCOMPLETE");
    const migratedTreeSha256 = await treeSha256(root);
    const report = join(root, "migration-index-access-v1.json");
    await atomicJson(report, {
      version: 1,
      migratedAt: new Date().toISOString(),
      root,
      backup,
      originalTreeSha256,
      backupTreeSha256,
      migratedTreeSha256,
      generations: migrated,
    });
    return {
      ...after,
      applied: true,
      backup,
      backupTreeSha256,
      originalTreeSha256,
      migratedTreeSha256,
      report,
    };
  });
}
