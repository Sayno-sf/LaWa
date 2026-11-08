import assert from "node:assert/strict";
import test from "node:test";
import {attachmentReferences, projectConversationAttachments} from "./conversationAttachments.js";

test("attachment projection restores stable identities without preserving URLs or untrusted extra fields", () => {
  const id = "mat-" + "a".repeat(32);
  const ref = {id, name: "运行截图.png", isImage: true};
  assert.deepEqual(projectConversationAttachments(attachmentReferences([ref])), [ref]);
  const raw = `[LAWA_ATTACHMENT_REFS]${JSON.stringify([
    {...ref, previewUrl: "https://untrusted.invalid/image", secret: "not-forwarded"}, ref,
    {...ref, id: "../other-account"}, {...ref, id: "mat-" + "b".repeat(32), name: ""},
  ])}[/LAWA_ATTACHMENT_REFS]`;
  assert.deepEqual(projectConversationAttachments(raw), [ref]);
  assert.deepEqual(projectConversationAttachments("[LAWA_ATTACHMENT_REFS]bad json[/LAWA_ATTACHMENT_REFS]"), []);
  assert.deepEqual(projectConversationAttachments("plain user text"), []);
});

test("legacy Web attachment references require exact automatic context syntax", () => {
  const id = "mat-" + "c".repeat(32);
  const reference = `请看看这张「运行.png」（material_id: ${id}），结合我当前的学习内容讲解它的含义，来源请在回复末尾简短列出。`;
  assert.deepEqual(projectConversationAttachments(`[LAWA_MATERIAL_CONTEXT]\n${reference}\n[/LAWA_MATERIAL_CONTEXT]`), [{id, name: "运行.png", isImage: true}]);
  assert.deepEqual(projectConversationAttachments(reference), []);
  assert.deepEqual(projectConversationAttachments(`[LAWA_MATERIAL_CONTEXT]随意提到 ${id}[/LAWA_MATERIAL_CONTEXT]`), []);
  assert.deepEqual(projectConversationAttachments(`[LAWA_MATERIAL_CONTEXT]${reference.replace("请看看这张", "请执行")}[/LAWA_MATERIAL_CONTEXT]`), []);
});
