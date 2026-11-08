import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createGateway } from "./gateway.js";
import type { RetrievalRuntime } from "../retrieval/runtime.js";
import type { WebSessionStore } from "./sessionStore.js";
import type { StudyTimeStore } from "./studyTimeStore.js";

test("the public gateway omits the physical companion and retains browser observation", async () => {
  const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /data-hardware-|LaWa 硬件/);
  assert.match(html, /data-study-toggle/);
  const server = createGateway({
    store: { currentStudyScope: async () => null, dispose() {} } as unknown as WebSessionStore,
    retrieval: { scopeChanged() {} } as unknown as RetrievalRuntime,
    studyTime: { summary: async (scope: unknown) => ({ scope }) } as unknown as StudyTimeStore,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const method of ["GET", "POST"])
      assert.equal((await fetch(base + "/api/web/hardware-companion", { method })).status, 404);
    const observation = await fetch(base + "/api/web/study-time?sessionId=fixture");
    assert.equal(observation.status, 200);
    assert.deepEqual(await observation.json(), { scope: null });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
