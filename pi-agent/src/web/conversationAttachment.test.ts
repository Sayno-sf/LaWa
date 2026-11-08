import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {once} from "node:events";
import {createServer} from "node:http";
import test from "node:test";
import {attachmentReferences} from "../conversationAttachments.js";
import {ConversationCatalog} from "./conversationCatalog.js";
import {WebSessionStore} from "./sessionStore.js";
import {createGateway} from "./gateway.js";
import {RetrievalRuntime} from "../retrieval/runtime.js";
import {RetrievalSettingsStore} from "../retrieval/settings.js";
import type {SourceBackend} from "../retrieval/types.js";

test("historical attachment resolves original user branch without changing current leaf or fetching learning state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lawa-attachment-reference-"));
  const oldApi = process.env.LEARNING_API_BASE_URL;
  let api: ReturnType<typeof createServer> | undefined;
  let gateway: ReturnType<typeof createGateway> | undefined;
  const store = new WebSessionStore({conversationDir: dir, fetchOverview: async () => {throw new Error("must not activate or load teaching");}});
  try {
    const catalog = new ConversationCatalog(dir);
    const manager = catalog.create();
    const id = "mat-" + "a".repeat(32);
    catalog.recordGoal(manager, "old-goal", "Old course");
    const entry = manager.appendMessage({role: "user", content: `查看资料\n[LAWA_MATERIAL_CONTEXT]\n${attachmentReferences([{id, name: "原资料.pdf", isImage: false}])}\n[/LAWA_MATERIAL_CONTEXT]`, timestamp: Date.now()});
    catalog.recordGoal(manager, "new-goal", "Current course");
    const other = manager.appendMessage({role: "user", content: "another message", timestamp: Date.now()});
    const leaf = manager.getLeafId();
    const sid = manager.getSessionId();
    const listed = (await catalog.list())[0]!;
    assert.equal(listed.name, "查看资料");
    assert.equal(listed.preview, "查看资料");
    assert.deepEqual(await store.resolveConversationAttachment(sid, entry, id), {reference_session_id: sid, reference_goal_id: "old-goal"});
    assert.equal(manager.getLeafId(), leaf);
    await assert.rejects(store.resolveConversationAttachment(sid, other, id), /不属于/);
    await assert.rejects(store.resolveConversationAttachment("outside-account", entry, id), /不可用/);
    await assert.rejects(store.resolveConversationAttachment(sid, entry, "mat-" + "b".repeat(32)), /不属于/);

    const seen: string[] = [];
    api = createServer((request, response) => {
      seen.push(request.url!);
      response.writeHead(200, {"Content-Type": "application/json"}); response.end(JSON.stringify({id, name: "原资料.pdf"}));
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    process.env.LEARNING_API_BASE_URL = `http://127.0.0.1:${(api.address() as {port: number}).port}`;
    // 本测试只核对历史引用授权；后台资源发现由独立协议测试覆盖，不与此处Kernel调用计数混合。
    const retrieval = new RetrievalRuntime(join(dir, "retrieval"), {} as SourceBackend,
      new RetrievalSettingsStore(join(dir, "retrieval-settings.json"), join(dir, "providers.json"), join(dir, "secrets.json")));
    gateway = createGateway({store, retrieval}); gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
    const base = `http://127.0.0.1:${(gateway.address() as {port: number}).port}`;
    const query = new URLSearchParams({sessionId: sid, entryId: entry, reference_goal_id: "injected-goal", draft_session_id: "injected-draft"});
    assert.equal((await fetch(`${base}/api/web/conversation-attachments/${id}/metadata?${query}`)).status, 200);
    assert.equal(new URL(seen[0]!, "http://kernel").searchParams.get("reference_goal_id"), "old-goal");
    assert.doesNotMatch(seen[0]!, /injected/);
    query.set("entryId", other);
    assert.equal((await fetch(`${base}/api/web/conversation-attachments/${id}/metadata?${query}`)).status, 404);
    assert.equal(seen.length, 1, "invalid reference must not call the Kernel");
  } finally {
    if (oldApi === undefined) delete process.env.LEARNING_API_BASE_URL; else process.env.LEARNING_API_BASE_URL = oldApi;
    store.dispose();
    await Promise.all([gateway, api].filter(Boolean).map(server => new Promise<void>(resolve => server!.close(() => resolve()))));
    rmSync(dir, {recursive: true, force: true});
  }
});
