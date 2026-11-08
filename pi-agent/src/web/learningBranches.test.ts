import {createTeachingFaux as createFauxCore} from "../testing/teachingFaux.js";
import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import {TeachingSessionContext} from "../teachingSession.js";
import {LEARNER_QUESTIONS_ENTRY} from "../learnerQuestions.js";
import {ConversationCatalog} from "./conversationCatalog.js";
import {WebSessionStore, type WebSessionEvent, type WebSessionPayload} from "./sessionStore.js";
import {startGrowthPreview} from "../../scripts/growthPreview.js";
import type {RouteBranchCommand} from "../learningBranchTypes.js";

test("route detour keeps the same session, original question, help and main Task through pause/restart/Goal switches", async () => {
  const preview = await startGrowthPreview(0, false);
  let store: WebSessionStore | undefined;
  try {
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(preview.apiBase + path, body === undefined ? undefined : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      const data: any = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const directory = join(preview.directory, "branch-test-sessions"), catalog = new ConversationCatalog(directory);
    const manager = catalog.create(), sessionId = manager.getSessionId();
    catalog.recordGoal(manager, "goal", "TypeScript 基础", true);
    manager.appendMessage(fauxAssistantMessage("主线原讲解：先判断加号两侧的类型。"));
    const context = new TeachingSessionContext(); context.bindSession(sessionId);
    context.learnerQuestions.ask({id: "original-question", purpose: "CHECK", session_id: sessionId, goal_id: "goal", skill_id: "a", task_id: "ta",
      questions: [{id: "original", prompt: "2 + '3' 得到什么？请解释原因。", selection: "freeform", options: []}]});
    manager.appendCustomEntry(LEARNER_QUESTIONS_ENTRY, context.learnerQuestions.snapshot());
    const originalIds = manager.getBranch().map(e => e.id);
    const faux = createFauxCore({tokensPerSecond: 0});
    const runtime = await ModelRuntime.create({authPath: join(preview.directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(preview.directory, "models.json"), allowModelNetwork: false, refreshOnCreate: false});
    runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({auth: {apiKey: "synthetic-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
    const makeStore = () => new WebSessionStore({apiBaseUrl: preview.apiBase, conversationDir: directory, log: () => {},
      createAgent: (ctx, planning, emit, sessionManager, branchProposed) => createLearningAgentSession(ctx, planning, {
        apiBaseUrl: preview.apiBase, model: faux.getModel(), modelRuntime: runtime, sessionManager, surface: "WEB", retrieval: false,
        branchProposed, assistantSupport: false, teachingInstructions: () => "", onEvent: emit, log: () => {}})});
    store = makeStore();
    const initial = await store.create("resume-recent");
    assert.equal(initial.sessionId, sessionId);
    const originalQuestion = initial.state.teaching.learner_questions?.pending;
    assert.equal(originalQuestion?.id, "original-question");
    const proposal = await request("/api/learning/branches/propose", {id: "same-session-detour", goal_id: "goal", anchor_kind: "skill", anchor_id: "a",
      purpose: "prerequisite", title: "补足字符串转换", reason: "原题用到了转换", scope: "解释数字与字符串相加", return_condition: "理解原题的触发条件", expected_plan_revision: 0});
    const command = async (action: RouteBranchCommand["action"]): Promise<RouteBranchCommand> => {
      const state = await store!.state(sessionId), task = state.overview.active_task as {id: string; activity_revision: number} | null;
      const b = state.overview.learning_paths!.branches.find(b => b.id === proposal.id)!;
      return {sessionId, branchId: b.id, action, operationId: crypto.randomUUID(), expectedRevision: b.revision,
        goalId: "goal", taskId: task?.id ?? null, taskRevision: task?.activity_revision ?? 0};
    };
    const entry = await command("enter"), entered = await store.transitionRouteBranch(entry);
    assert.equal(entered.sessionId, sessionId);
    assert.deepEqual(entered.messages, [], "entering a fresh route shows only its own conversation, not the main lesson");
    assert.equal(entered.state.teaching.learner_questions?.pending, null);
    const branchTask = (entered.state.overview.active_task as {id: string}).id;
    assert.equal((await request("/api/learning/tasks/ta")).status, "PAUSED");
    assert.equal((await store.transitionRouteBranch(entry)).sessionId, sessionId);
    const branchSkill = entered.state.overview.learning_paths!.branches[0]!.exclusive_skill_ids[0]!;
    const beforeEmptyPreview = (await catalog.open(sessionId)).getLeafId();
    const emptyPreview = await store.locateSkill("goal", branchSkill);
    assert.equal(emptyPreview.sessionId, sessionId);
    assert.ok(emptyPreview.previewEntryId, "a path with no teaching yet is still a valid read-only location");
    assert.deepEqual(emptyPreview.messages, [], "do not pass off the main lesson as branch records");
    assert.equal((await catalog.open(sessionId)).getLeafId(), beforeEmptyPreview, "browsing does not move the live Pi leaf");
    let teacherInput = "";
    faux.setResponses([input => {
      teacherInput = JSON.stringify(input.messages);
      return fauxAssistantMessage("这里需要先把数字转换为字符串，再进行拼接。");
    }]);
    const events: WebSessionEvent[] = [];
    await store.sendMessage(sessionId, "请解释一下字符串转换。", event => events.push(event));
    assert.match(teacherInput, /主线原讲解/, "teacher context still includes the main lesson while teaching a detour");
    const update = events.findLast(e => e.type === "conversation_update");
    assert.ok(update?.type === "conversation_update");
    assert.ok(update.messages.some(m => m.content.includes("数字转换为字符串")));
    assert.ok(update.messages.every(m => !m.content.includes("主线原讲解")), "stream final projection stays inside the branch");
    const shared = await store.sharedClassroom() as {session: WebSessionPayload};
    assert.deepEqual(shared.session.messages, update.messages, "reconnection uses the same scoped projection");
    const secondGoal = (await request("/api/learning/library")).projects.find((p: any) => p.goal_profile.id !== "goal").goal_profile.id;
    await store.activateGoal(secondGoal);
    assert.equal((await store.activateGoal("goal")).sessionId, sessionId);
    store.dispose(); store = makeStore();
    const restarted = await store.create("resume-recent");
    assert.equal(restarted.sessionId, sessionId);
    assert.equal((restarted.state.overview.active_task as {id: string}).id, branchTask);
    assert.deepEqual(restarted.messages, update.messages, "restart and Goal switches preserve the branch transcript");
    const returned = await store.transitionRouteBranch(await command("return"));
    assert.equal(returned.sessionId, sessionId);
    assert.ok(returned.messages.some(m => m.content.includes("主线原讲解")));
    assert.ok(returned.messages.every(m => !m.content.includes("数字转换为字符串")), "main conversation does not include detour teaching");
    assert.deepEqual(returned.state.teaching.learner_questions?.pending, originalQuestion);
    assert.equal((returned.state.overview.active_task as {id: string}).id, "ta");
    assert.ok(returned.state.overview.learning_paths!.branches[0]!.assistance_provided);
    assert.match(returned.state.overview.learning_paths!.branches[0]!.handoff, /数字转换为字符串/);
    const final = await catalog.open(sessionId);
    assert.ok(originalIds.every(id => final.getBranch().some(e => e.id === id)), "same Pi ancestor chain remains intact");
    assert.equal(final.getEntries().filter(e => e.type === "custom" && e.customType === "lawa.review-branch").length, 0);
    const again = await store.transitionRouteBranch(await command("enter"));
    assert.deepEqual(again.messages, update.messages, "reentry resumes the same branch messages");
    assert.equal((again.state.overview.active_task as {id: string}).id, branchTask);
    const complete = await store.transitionRouteBranch(await command("complete"));
    assert.equal(complete.state.overview.learning_paths!.branches[0]!.status, "COMPLETED");
    assert.equal((complete.state.overview.active_task as {id: string}).id, "ta");
    const completedPreview = await store.locateSkill("goal", branchSkill);
    assert.equal(completedPreview.sessionId, sessionId);
    assert.ok(completedPreview.messages.some(m => m.content.includes("数字转换为字符串")));
    assert.ok(completedPreview.messages.every(m => !m.content.includes("主线原讲解")));
    const source = completedPreview.messages.find(m => m.content.includes("数字转换为字符串"))!;
    const note = await store.noteSourceContext({sessionId, messageId: source.entryId!, channel: "teacher"});
    assert.ok(note.messages.some(m => m.id === source.entryId), "branch notes still locate their original message from the main classroom");
    assert.equal((await store.state(sessionId)).teaching.learner_questions?.pending?.id, originalQuestion!.id);
    assert.equal(((await store.state(sessionId)).overview.active_task as {id: string}).id, "ta", "reading completed branch leaves main Task active");
    await assert.rejects(store.transitionRouteBranch(entry), /stale|changed|变化|reload/i);
    faux.setResponses([
      input => {
        teacherInput = JSON.stringify(input.messages);
        return fauxAssistantMessage(fauxToolCall("propose_learning_branch", {anchor_kind: "skill", anchor_id: "a", purpose: "prerequisite",
        title: "比较规则", reason: "理解原题", scope: "比较运算先发生什么", return_condition: "能解释规则"}), {stopReason: "toolUse"});
      },
      () => fauxAssistantMessage("我们先把比较规则补一下。"),
    ]);
    const directEvents: WebSessionEvent[] = [];
    await store.sendMessage(sessionId, "先补一下比较规则。", event => directEvents.push(event));
    assert.match(teacherInput, /主线原讲解/);
    assert.match(teacherInput, /数字转换为字符串/, "teacher retains previous branch help after returning to the main line");
    const switching = directEvents.find(e => e.type === "conversation_update" && e.routeChanged);
    assert.ok(switching?.type === "conversation_update");
    assert.ok(switching.messages.some(m => m.content === "先补一下比较规则。"));
    assert.ok(switching.messages.every(m => !m.content.includes("主线原讲解") && !m.content.includes("数字转换为字符串")));
    const directFinal = directEvents.findLast(e => e.type === "conversation_update");
    assert.ok(directFinal?.type === "conversation_update");
    assert.ok(directFinal.messages.some(m => m.content === "我们先把比较规则补一下。"));
    const direct = await store.state(sessionId);
    assert.ok(direct.overview.learning_paths!.active_branch_id, "explicit one-turn user intent enters without another confirmation");
    assert.equal((await store.create("resume-recent")).sessionId, sessionId);
    assert.equal((await request("/api/learning/tasks/ta")).status, "PAUSED");
  } finally {store?.dispose(); await preview.stop();}
});
