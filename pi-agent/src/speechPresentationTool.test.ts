import assert from "node:assert/strict";
import test from "node:test";
import { createPresentSpeechTool } from "./speechPresentationTool.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { validatePlanningToolRoute } from "./planning/planningPolicy.js";
import { readSpeechPresentation, parseVoiceInputMetadata } from "./speechTypes.js";

const overview = { current_goal: "英语表达", goal_profile: { id: "goal-en" }, curriculum_spine: [], current_frontier: null,
  current_focus: null, skills: [{ id: "skill-en" }], recent_evidence: [], active_task: { id: "task-en", status: "ACTIVE", related_skill_ids: ["skill-en"] },
  current_goal_skill_ids: ["skill-en"], learning_history: [] };

test("present_speech presents bounded text with runtime ownership and never creates an answer or Evidence", async () => {
  const context = new TeachingSessionContext(); context.bindSession("original-session");
  const planning = new GoalOnboardingContext(); let reads = 0;
  const tool = createPresentSpeechTool(context, planning, { fetchImpl: async () => { reads++; return Response.json(overview); }, log: () => undefined });
  const before = context.snapshot();
  const result = await tool.execute("call", { text: "  Would you mind repeating that?  ", language: "en", purpose: "repeat" },
    new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(reads, 1);
  assert.deepEqual(context.snapshot(), before);
  assert.equal(result.details.speech.text, "Would you mind repeating that?");
  assert.equal(result.details.speech.sourceSessionId, "original-session");
  assert.equal(result.details.speech.goalId, "goal-en");
  assert.equal(result.details.speech.taskId, "task-en");
  assert.equal(result.details.speech.skillId, "skill-en");
  assert.equal("audio" in result.details, false);
  const status = result.content[0]!; assert.equal(status.type, "text");
  assert.ok(status.type === "text"); assert.match(status.text, /未合成音频/);
  await assert.rejects(() => tool.execute("blank", { text: " ", language: "en", purpose: "example" },
    new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]), /不能为空/);
});

test("a speech presentation is allowed beside pending questions and onboarding, without inheriting the old Goal", async () => {
  const context = new TeachingSessionContext(); context.bindSession("draft-session");
  const planning = new GoalOnboardingContext(); planning.start();
  assert.equal(validatePlanningToolRoute(planning.snapshot(), "present_speech"), undefined);
  assert.equal(context.learnerQuestions.writeGuard("present_speech", true), undefined);
  const tool = createPresentSpeechTool(context, planning, { fetchImpl: async () => { throw new Error("must not read old Goal"); } });
  const result = await tool.execute("call", { text: "Hello!", language: "en", purpose: "requested_reading" },
    new AbortController().signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  assert.equal(result.details.speech.goalId, undefined);
  assert.equal(result.details.speech.taskId, undefined);
  assert.equal(context.snapshot().candidate_evidence, null);
});

test("speech descriptors and input provenance reject malformed values and discard unrelated fields", () => {
  assert.equal(readSpeechPresentation({ id: "x", sourceSessionId: "s", text: "x".repeat(601), language: "en", purpose: "example" }), null);
  assert.equal(readSpeechPresentation({ id: "x", sourceSessionId: "s", text: "Hello", language: "xx", purpose: "example" }), null);
  assert.deepEqual(readSpeechPresentation({ id: "x", sourceSessionId: "s", text: "Hello", language: "en", purpose: "example", audio: "secret binary" }),
    { id: "x", sourceSessionId: "s", text: "Hello", language: "en", purpose: "example" });
  assert.throws(() => parseVoiceInputMetadata({ source: "voice", transcriptEdited: "false" }));
});
