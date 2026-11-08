import assert from "node:assert/strict";
import {join} from "node:path";
import test from "node:test";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {createLearningAgentSession} from "../agentSession.js";
import {WebSessionStore} from "./sessionStore.js";
import {startGrowthPreview} from "../../scripts/growthPreview.js";

test("imported continuation uses real Kernel, preserves all skills across restart and requires confirmation before route save", async () => {
  const preview = await startGrowthPreview(0, false);
  let store: WebSessionStore | undefined;
  try {
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(preview.apiBase + path, body === undefined ? undefined : {
        method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      const data: any = await response.json();
      assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const before = await request("/api/learning/library");
    const payload = {schema_version: "lawa.learning-import/v1", source: {platform: "isolated test"}, goals: [{
      ref: "csv", goal_profile: {goal_description: "续学CSV", desired_outcome: "读写表格", background_summary: "先学读取，最近停在写CSV标题行，想从这里继续"},
      skills: [{ref: "read", name: "读CSV", description: "列名和值"}, {ref: "write", name: "写CSV", description: "标题行"}],
      self_reports: [{skill_ref: "read", statement: "我能读取一行，复杂内容还需要帮助"}],
      work_samples: [{ref: "original-code", skill_ref: "write", question: null,
        learner_answer: "writer.writeheader()", assistance_level: "UNKNOWN"}],
    }]};
    const proposed = await request("/api/user/growth/imports/preview", {payload});
    const saved = await request("/api/user/growth/imports/commit", {payload, preview_hash: proposed.preview_hash, selected_refs: ["csv"]});
    const goalId = saved.entries[0].goal_id;
    const faux = createFauxCore({tokensPerSecond: 0});
    const runtime = await ModelRuntime.create({authPath: join(preview.directory, "test-auth.json"), modelsPath: null,
      modelsStorePath: join(preview.directory, "test-models.json"), allowModelNetwork: false, refreshOnCreate: false});
    runtime.streamSimple = faux.streamSimple; runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({auth: {apiKey: "synthetic-only"}, env: {}} as Awaited<ReturnType<ModelRuntime["getAuth"]>>);
    const makeStore = () => new WebSessionStore({apiBaseUrl: preview.apiBase, conversationDir: join(preview.directory, "test-sessions"),
      log: () => {}, createAgent: (context, planning, emit, manager) => createLearningAgentSession(context, planning, {
        apiBaseUrl: preview.apiBase, model: faux.getModel(), modelRuntime: runtime, sessionManager: manager, surface: "WEB",
        retrieval: false, assistantSupport: false, teachingInstructions: () => "", onEvent: emit, log: () => {},
      })});
    store = makeStore();
    const opened = await store.activateGoal(goalId);
    assert.equal(opened.state.onboarding.status, "READY_FOR_CONFIRMATION");
    assert.equal(opened.state.teaching.learner_questions?.pending?.purpose, "CONFIRM_GOAL");
    const sessionId = opened.sessionId;
    const untouched = await request("/api/learning/overview");
    assert.equal(untouched.active_task, null); assert.equal(untouched.curriculum_spine.length, 0);
    const originalSkills = untouched.current_goal_skill_ids;
    assert.equal(originalSkills.length, 2);
    assert.equal(untouched.imported_learning.samples, 1);
    store.dispose(); store = makeStore();
    const resumed = await store.create("resume-recent");
    assert.equal(resumed.sessionId, sessionId);
    assert.equal(resumed.state.teaching.learner_questions?.pending?.purpose, "CONFIRM_GOAL");
    const profile = resumed.state.onboarding.pending_profile!;
    // 从第二项的已有原答接续，验证系统并不强制从导入数组第一项重学。
    const skill = untouched.skills.find((s: any) => s.id === originalSkills[1]);
    const plan = {goal_profile: profile, replace_existing: true,
      curriculum_spine: Array.from({length: 5}, (_, n) => ({id: `csv-stage-${n}`, name: `阶段 ${n}`, description: "循序练习",
        target_depth: "PRACTICAL", skill_ids: n === 0 ? originalSkills : []})),
      frontier_skills: [{id: skill.id, name: skill.name, description: skill.description, prerequisites: [], target_depth: skill.target_depth}],
      frontier: {focus_skill_id: skill.id, supporting_skill_ids: [], reason: "从已有记录继续", target_depth: "PRACTICAL",
        suggested_learning_mode: "EXPLAIN", next_action: "理解表格结构"}};
    const call = (tool: string, args: unknown) => fauxAssistantMessage(fauxToolCall(tool, args as any), {stopReason: "toolUse"});
    faux.setResponses([
      () => call("record_goal_understanding", {outcome: "CONFIRMED"}),
      () => call("get_imported_learning_context", {}),
      context => {const input = JSON.stringify(context.messages); assert.ok(input.includes("我能读取一行")); assert.ok(input.includes(originalSkills[1]));
        assert.ok(input.includes("writer.writeheader()")); assert.ok(input.includes("external_unverified"));
        assert.ok(input.includes("最近停在写CSV标题行"));
        return call("initialize_learning_goal", plan);},
      () => call("create_learning_task", {title: "尚未授权开始", description: "不能自动开始", related_skill_ids: [skill.id], expected_evidence_types: ["EXPLAIN"],
        teaching_activity: {method: "APPLY", purpose: "读写CSV", learner_action: "解释一行", observable_output: "字典说明",
          evaluation_focus: ["列名与值"], observation_limits: "单题不证明掌握"}}),
      context => {assert.ok(JSON.stringify(context).includes("这是带历史记录续学"));
        const result = context.messages.at(-1) as any; assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /真实.*开始|开始.*决定|必须等学习者/);
        return call("ask_learner_questions", {purpose: "START_LEARNING"});},
      () => fauxAssistantMessage("已保存路线，准备好后开始。"),
    ]);
    const events: unknown[] = [];
    const confirmation = resumed.state.teaching.learner_questions!.pending!;
    await store.sendMessage(sessionId, "", event => {events.push(event);}, {request_id: confirmation.id,
      answers: [{question_id: confirmation.questions[0]!.id, selected_option_ids: ["proceed"], other_text: ""}]});
    const completed = await store.state(sessionId);
    assert.equal(completed.onboarding.status, "INITIALIZED", JSON.stringify(events));
    assert.equal(completed.teaching.learner_questions?.pending?.purpose, "START_LEARNING");
    const overview = await request("/api/learning/overview");
    assert.equal(overview.goal_profile.id, goalId);
    assert.deepEqual(overview.current_goal_skill_ids, originalSkills);
    assert.equal(overview.curriculum_spine.length, 5); assert.equal(overview.active_task, null);
    assert.equal(overview.current_frontier.focus_skill_id, originalSkills[1]);
    assert.ok(overview.skills.filter((s: any) => originalSkills.includes(s.id)).every((s: any) => s.status !== "MASTERED_BY_USER"));
    assert.equal(overview.recent_evidence.length, 0);
    assert.equal((await request("/api/learning/library")).projects.length, before.projects.length + 1);
    assert.equal((await request("/api/learning/growth/goals/" + goalId)).records[0].source.platform, "isolated test");
    store.dispose(); store = makeStore();
    const afterRestart = await store.create("resume-recent");
    assert.equal(afterRestart.sessionId, sessionId);
    assert.ok(["IDLE", "INITIALIZED"].includes(afterRestart.state.onboarding.status));
    assert.equal((await request("/api/learning/overview")).goal_profile.id, goalId);
  } finally {store?.dispose(); await preview.stop();}
});
