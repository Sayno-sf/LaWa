import assert from "node:assert/strict";
import test from "node:test";

import {
  LEARNING_AGENT_TOOL_NAMES,
  createLearningAgentTools,
} from "./learningAgentTools.js";
import { TeachingSessionContext } from "./teachingSession.js";

test("Agent Tool Registry exposes teaching tools but no user-owned mastery operations", () => {
  const forbidden = [
    "confirm_mastery",
    "mark_mastered",
    "reopen_skill",
    "start_practicing",
    "set_skill_state",
    "force_skill_state",
    "present_teaching_animation",
    "present_explainer_animation",
  ];
  const tools = createLearningAgentTools(new TeachingSessionContext());

  assert.deepEqual(
    tools.map((tool) => tool.name),
    LEARNING_AGENT_TOOL_NAMES,
  );
  for (const name of forbidden) {
    assert.ok(!LEARNING_AGENT_TOOL_NAMES.includes(name));
  }
});

test("every Agent tool has an OpenAI-compatible object root schema", () => {
  const tools = createLearningAgentTools(new TeachingSessionContext());
  for (const tool of tools) {
    assert.equal(
      (tool.parameters as { type?: string }).type,
      "object",
      `${tool.name} must expose type=object at the function-schema root`,
    );
  }
});

test("Agent Tool Registry registers create_knowledge_card", () => {
  assert.ok(
    LEARNING_AGENT_TOOL_NAMES.includes("create_knowledge_card"),
    "LEARNING_AGENT_TOOL_NAMES must include create_knowledge_card",
  );
  const tools = createLearningAgentTools(new TeachingSessionContext());
  assert.ok(
    tools.some((tool) => tool.name === "create_knowledge_card"),
    "createLearningAgentTools() must return the create_knowledge_card tool",
  );
});

test("external source tools are read-only and available to CLI and Web", () => {
  const names = createLearningAgentTools(new TeachingSessionContext()).map((tool) => tool.name);
  for (const name of ["search_web", "search_github_repositories", "read_github_path", "read_web_page"]) {
    assert.ok(names.includes(name));
  }
  assert.ok(!names.includes("write_github_file"));
  assert.ok(!names.includes("clone_repository"));
});
