import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, rm, readFile, writeFile, mkdir, rename, utimes} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {IndexAccess} from "./retrieval/indexAccess.js";
import {MaterialDeletionCache} from "./retrieval/materialDeletion.js";
import type {SourceBackend} from "./retrieval/types.js";
import type {IndexRow} from "./retrieval/types.js";
import {LocalRetrievalIndex} from "./retrieval/store.js";

test("index maintenance waits for a different process reader and rejects newly arriving native accesses", {timeout: 15_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-index-access-")), path = join(directory, "lance");
  const url = new URL("./retrieval/indexAccess.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {IndexAccess} from ${JSON.stringify(url)};
    await new IndexAccess(${JSON.stringify(path)}).read(async()=>{
      process.send('reading'); await new Promise(done=>process.once('message',done));
    }); process.disconnect();`], {windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]});
  const exited = once(child, "exit");
  const access = new IndexAccess(path, 2000);
  let cleanupStarted = false;
  try {
    assert.equal((await once(child, "message"))[0], "reading");
    await assert.rejects(new IndexAccess(path, 25).maintenance(async () => assert.fail("a live reader cannot be forced out")), /INDEX_MAINTENANCE_PENDING/);
    const cleaning = access.maintenance(async () => {cleanupStarted = true;});
    for (let i = 0; i < 100; i++) {
      try {await readFile(path + ".access/maintenance.lock"); break;} catch {await new Promise(done => setTimeout(done, 10));}
    }
    assert.equal(cleanupStarted, false);
    await assert.rejects(access.read(async () => assert.fail("new readers must not enter during cleanup")), /INDEX_MAINTENANCE_PENDING/);
    child.send("release"); await cleaning;
    assert.equal(cleanupStarted, true);
    await access.read(async () => {});
    await exited;
  } finally {if (child.exitCode === null) child.kill(); await rm(directory, {recursive: true, force: true});}
});

test("deletion ledger is monotonic across restart and unknown versions never reset the source block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-deletion-ledger-"));
  const id = "mat-" + "a".repeat(32), source = "material:" + id;
  const backend = {materialDeletions: async () => ({version: 1, deletions: [{id, source_hash: "b".repeat(64), original_cleanup: "complete"}],
    next_offset: null, catalog_version: "fixture"})} as SourceBackend;
  try {
    const cache = new MaterialDeletionCache(directory, backend, () => {});
    await cache.refresh(); await cache.persist(); assert.ok(cache.has(source));
    const reopened = new MaterialDeletionCache(directory, {} as SourceBackend, () => {});
    await reopened.refresh(); assert.ok(reopened.has(source));
    const path = join(directory, "material-deletions.json");
    const value = JSON.parse(await readFile(path, "utf8")); value.version = 999;
    await writeFile(path, JSON.stringify(value)); const saved = await readFile(path, "utf8");
    await assert.rejects(reopened.refresh(), /DELETION_CACHE_INVALID/);
    assert.ok(reopened.has(source)); assert.equal(await readFile(path, "utf8"), saved);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test("a connection opened before full erasure can add new rows and recreate lexical search without reviving the deleted source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-index-erasure-")), path = join(directory, "lance");
  const primary = new LocalRetrievalIndex(path, 2), parallel = new LocalRetrievalIndex(path, 2);
  const row: IndexRow = {id: "row-old", source_id: "material:mat-" + "a".repeat(32), source_version: "v1", kind: "material",
    name: "old", scope_id: "goal-a", goal_name: "goal-a", skill_id: "", chunk_id: "c1", ordinal: 0, text: "OLD_PRIVATE",
    heading: "", locator_json: "{}", source_ref: "ref-old", lexical_text: "tneedle", embedding_hash: "old", has_vector: true, vector: [1, 0]};
  try {
    await primary.open(); await primary.upsert([row]); await parallel.open();
    assert.equal((await parallel.lexical("tneedle", ["goal-a"])).length, 1);
    await primary.eraseSources([row.source_id]);
    assert.equal((await parallel.lexical("tneedle", ["goal-a"])).length, 0);
    await parallel.upsert([{...row, id: "row-new", source_id: "material:mat-" + "b".repeat(32), text: "NEW_PUBLIC", embedding_hash: "new"}]);
    assert.equal((await primary.lexical("tneedle", ["goal-a"]))[0]?.text, "NEW_PUBLIC");
    assert.equal((await primary.sourceRows(row.source_id)).length, 0);
  } finally {primary.close(); parallel.close(); await rm(directory, {recursive: true, force: true});}
});

test("trace cleanup waits for an unrelated in-flight atomic trace write instead of unlinking its partial JSON", {timeout: 10_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-trace-access-"));
  const id = "mat-" + "a".repeat(32);
  const backend = {materialDeletions: async () => ({version: 1, deletions: [{id, source_hash: "b".repeat(64), original_cleanup: "complete"}],
    next_offset: null, catalog_version: "fixture"})} as SourceBackend;
  const cache = new MaterialDeletionCache(directory, backend, () => {});
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(done => {release = done;}), started = new Promise<void>(done => {began = done;});
  try {
    await cache.refresh(); await mkdir(join(directory, "traces"));
    const final = join(directory, "traces", "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) + ".json");
    const temporary = final + "." + "b".repeat(8) + "-bbbb-bbbb-bbbb-" + "b".repeat(12) + ".tmp";
    const writing = cache.withTrace(async () => {
      await writeFile(temporary, "{"); began(); await gate;
      await writeFile(temporary, JSON.stringify({source_id: "card:kept", snippet: "unrelated trace"}));
      await rename(temporary, final);
    });
    await started; const cleaning = cache.cleanTraces();
    for (let i = 0; i < 100; i++) {
      try {await readFile(join(directory, "traces.access", "maintenance.lock")); break;} catch {await new Promise(done => setTimeout(done, 10));}
    }
    assert.equal(await readFile(temporary, "utf8"), "{", "partial JSON is still owned by its live writer");
    release(); await writing; await cleaning;
    assert.equal(JSON.parse(await readFile(final, "utf8")).snippet, "unrelated trace");
  } finally {release(); await rm(directory, {recursive: true, force: true});}
});

test("an empty read lease of a live process is not reclaimed merely because its timestamp is old", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lawa-empty-read-lease-")), path = join(directory, "lance");
  const access = new IndexAccess(path, 25), leases = path + ".access";
  try {
    await mkdir(leases);
    const lease = join(leases, `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.read`);
    await writeFile(lease, ""); const old = new Date(Date.now() - 60_000); await utimes(lease, old, old);
    await assert.rejects(access.maintenance(async () => assert.fail("a live reader must remain protected before its PID write")), /INDEX_MAINTENANCE_PENDING/);
    assert.equal(await readFile(lease, "utf8"), "");
    await rm(lease); await access.maintenance(async () => {});
  } finally {await rm(directory, {recursive: true, force: true});}
});
