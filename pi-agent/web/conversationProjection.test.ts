import test from "node:test";
import assert from "node:assert/strict";
import { preserveConversationAttachments } from "./src/conversationProjection.js";

interface Message { role: string; content: string; entryId?: string; attachments?: { name: string }[]; }
test("saved speech projection keeps pending image-only replies and assigns the actual Pi ID", () => {
  const displayed: Message[] = [{ role: "user", content: "", attachments: [{ name: "练习.png" }] }, { role: "assistant", content: "正在生成" }];
  const saved: Message[] = [{ role: "user", content: "", entryId: "user-real" }, { role: "assistant", content: "", entryId: "speech-tool" }, { role: "assistant", content: "请描述图片", entryId: "teacher-real" }];
  const projected = preserveConversationAttachments(saved, displayed);
  assert.deepEqual(projected[0], { ...saved[0], attachments: displayed[0]!.attachments });
  assert.deepEqual(projected.slice(1), saved.slice(1)); assert.equal(saved[0]!.attachments, undefined);
});
test("same-text users retain only their own attachments and old IDs cannot leak into another branch", () => {
  const displayed: Message[] = [{ role: "user", content: "相同", entryId: "first", attachments: [{ name: "旧.png" }] }, { role: "user", content: "相同", attachments: [{ name: "新.png" }] }];
  const saved: Message[] = [{ role: "user", content: "相同", entryId: "first" }, { role: "user", content: "相同", entryId: "second" }];
  assert.deepEqual(preserveConversationAttachments(saved, displayed).map(message => message.attachments?.[0]?.name), ["旧.png", "新.png"]);
  assert.equal(preserveConversationAttachments([{ role: "user", content: "相同", entryId: "other-branch" }], displayed)[0]!.attachments, undefined);
});
