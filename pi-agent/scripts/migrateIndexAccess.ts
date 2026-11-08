import {applyIndexAccessMigration, inspectIndexAccessMigration} from "../src/retrieval/indexMigration.js";

const args = process.argv.slice(2);
const root = args.find(value => !value.startsWith("--"));
if (!root) {
  console.error("Usage: tsx scripts/migrateIndexAccess.ts <data/retrieval> [--apply] [--backup <path>]");
  process.exit(2);
}
const apply = args.includes("--apply");
const backupIndex = args.indexOf("--backup");
const backup = backupIndex >= 0 ? args[backupIndex + 1] : undefined;
if (backupIndex >= 0 && !backup) {
  console.error("--backup requires a path");
  process.exit(2);
}
try {
  const result = apply ? await applyIndexAccessMigration(root, backup) : await inspectIndexAccessMigration(root);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
