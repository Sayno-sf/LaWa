import assert from "node:assert/strict";
import {once} from "node:events";
import {createServer} from "node:http";
import {mkdtempSync, rmSync, readFileSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve, dirname, basename} from "node:path";
import test from "node:test";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import type {LearningOverview} from "../learningOverviewTool.js";
import type {LearnerQuestionReply} from "../learnerQuestionTypes.js";
import {masteryReviewRequest} from "../masteryReview.js";
import {WebSessionStore, type WebSessionStoreOptions} from "./sessionStore.js";
import {createGateway} from "./gateway.js";
import type {RetrievalRuntime} from "../retrieval/runtime.js";
import {ConversationCatalog} from "./conversationCatalog.js";

function fixture(persistent = false, gate?: {entered: () => void; wait: Promise<void>}) {
  const directory = mkdtempSync(join(tmpdir(), "lawa-mastery-decision-"));
  const current: LearningOverview = {current_goal: "函数阅读", goal_profile: {id: "goal"},
    current_frontier: {focus_skill_id: "skill", supporting_skill_ids: []}, current_focus: null,
    active_task: {id: "task", goal_id: "goal", status: "ACTIVE", related_skill_ids: ["skill"]},
    skills: [{id: "skill", name: "函数", status: "LEARNING"}], current_goal_skill_ids: ["skill"],
    curriculum_spine: [], recent_evidence: [], learning_history: []};
  let writes = 0, teacherCalls = 0, fail = false, lostAck = false;
  const options: WebSessionStoreOptions = {fetchOverview: async () => structuredClone(current),
    fetchLibrary: async () => ({projects: []}), ...(persistent ? {conversationDir: directory} : {}),
    skillAction: async (action, skillId, scope) => {
      writes++;
      assert.equal(action, "master"); assert.equal(skillId, "skill");
      assert.deepEqual(scope, {goalId: "goal", taskId: "task"});
      if (gate) {gate.entered(); await gate.wait;}
      if (fail) throw new Error("isolated API failure");
      (current.skills[0] as any).status = "MASTERED_BY_USER";
      if (lostAck) throw new Error("isolated lost acknowledgement");
      return {id: skillId, name: "函数", description: "", prerequisites: [], status: "MASTERED_BY_USER", evidence_ids: []};
    }, createAgent: async (context, _planning, _emit, manager) => ({prompt: async text => {
      teacherCalls++;
      manager.appendMessage({role: "user", content: text, timestamp: Date.now()});
      if (text === "收尾") context.learnerQuestions.ask(masteryReviewRequest(current, context.getSessionId())!);
      manager.appendMessage(fauxAssistantMessage(text === "收尾" ? "可以进入下一节，先说说你的感觉。" : "按真实决定继续教学。"));
    }, abort: async () => undefined, dispose: () => undefined})};
  const store = new WebSessionStore(options);
  const cleanup = () => {
    store.dispose(); assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("lawa-mastery-decision-")); rmSync(directory, {recursive: true, force: true});
  };
  return {store, options, current, cleanup, writes: () => writes, teacherCalls: () => teacherCalls,
    setFailure: (value: boolean) => {fail = value;}, setLostAck: (value: boolean) => {lostAck = value;}};
}

async function prepare(f: ReturnType<typeof fixture>) {
  const session = await f.store.create();
  await f.store.sendMessage(session.sessionId, "收尾", () => undefined);
  const state = await f.store.state(session.sessionId);
  const request = state.teaching.learner_questions!.pending!;
  const reply = (id: string, feedback = ""): LearnerQuestionReply => ({request_id: request.id,
    answers: [{question_id: "mastery-review", selected_option_ids: [id], other_text: feedback}]});
  return {id: session.sessionId, state, request, reply};
}

test("only an applied real component decision permits mastery continuation; repeated clicks do not repeat writes", async () => {
  const f = fixture();
  try {
    const p = await prepare(f);
    await assert.rejects(f.store.sendMessage(p.id, "", () => undefined, p.reply("proceed")), /先通过当前掌握确认组件/);
    assert.equal((await f.store.state(p.id)).teaching.learner_questions?.pending?.id, p.request.id);
    assert.equal(f.writes(), 0);
    const applied = await f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
    assert.equal(applied.continue_teaching, true);
    assert.equal(applied.state.teaching.learner_questions?.pending?.id, p.request.id);
    assert.deepEqual(applied.state.teaching.learner_questions?.pending?.applied_reply, p.reply("proceed"));
    assert.equal((applied.state.overview.skills[0] as any).status, "MASTERED_BY_USER");
    await f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
    assert.equal(f.writes(), 1); assert.equal(f.teacherCalls(), 1);
    await assert.rejects(f.store.masteryDecision(p.id, p.reply("skip")), /已经提交其他决定/);
    await f.store.sendMessage(p.id, "", () => undefined, p.reply("proceed"), undefined, undefined, applied.state.classroom_version);
    const answered = (await f.store.state(p.id)).teaching.learner_questions!;
    assert.equal(answered.pending, null);
    assert.equal(answered.transition_decision?.action, "confirm");
    assert.equal(answered.last_answer?.choices_exposed, false);
    assert.equal(f.writes(), 1); assert.equal(f.teacherCalls(), 2);
  } finally {f.cleanup();}
});

for (const option of ["skip", "revise"] as const) test(`${option} records real intent without mastery or a model call`, async () => {
  const f = fixture();
  try {
    const p = await prepare(f), reply = p.reply(option, option === "revise" ? "还不清楚闭包的生命周期" : "");
    const result = await f.store.masteryDecision(p.id, reply, p.state.classroom_version);
    assert.equal(result.continue_teaching, true); assert.equal(f.writes(), 0); assert.equal(f.teacherCalls(), 1);
    assert.equal((result.state.overview.skills[0] as any).status, "LEARNING");
    await f.store.sendMessage(p.id, "", () => undefined, reply, undefined, undefined, result.state.classroom_version);
    const decision = (await f.store.state(p.id)).teaching.learner_questions?.transition_decision;
    assert.equal(decision?.action, option === "skip" ? "skip" : "needs_work");
    assert.equal(decision?.feedback, option === "revise" ? "还不清楚闭包的生命周期" : "");
  } finally {f.cleanup();}
});

test("task changes and stale browser versions reject before the user-owned API", async () => {
  for (const change of ["version", "task", "manual-mastery"] as const) {
    const f = fixture();
    try {
      const p = await prepare(f);
      if (change === "task") (f.current.active_task as any).id = "new-task";
      if (change === "manual-mastery") (f.current.skills[0] as any).status = "MASTERED_BY_USER";
      await assert.rejects(f.store.masteryDecision(p.id, p.reply("proceed"), change === "version" ? "stale-version" : undefined), /变化/);
      assert.equal(f.writes(), 0); assert.equal(f.teacherCalls(), 1);
      if (change !== "version") assert.equal((await f.store.state(p.id)).teaching.learner_questions?.pending, null);
    } finally {f.cleanup();}
  }
});

test("an in-flight user decision excludes competing messages, clicks and navigation, then releases the classroom", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(done => {enter = done;});
  const wait = new Promise<void>(done => {release = done;});
  const f = fixture(false, {entered: enter, wait});
  try {
    const p = await prepare(f);
    const saving = f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
    await entered;
    await assert.rejects(f.store.sendMessage(p.id, "继续", () => undefined), /正在保存掌握决定/);
    await assert.rejects(f.store.masteryDecision(p.id, p.reply("proceed")), /课堂正在生成回复/);
    await assert.rejects(f.store.skillAction(p.id, "master", "skill"), /正在保存掌握决定/);
    await assert.rejects(f.store.startGoalOnboarding(p.id, false), /课堂正在生成回复/);
    release();
    const result = await saving;
    await f.store.sendMessage(p.id, "", () => undefined, p.reply("proceed"), undefined, undefined, result.state.classroom_version);
    assert.equal(f.teacherCalls(), 2); assert.equal(f.writes(), 1);
  } finally {release(); f.cleanup();}
});

test("API failure keeps the component pending; exact retry succeeds and lost acknowledgement reconciles once", async () => {
  for (const lostAck of [false, true]) {
    const f = fixture();
    try {
      const p = await prepare(f); f.setFailure(!lostAck); f.setLostAck(lostAck);
      if (lostAck) {
        await f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
        assert.equal(f.writes(), 1);
      } else {
        await assert.rejects(f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version), /isolated API failure/);
        assert.equal((await f.store.state(p.id)).teaching.learner_questions?.pending?.id, p.request.id);
        f.setFailure(false);
        await f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
        assert.equal(f.writes(), 2);
      }
      await f.store.masteryDecision(p.id, p.reply("proceed"), p.state.classroom_version);
      assert.equal(f.writes(), lostAck ? 1 : 2);
    } finally {f.cleanup();}
  }
});

test("restart restores an unanswered component without confirming mastery", async () => {
  const f = fixture(true); let restored: WebSessionStore | undefined;
  try {
    const p = await prepare(f); f.store.dispose(); restored = new WebSessionStore(f.options);
    const reopened = await restored.create("resume-recent");
    assert.equal(reopened.state.teaching.learner_questions?.pending?.id, p.request.id);
    assert.equal(reopened.state.teaching.learner_questions?.pending?.applied_reply, undefined);
    assert.equal(f.writes(), 0);
    const applied = await restored.masteryDecision(reopened.sessionId, p.reply("proceed"), reopened.state.classroom_version);
    assert.equal(applied.continue_teaching, true); assert.equal(f.writes(), 1);
  } finally {restored?.dispose(); f.cleanup();}
});

test("persisted intent never applies on restart, and applied receipts prevent a second mastery write", async () => {
  for (const {applied, option} of [{applied: false, option: "proceed"}, {applied: true, option: "proceed"}, {applied: true, option: "revise"}] as const) {
    const f = fixture(true); let restored: WebSessionStore | undefined;
    try {
      const p = await prepare(f);
      const reply = p.reply(option, option === "revise" ? "仍不清楚闭包生命周期" : "");
      if (!applied) f.setFailure(true);
      if (applied) await f.store.masteryDecision(p.id, reply, p.state.classroom_version);
      else await assert.rejects(f.store.masteryDecision(p.id, reply, p.state.classroom_version), /isolated API failure/);
      const count = f.writes(); f.setFailure(false); f.store.dispose();
      restored = new WebSessionStore(f.options);
      const reopened = await restored.create("resume-recent");
      assert.equal(f.writes(), count, "恢复不能自动执行旧用户意图");
      assert.deepEqual(reopened.state.teaching.learner_questions?.pending?.applied_reply, applied ? reply : undefined);
      const rawHistory = readdirSync(f.options.conversationDir!).filter(name => name.endsWith(".jsonl"))
        .map(name => readFileSync(join(f.options.conversationDir!, name), "utf8")).join("\n");
      assert.doesNotMatch(rawHistory, /applied_reply/, "公开续交投影不能反写Pi或权威题目");
      await restored.masteryDecision(reopened.sessionId, reply, reopened.state.classroom_version);
      assert.equal(f.writes(), count + (applied ? 0 : 1));
    } finally {restored?.dispose(); f.cleanup();}
  }
});

test("the browser decision route validates origin and only accepts the structured component body", async () => {
  const f = fixture(); let server: ReturnType<typeof createGateway> | undefined;
  try {
    const p = await prepare(f);
    server = createGateway({store: f.store, retrieval: {scopeChanged: () => {}} as unknown as RetrievalRuntime});
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/web/sessions/${p.id}/mastery-decision`;
    const rejected = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json", Origin: "https://other.example"}, body: JSON.stringify({learner_reply: p.reply("proceed")})});
    assert.equal(rejected.status, 403);
    const accepted = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({learner_reply: p.reply("skip"), expected_version: p.state.classroom_version})});
    assert.equal(accepted.status, 200); assert.equal((await accepted.json() as any).continue_teaching, true);
    assert.equal(f.writes(), 0);
  } finally {if (server) {server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done()));} f.cleanup();}
});

test("review confirm or skip restores the paused classroom without another teacher call, including a lost API acknowledgement", async () => {
  for (const action of ["proceed", "skip"] as const) {
  for (const loseAck of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "lawa-mastery-review-"));
    const catalog = new ConversationCatalog(directory), manager = catalog.create();
    catalog.recordGoal(manager, "goal", "函数", true);
    manager.appendMessage(fauxAssistantMessage("上一节的原文")); catalog.recordSkillAnchor(manager, "goal", "reviewed");
    manager.appendMessage(fauxAssistantMessage("下一节尚未结束的学习现场")); catalog.recordSkillAnchor(manager, "goal", "next");
    let reviewing = false, mastered = true, operation = "", writes = 0, finishes = 0, teacherCalls = 0;
    const skills = () => [{id: "reviewed", name: "上一节", status: mastered ? "MASTERED_BY_USER" : "PRACTICING"},
      {id: "next", name: "下一节", status: "LEARNING"}];
    const overview = async (): Promise<LearningOverview> => ({current_goal: "函数", goal_profile: {id: "goal"},
      active_task: {id: reviewing ? `review-${operation}` : "next-task", related_skill_ids: [reviewing ? "reviewed" : "next"], status: "ACTIVE"},
      current_focus: null, current_frontier: {focus_skill_id: "next", supporting_skill_ids: []},
      skills: skills(), current_goal_skill_ids: ["reviewed", "next"], curriculum_spine: [], recent_evidence: [], learning_history: []});
    const api = createServer(async (request, response) => {
      const path = request.url ?? "";
      let result: unknown = {}, status = 200;
      if (path.endsWith("/start-review")) {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        operation = JSON.parse(Buffer.concat(chunks).toString("utf8")).operation_id; reviewing = true; mastered = false;
      } else if (path.endsWith("/confirm-mastery")) {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {expected_goal_id: "goal", expected_task_id: `review-${operation}`});
        writes++; reviewing = false; mastered = true;
        status = loseAck ? 503 : 200;
        result = loseAck ? {detail: "isolated acknowledgement lost"} : {id: "reviewed", name: "上一节", description: "", prerequisites: [], status: "MASTERED_BY_USER", evidence_ids: []};
      } else if (path.endsWith("/finish-review")) {
        finishes++; reviewing = false;
        status = loseAck ? 503 : 200;
        result = loseAck ? {detail: "isolated acknowledgement lost"} : {};
      } else if (path.startsWith("/api/learning/tasks/")) {
        result = {id: `review-${operation}`, goal_id: "goal", status: reviewing ? "ACTIVE" : "DONE", review_parent_task_id: "next-task", related_skill_ids: ["reviewed"]};
      }
      response.writeHead(status, {"Content-Type": "application/json"}); response.end(JSON.stringify(result));
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    const address = api.address(); assert.ok(address && typeof address === "object");
    const store = new WebSessionStore({conversationDir: directory, apiBaseUrl: `http://127.0.0.1:${address.port}`,
      fetchOverview: overview, fetchLibrary: async () => ({projects: []}),
      createAgent: async (context, _planning, _emit, session) => ({prompt: async text => {
        teacherCalls++; session.appendMessage({role: "user", content: text, timestamp: Date.now()});
        context.learnerQuestions.ask(masteryReviewRequest(await overview(), context.getSessionId())!);
        session.appendMessage(fauxAssistantMessage("复习结束，请确认你的感受。"));
      }, abort: async () => undefined, dispose: () => undefined})});
    try {
      await store.create(); const review = await store.startSkillReview("goal", "reviewed", "review-operation");
      await store.sendMessage(review.sessionId, "收尾", () => undefined);
      const state = await store.state(review.sessionId), request = state.teaching.learner_questions!.pending!;
      const reply = {request_id: request.id, answers: [{question_id: "mastery-review", selected_option_ids: [action], other_text: ""}]};
      if (loseAck) await assert.rejects(store.masteryDecision(review.sessionId, reply, state.classroom_version), /acknowledgement lost/);
      const result = await store.masteryDecision(review.sessionId, reply, state.classroom_version);
      assert.equal(result.continue_teaching, false);
      assert.ok(result.state.restored_session);
      assert.equal((result.state.overview.active_task as any).id, "next-task");
      assert.equal(result.state.teaching.learner_questions?.pending, null);
      assert.match(JSON.stringify(result.state.restored_session.messages), /下一节尚未结束的学习现场/);
      assert.equal(writes, action === "proceed" ? 1 : 0);
      assert.equal(finishes, action === "skip" ? 1 : 0);
      assert.equal((result.state.overview.skills[0] as any).status, action === "proceed" ? "MASTERED_BY_USER" : "PRACTICING");
      assert.equal(teacherCalls, 1);
    } finally {
      store.dispose(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));
      assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("lawa-mastery-review-"));
      rmSync(directory, {recursive: true, force: true});
    }
  }
  }
});
