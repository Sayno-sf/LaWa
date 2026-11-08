import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIsolatedResourceLoader } from "./isolatedResourceLoader.js";
import { teachingContextExtension } from "./teachingContextLifecycle.js";

test("learning runtimes ignore host project prompts and discoverable resources", async t => {
  const root = await mkdtemp(join(tmpdir(), "lawa-isolated-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "PROJECT_DEVELOPMENT_INSTRUCTIONS", "utf8");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "HOST_APPENDED_INSTRUCTIONS", "utf8");

  const loader = createIsolatedResourceLoader({
    cwd,
    agentDir,
    systemPrompt: () => "LEARNING_RUNTIME_PROMPT",
    extensionFactories: [teachingContextExtension],
  });
  await loader.reload();

  assert.equal(loader.getSystemPrompt(), "LEARNING_RUNTIME_PROMPT");
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getPrompts().prompts, []);
  assert.deepEqual(loader.getThemes().themes, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.match(loader.getExtensions().extensions[0]?.path ?? "", /^<inline:/);
});
