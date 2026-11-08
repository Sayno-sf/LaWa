import { createGetLearningOverviewTool } from "./learningOverviewTool.js";
import {createLearningBranchTool, createReadLearningBranchTool} from "./learningBranchTool.js";
import {createConfigureTeachingActivityTool} from "./teachingActivity.js";
import { createTeachingEvolutionTools, TEACHING_EVOLUTION_TOOLS } from "./teachingEvolution.js";
import {
  createActivateLearningTaskTool,
  createCompleteLearningTaskTool,
  createCreateKnowledgeCardTool,
  createCreateLearningTaskTool,
  createSubmitEvidenceTool,
  type LearningToolHttpOptions,
} from "./learningWriteTools.js";
import { TeachingSessionContext } from "./teachingSession.js";
import { createRecordTeachingTurnTool } from "./teachingTool.js";
import { createRecordAnswerAssessmentTool, type AssessmentSource } from "./answerAssessmentTool.js";
import { GoalOnboardingContext } from "./planning/goalOnboarding.js";
import { createWebReadTools } from "./webReadTools.js";
import { createAnySearchTool } from "./anySearchTools.js";
import { createActiveRecallTool } from "./activeRecallTool.js";
import { createLearnerQuestionTool } from "./learnerQuestionTool.js";
import { createPracticeSetTool } from "./practiceSetTool.js";
import { createPresentSpeechTool } from "./speechPresentationTool.js";
import {createPresentExplainerTool} from "./explainerPresentationTool.js";
import {LEARNING_SKILL_TOOL_NAMES,type LearningSkillRuntime} from "./learningSkills.js";
import {createBundledLearningSkills} from "./learningSkillBundles.js";
import {createLessonFigureTool,FIGURE_TOOL} from "./lessonFigures.js";
import type {AgentSurface} from "./agentPolicy.js";
import { createLearningMaterialTools } from "./learningMaterialTools.js";
import { createSourceTools, SourceReadBudget } from "./retrieval/tools.js";
import type { RetrievalRuntime } from "./retrieval/runtime.js";
import {
  createApplyCurriculumPlanTool,
  createDecidePlanRevisionTool,
  createInitializeLearningGoalTool,
  createProposePlanRevisionTool,
  createRecordGoalUnderstandingTool,
} from "./planning/planningTools.js";

import {createMaterialPurposeTool} from "./materialPurposeTool.js";
import {createReadLearningDocumentTool, createLearningVisualTools, type DocumentTurnInput} from "./documentReadingTool.js";
import {createMaterialReadingTools, type MaterialReadingRuntime} from "./materialReadingRuntime.js";
import type {PlanningReadingCoordinator} from "./planning/planningReading.js";
import {createReviewPlanningSourcesTool, PlanningSourceReviewContext} from "./planning/planningSourceReview.js";

export const LEARNING_AGENT_TOOL_NAMES: readonly string[] = Object.freeze([
  ...LEARNING_SKILL_TOOL_NAMES,
  ...TEACHING_EVOLUTION_TOOLS,
  "get_learning_overview",
  "propose_learning_branch",
  "read_learning_branch_context",
  "get_imported_learning_context",
  "get_skill_learning_context",
  "list_learning_materials",
  "read_learning_material",
  "search_learning_material",
  "set_learning_material_purpose",
  "read_learning_document",
  "list_learning_visuals",
  "read_learning_visual",
  "start_material_reading",
  "get_material_reading",
  "stop_material_reading",
  "search_learning_sources",
  "read_learning_source",
  "create_learning_task",
  "configure_teaching_activity",
  "activate_learning_task",
  "complete_learning_task",
  "submit_evidence",
  "create_knowledge_card",
  "record_teaching_turn",
  "record_answer_assessment",
  "active_recall_checkpoint",
  "ask_learner_questions",
  "present_practice_set",
  "present_speech",
  FIGURE_TOOL,
  "record_goal_understanding",
  "review_planning_sources",
  "initialize_learning_goal",
  "apply_curriculum_plan",
  "propose_plan_revision",
  "decide_plan_revision",
  "search_github_repositories",
  "read_github_path",
  "read_web_page",
  "search_web",
]);

export function createLearningAgentTools(
  context: TeachingSessionContext,
  options: LearningToolHttpOptions = {},
  planningContext = new GoalOnboardingContext(),
  retrieval?: RetrievalRuntime,
  budget = new SourceReadBudget(),
  assessmentSource?: () => AssessmentSource | null,
  currentUserText: () => string = () => "",
  documents?: DocumentTurnInput,
  reading?: MaterialReadingRuntime,
  planningReading?: PlanningReadingCoordinator,
  planningSourceReview = new PlanningSourceReviewContext(),
  surface: AgentSurface = "CLI",
  learningSkills:LearningSkillRuntime=createBundledLearningSkills(surface,"TEACHER"),
  branchProposed?: (branch: import("./learningBranchTypes.js").LearningBranch) => Promise<unknown>,
  assessmentSourceValidated?: () => void,
  lessonArt?:import("./lessonArtwork.js").LessonArtwork, figureTurnId?:()=>string|undefined,
) {
  const draft = () =>
    !["IDLE", "INITIALIZED"].includes(planningContext.snapshot().status) && context.getSessionId() !== "cli-runtime"
      ? context.getSessionId() : null;
  return [
    ...learningSkills.tools(),
    ...createTeachingEvolutionTools(options),
    createGetLearningOverviewTool(options),
    createLearningBranchTool(options, branchProposed),
    createReadLearningBranchTool(options),
    // 草稿归属取自当前 runtime，不让模型通过工具参数选择其他会话或旧 Goal。
    ...createLearningMaterialTools(options, draft, retrieval, budget, () => context.getSessionId()),
    createMaterialPurposeTool(options, {sessionId: () => context.getSessionId(), draftSession: draft, userText: currentUserText}),
    createReadLearningDocumentTool(documents),
    ...createLearningVisualTools(documents),
    ...createMaterialReadingTools(reading, draft),
    ...createSourceTools(retrieval, draft, budget),
    createCreateLearningTaskTool(options),
    createConfigureTeachingActivityTool(context, options),
    createActivateLearningTaskTool(options),
    createCompleteLearningTaskTool(options),
    createSubmitEvidenceTool(options),
    createCreateKnowledgeCardTool(options),
    createRecordTeachingTurnTool(context, options),
    createRecordAnswerAssessmentTool(context, options, assessmentSource, assessmentSourceValidated),
    createActiveRecallTool(context, options),
    createLearnerQuestionTool(context, planningContext, options),
    createPracticeSetTool(context, planningContext, options),
    createPresentSpeechTool(context, planningContext, options),
    createLessonFigureTool(context,planningContext,options,surface,lessonArt,figureTurnId),
    ...(learningSkills.hasToolAdapter("present_explainer_animation")?[createPresentExplainerTool(context, planningContext, options, surface)]:[]),
    createRecordGoalUnderstandingTool(planningContext, planningReading),
    createReviewPlanningSourcesTool(context, planningContext, planningSourceReview),
    createInitializeLearningGoalTool(planningContext, {
      ...options, onboardingSessionId: context.getSessionId() === "cli-runtime" ? undefined : context.getSessionId(),
    }),
    createApplyCurriculumPlanTool(options),
    createProposePlanRevisionTool(options),
    createDecidePlanRevisionTool(context, options),
    // 公开资料读取仍走共享 Agent Tool Registry；权限仅为外部只读，不穿过 Kernel 写入边界。
    ...createWebReadTools(),
    createAnySearchTool(),
  ];
}
