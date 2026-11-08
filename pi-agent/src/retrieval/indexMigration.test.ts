import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {applyIndexAccessMigration, inspectIndexAccessMigration} from "./indexMigration.js";

const generation = (value: number) => value.toString(16).padStart(24, "0");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lawa-index-migration-"));
  const first = generation(1), second = generation(2);
  await mkdir(join(root, first), {recursive: true});
  await mkdir(join(root, second), {recursive: true});
  await writeFile(join(root, first, "manifest.json"), JSON.stringify({config: {dimensions: 8}, jobs: {}}));
  await writeFile(join(root, second, "manifest.json"), JSON.stringify({config: {dimensions: 8}, jobs: {}, index_access: 1}));
  await writeFile(join(root, "active.json"), JSON.stringify({generation: first}));
  return {root, first, second};
}

test("dry-run finds only legacy generations and does not mutate the index", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.root, f.first, "manifest.json"), "utf8");
    const result = await inspectIndexAccessMigration(f.root);
    assert.equal(result.pending, 1);
    assert.deepEqual(result.entries.map(value => [value.generation, value.state]), [
      [f.first, "PENDING"], [f.second, "MIGRATED"],
    ]);
    assert.equal(await readFile(join(f.root, f.first, "manifest.json"), "utf8"), before);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("apply creates a byte-verified backup and migrates every legacy manifest idempotently", async () => {
  const f = await fixture();
  const backup = join(f.root + "-backup");
  try {
    const result = await applyIndexAccessMigration(f.root, backup);
    assert.equal(result.applied, true);
    assert.equal(result.pending, 0);
    assert.equal(result.backupTreeSha256, result.originalTreeSha256);
    const migrated = JSON.parse(await readFile(join(f.root, f.first, "manifest.json"), "utf8"));
    assert.equal(migrated.index_access, 1);
    const original = JSON.parse(await readFile(join(backup, f.first, "manifest.json"), "utf8"));
    assert.equal(original.index_access, undefined);
    const rerun = await applyIndexAccessMigration(f.root);
    assert.equal(rerun.applied, false);
    assert.equal(rerun.pending, 0);
  } finally {
    await rm(f.root, {recursive: true, force: true});
    await rm(backup, {recursive: true, force: true});
  }
});

test("a live writer blocks migration before any change", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "writer.lock"), String(process.pid));
    const before = await readFile(join(f.root, f.first, "manifest.json"), "utf8");
    await assert.rejects(applyIndexAccessMigration(f.root), /RETRIEVAL_WRITER_RUNNING/);
    assert.equal(await readFile(join(f.root, f.first, "manifest.json"), "utf8"), before);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("unknown protocol and damaged manifests fail closed", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, f.first, "manifest.json"), JSON.stringify({config: {dimensions: 8}, index_access: 2}));
    await assert.rejects(inspectIndexAccessMigration(f.root), /INDEX_MIGRATION_PROTOCOL_UNKNOWN/);
    await writeFile(join(f.root, f.first, "manifest.json"), "{");
    await assert.rejects(inspectIndexAccessMigration(f.root), SyntaxError);
  } finally {await rm(f.root, {recursive: true, force: true});}
});
