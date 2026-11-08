import assert from "node:assert/strict";
import test from "node:test";

import type { LearningOverview } from "../learningOverviewTool.js";
import {
  chooseInitialFrontier,
  chooseReplannedFocus,
  validatePlanningToolRoute,
} from "./planningPolicy.js";

function overview(recent_evidence: unknown[]): LearningOverview {
  return {
    current_goal: "理解 CNN 并独立实现分类模型",
    goal_profile: null,
    curriculum_spine: [],
    current_frontier: null,
    current_focus: null,
    skills: [],
    recent_evidence,
    active_task: null,
    learning_history: [],
    current_goal_skill_ids: [],
  };
}

test("same CNN goal starts at CNN when independent training-loop evidence exists", () => {
  assert.equal(
    chooseInitialFrontier(
      overview([
        {
          skill_id: "training-loop",
          evidence_type: "BUILD",
          assistance_level: "INDEPENDENT",
        },
      ]),
      {
        prerequisite_skill_id: "training-loop",
        target_skill_id: "cnn",
        evidence_type: "BUILD",
      },
    ),
    "cnn",
  );
});

test("same CNN goal starts at training loop without qualifying evidence", () => {
  assert.equal(
    chooseInitialFrontier(overview([]), {
      prerequisite_skill_id: "training-loop",
      target_skill_id: "cnn",
      evidence_type: "BUILD",
    }),
    "training-loop",
  );
});

test("CNN teaching performance produces a different next frontier", () => {
  const options = {
    remediation_skill_id: "feature-map",
    next_skill_id: "receptive-field",
  };
  assert.equal(chooseReplannedFocus("NEEDS_REMEDIATION", options), "feature-map");
  assert.equal(chooseReplannedFocus("READY_TO_EXPAND", options), "receptive-field");
});

test("active replacement onboarding blocks routing back to the old overview and task", () => {
  const replacing = {
    status: "NEEDS_CLARIFICATION" as const,
    pending_profile: null,
    missing_information: ["goal and desired outcome"],
    replace_existing: true,
  };

  assert.equal(
    validatePlanningToolRoute(replacing, "record_goal_understanding"),
    undefined,
  );
  assert.match(
    validatePlanningToolRoute(replacing, "get_learning_overview")?.reason ?? "",
    /replacement onboarding.*record_goal_understanding/i,
  );
  assert.match(
    validatePlanningToolRoute(replacing, "record_teaching_turn")?.reason ?? "",
    /replacement onboarding/i,
  );
  for (const name of ["list_learning_materials", "read_learning_material", "search_learning_material"]) {
    assert.equal(validatePlanningToolRoute(replacing, name), undefined, `${name} must be available before Goal planning`);
  }
});

test("normal learning flow is not restricted when onboarding is idle", () => {
  assert.equal(
    validatePlanningToolRoute(
      {
        status: "IDLE",
        pending_profile: null,
        missing_information: [],
        replace_existing: false,
      },
      "get_learning_overview",
    ),
    undefined,
  );
});

test("confirmed reading may ask one material clarification before initializing the route", () => {
  const confirmed = {
    status: "CONFIRMED" as const,
    pending_profile: {
      id: "goal-sources",
      goal_description: "按资料学习",
      background_summary: "",
      desired_outcome: "形成路线",
      learning_preferences: [],
      time_constraint: "",
      prior_knowledge_claims: [],
    },
    missing_information: [],
    replace_existing: false,
    reading_requirement: {
      id: "a".repeat(64),
      session_id: "session-a",
      user_entry_id: "user-a",
      profile_hash: "b".repeat(64),
      materials: [{id: "mat-" + "c".repeat(32), name: "教材.md"}],
    },
  };
  assert.equal(validatePlanningToolRoute(confirmed, "review_planning_sources"), undefined);
  assert.equal(validatePlanningToolRoute(confirmed, "ask_learner_questions", "BACKGROUND"), undefined);
  assert.equal(validatePlanningToolRoute(confirmed, "ask_learner_questions", "CHECK")?.block, true);
  assert.equal(validatePlanningToolRoute(confirmed, "initialize_learning_goal"), undefined);
});
