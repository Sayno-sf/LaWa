import assert from "node:assert/strict";
import test from "node:test";
import {SessionManager} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {routeMessageIds, routeBranchRecord, branchHandoff, ROUTE_TRANSITION} from "./routePathState.js";

test("route projection partitions repeated visits and all message components without rewriting Pi history", () => {
  const manager = SessionManager.inMemory();
  const intro = manager.appendMessage(fauxAssistantMessage("建目标之前的讨论"));
  manager.appendCustomEntry("lawa.goal-observation", {goalId: "g"});
  const main = manager.appendMessage(fauxAssistantMessage("主线原题"));
  const transition = (branchId: string, action: string) => manager.appendCustomEntry(ROUTE_TRANSITION,
    {branchId, action, path: `g:${action === "enter" ? branchId : "main"}`});
  transition("a", "enter");
  const first = manager.appendMessage({role: "user", content: "分支 A 的问题", timestamp: Date.now()});
  const components = ["present_speech", "present_teaching_animation", "present_explainer_animation", "record_answer_assessment"].map(toolName =>
    manager.appendMessage({role: "toolResult", toolName, toolCallId: toolName, content: [{type: "text", text: toolName}], isError: false, timestamp: Date.now()}));
  transition("a", "return");
  const continued = manager.appendMessage(fauxAssistantMessage("回到主线"));
  transition("b", "enter");
  const other = manager.appendMessage(fauxAssistantMessage("分支 B"));
  transition("b", "return");
  transition("a", "enter");
  const second = manager.appendMessage(fauxAssistantMessage("继续分支 A"));
  transition("a", "complete");
  const before = JSON.stringify(manager.getEntries()), leaf = manager.getLeafId();
  assert.deepEqual([...routeMessageIds(manager, "g:main")], [intro, main, continued]);
  assert.deepEqual([...routeMessageIds(manager, "g:a")], [first, ...components, second]);
  assert.deepEqual([...routeMessageIds(manager, "g:b")], [other]);
  assert.deepEqual(routeBranchRecord(manager, "g", "a")?.messageIds, [first, ...components, second]);
  assert.equal(JSON.stringify(manager.getEntries()), before);
  assert.equal(manager.getLeafId(), leaf);
});

test("old Pi forks, Goal changes and automatic entry never leak unrelated route messages", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("lawa.goal-observation", {goalId: "g"});
  const main = manager.appendMessage(fauxAssistantMessage("原讲解"));
  const user = manager.appendMessage({role: "user", content: "先补一下", timestamp: Date.now()});
  manager.appendCustomEntry(ROUTE_TRANSITION, {branchId: "a", action: "enter", path: "g:a", startEntryId: user});
  const reply = manager.appendMessage(fauxAssistantMessage("补足讲解"));
  manager.appendCustomEntry("lawa.goal-observation", {goalId: "g"});
  assert.deepEqual([...routeMessageIds(manager, "g:a")], [user, reply], "same-Goal observation preserves the active route");
  assert.deepEqual([...routeMessageIds(manager, "g:main")], [main]);
  assert.match(branchHandoff(manager, "a").handoff, /先补一下/);
  assert.doesNotMatch(branchHandoff(manager, "a").handoff, /原讲解/);
  manager.branch(user);
  const sibling = manager.appendMessage(fauxAssistantMessage("旧 Pi 复习的其他祖先链"));
  assert.deepEqual([...routeMessageIds(manager, "g:main")], [main, user, sibling], "off-chain enter marker cannot claim a shared ancestor");
  assert.deepEqual([...routeMessageIds(manager, "g:a")], []);
  assert.deepEqual(routeBranchRecord(manager, "g", "a")?.messageIds, [user, reply], "history can still locate the recorded route without moving leaf");
  manager.appendCustomEntry("lawa.goal-observation", {goalId: "another"});
  manager.appendCustomEntry(ROUTE_TRANSITION, {branchId: "a", action: "enter", path: "another:a"});
  const another = manager.appendMessage(fauxAssistantMessage("另一个目标同名旁支"));
  assert.deepEqual([...routeMessageIds(manager, "g:a")], []);
  assert.deepEqual([...routeMessageIds(manager, "another:a")], [another]);
});
