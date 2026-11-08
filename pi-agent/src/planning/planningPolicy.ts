import type { LearningOverview } from "../learningOverviewTool.js";
import type { GoalOnboardingSnapshot } from "./goalOnboarding.js";

// 规划只说明路线与确认决策；通用来源、评分、语音和帮助边界复用Teacher政策。
export const PLANNING_POLICY_PROMPT = `
规划与确认：
- Planner决定路线，Teacher围绕ACTIVE Task教学。无Goal时从自然语言提取用途/期望结果、背景、偏好与约束；已知信息不重问。重要缺失才record_goal_understanding(NEEDS_CLARIFICATION)，用ask_learner_questions(BACKGROUND)收集同批必要问题，通常1～3个，必要时可以增加到4-5个；页面逐题保存草稿，整批答完才提交，工具成功后结束本轮。Prior Knowledge Claim只是自述，只影响起点和诊断，绝不创建Evidence、Mastery或已学状态。
- 用户确认的是Goal Understanding，不是专业课程表。复述目标、背景、结果及路线取向；record_goal_understanding(READY_FOR_CONFIRMATION)成功后，下一模型响应单独请求CONFIRM_GOAL。只有独立实际确认后才record_goal_understanding(CONFIRMED)，再initialize_learning_goal。调整/暂缓不是同意，修订后重新确认；附件上传不授予确认。
- 初始化成功后，下一模型响应单独请求START_LEARNING，实际同意后才创建/激活首个Task；同一Frontier内的小步骤自然衔接。Web用动作组件、CLI用文字，依赖操作不并行；跨Frontier/重大阶段或暂停后需用户决定，不因换教法绕过确认。
- 确认后生成5～8个粗粒度Curriculum Spine milestone，只展开当前Frontier的1～3个近期Skill；不生成长期每日计划或几十个节点。Skill ID稳定可读，LearningDepth按用途和明确偏好选择，与SkillState分开。Curriculum milestone不是LearningTask，可逐步产生多个EXPLAIN/BUILD/DEBUG/TRANSFER任务。每个已展开Skill必须明确列入当前Goal某个milestone.skill_ids，不让知识点成为路线外的第二份列表；远期未展开阶段留空。
- 用最新实际表现、Assistance、SkillState与Task规划；独立Evidence支持跳过低价值基础，必要前置缺口才短补。依据用户用途安排可观察结果，非必要扩展不强加，不要求完全理解每处细节才能继续。助教是当前任务支持，不是第二条路线，不按求助次数改课程或强制加考。
- apply_curriculum_plan只用于同一已确认Goal/Spine范围内的局部未来节点维护：可调整未来NOT_STARTED且无历史的Skill、依赖与Frontier，不能修改Goal Profile或Curriculum Spine的阶段身份、顺序与含义；可用milestone_assignments将当前Goal已展开的Skill明确归入既有阶段（含旧知识点补归属），只改组织关系、不改原Skill状态或Evidence。新增Skill同次附明确归属。
- 考试范围、期望结果、用途、理论/实践取向、深度或高层里程碑发生改变时，必须用propose_plan_revision提交完整的Goal、Spine、Skill变更与Frontier候选；先展示Kernel生成的变更摘要，再用ask_learner_questions(CONFIRM_PLAN_REVISION, plan_revision_id)独立确认。用户确认后才用decide_plan_revision原子生效，拒绝或补充前不得声称路线已修改。不得通过删除重加Skill绕过旧Goal/Spine。
- 用户指定文件作为路线主要依据时，在record_goal_understanding的material_basis声明当前草稿原件ID，指定主教材再填primary_material_id。系统绑定实际请求及原件版本并排队完整阅读；确认目标理解不等于资料已读完，正式路线必须等全部主要依据有效READY，不能以开头/解析complete/RAG命中代替。主要依据超过一份时，完整阅读包交付后、initialize_learning_goal之前必须先调用review_planning_sources；只有事实、适用范围和依赖兼容时返回COMPATIBLE，否则记录冲突并先询问用户。等待或失败时结束本轮，不紧密轮询或重复索要确认；不得邀请或提供“路线没生成也能先上第一章”，未保存路线并取得开始同意前不正式教学、出题或记录表现。主要依据尚在阅读时只确认用途与目标，不重复手动逐页通读；规划通读保留关键结构和前置，次要图表细节按后续教学需要再读。普通截图、长期参考和中途补充不自动成为主要依据；不靠删掉已声明资料绕过阅读。旧Goal资料不属于当前规划。
- 时间约束及已入账观察时间只影响任务大小、讲练节奏，不降低能力目标，不按分钟数完成任务或编造进度。文字/选择题/语音偏好只改变教法，不替代目标要求的真实表现；已知偏好沿用，语音偏好不等于服务可用，不自行改配置。
`;

export interface PlanningToolRouteDecision {
  block: true;
  reason: string;
}

export function planningRuntimeDirective(
  context: GoalOnboardingSnapshot,
): string {
  if (context.continuing_goal_id && ["NEEDS_CLARIFICATION", "READY_FOR_CONFIRMATION", "CONFIRMED"].includes(context.status)) {
    return `ROUTE OVERRIDE — 当前是导入目标首次补路线，保留目标ID ${context.continuing_goal_id}。状态=${context.status}。先get_imported_learning_context按需读取背景摘要、已有知识点、自述和原答/评审；按skill_count与next_offset读取相关页，不能只看第一页就假定零基础。完整保留已有知识点ID与来源，不重建目标。依据最近实际学习位置、未解决问题和用户意愿选择frontier并简短说明理由，不默认选择第一项重学。区分讲过、自述、作答与评审；资料不足时只澄清会改变起点的问题，不逐点重考。数组顺序是学习经历，不是已完成进度或强制课程顺序。READY_FOR_CONFIRMATION必须等待真实独立确认并record_goal_understanding(CONFIRMED)；CONFIRMED后用同一确认Profile、replace_existing=true初始化路线，将已有知识点归入阶段，近期只需展开1～3项。自述不等于已掌握，外部评审也不自动创建Evidence。初始化完成后仍须START_LEARNING同意才开始课堂。`;
  }
  if (context.status === "NEEDS_CLARIFICATION") {
    return context.replace_existing
      ? "ROUTE OVERRIDE — new Goal onboarding is active (`replace_existing=true`). 当前用户输入作为新 Goal 描述处理；用户指定文件时先读取当前草稿材料，再调用 record_goal_understanding；否则优先调用 record_goal_understanding。旧 Goal 与 ACTIVE Task 暂停教学，确认后保存为可恢复的工作区；不得调用 get_learning_overview 后回到旧任务，不得再次要求用户执行 /new-goal replace。"
      : "ROUTE OVERRIDE — Goal onboarding is active. 用户指定文件时先读取当前草稿材料，再调用 record_goal_understanding；不得进入教学或 Task 流程。";
  }
  if (context.status === "READY_FOR_CONFIRMATION") {
    return "ROUTE OVERRIDE — Goal Understanding 正在等待独立确认。当前用户输入若为明确确认，必须先调用 record_goal_understanding(outcome=CONFIRMED)；不得跳过确认直接初始化，也不得回到旧 Goal/Task。";
  }
  if (context.status === "CONFIRMED") {
    if (context.reading_requirement) return `ROUTE OVERRIDE — 用户已独立确认本次目标理解及资料依据。initialize_learning_goal须在本次请求收到所有主要资料的有效阅读结论后执行，后端仍检查原件版本与完整阅读，严格使用replace_existing=${String(context.replace_existing)}。如仍在阅读，简短说明并结束本轮；系统仅在原分支/目标仍有效时接续规划。完整阅读包已交付后，多份主要依据必须先调用review_planning_sources完成本轮兼容/冲突复核；COMPATIBLE 后再调用initialize_learning_goal，不能用框架说明、再次确认或“稍后规划”代替。资料对新路线存在实质冲突或缺少会改变路线适用的事实时应返回NEEDS_CLARIFICATION，再用ask_learner_questions(BACKGROUND)提出一个具体问题并给2～5个中立选项；保留双方事实，等待真实回答，不生成正式路线。不重复请求确认、不紧密轮询、不返回旧Goal或批改旧回答。机器阅读完成不等于用户同意开始教学。`;
    return `ROUTE OVERRIDE — Goal Understanding 已确认。现在只初始化已确认的新路线，调用 initialize_learning_goal，并严格使用 replace_existing=${String(context.replace_existing)}；不得继续旧 Goal/Task。`;
  }
  return "No onboarding route override.";
}

export function validatePlanningToolRoute(
  context: GoalOnboardingSnapshot,
  toolName: string,
  purpose?: string,
): PlanningToolRouteDecision | undefined {
  // Replacement onboarding 一旦由用户显式开启，就成为当前唯一合法路线。
  // Prompt 负责告诉模型下一步，Tool preflight 负责阻止模型退回旧 Goal/Task。
  const expectedTool =
    context.status === "NEEDS_CLARIFICATION" ||
    context.status === "READY_FOR_CONFIRMATION"
      ? "record_goal_understanding"
      : context.status === "CONFIRMED"
        ? "initialize_learning_goal"
        : null;
  const sourceClarification =
    context.status === "CONFIRMED" &&
    Boolean(context.reading_requirement) &&
    toolName === "ask_learner_questions" &&
    purpose === "BACKGROUND";
  const sourceReview = context.status === "CONFIRMED" &&
    Boolean(context.reading_requirement) &&
    toolName === "review_planning_sources";
  if (!expectedTool || toolName === expectedTool ||
      (toolName === "get_imported_learning_context" && Boolean(context.continuing_goal_id)) ||
      sourceClarification || sourceReview || toolName === "begin_teacher_reply" ||
      (toolName === "ask_learner_questions" && ["NEEDS_CLARIFICATION", "READY_FOR_CONFIRMATION"].includes(context.status)) ||
      ["list_learning_skills", "load_learning_skill", "read_learning_skill_resource", "present_speech", "list_learning_materials", "set_learning_material_purpose", "read_learning_document", "list_learning_visuals", "read_learning_visual", "start_material_reading", "get_material_reading", "stop_material_reading", "read_learning_material", "search_learning_material",
        "search_learning_sources", "read_learning_source"].includes(toolName)) return undefined;
  const routeName = context.replace_existing
    ? "replacement onboarding"
    : "goal onboarding";
  return {
    block: true,
    reason: `${routeName} is active at status ${context.status}; call ${expectedTool} instead of ${toolName}. Old overview, task, teaching, and evidence tools are outside the active route.`,
  };
}

function evidenceRecords(overview: LearningOverview): Array<Record<string, unknown>> {
  return overview.recent_evidence.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

export interface EvidenceGate {
  prerequisite_skill_id: string;
  target_skill_id: string;
  evidence_type: "EXPLAIN" | "BUILD" | "DEBUG" | "TRANSFER";
}

export function chooseInitialFrontier(
  overview: LearningOverview,
  gate: EvidenceGate,
): string {
  // Prior claim 不参与这个判断；只有 Kernel 中真实、帮助程度足够的 Evidence
  // 才允许 Planner 跳过 prerequisite，避免把“我学过”误当成已经证明。
  const hasQualifyingEvidence = evidenceRecords(overview).some(
    (item) =>
      item.skill_id === gate.prerequisite_skill_id &&
      item.evidence_type === gate.evidence_type &&
      (item.assistance_level === "INDEPENDENT" ||
        item.assistance_level === "TRANSFERRED"),
  );
  return hasQualifyingEvidence
    ? gate.target_skill_id
    : gate.prerequisite_skill_id;
}

export type FrontierPerformance = "NEEDS_REMEDIATION" | "READY_TO_EXPAND";

export function chooseReplannedFocus(
  performance: FrontierPerformance,
  options: { remediation_skill_id: string; next_skill_id: string },
): string {
  // Teaching 表现只影响下一段 Frontier：理解缺口留在当前附近，
  // 可靠表现才展开下一节点；这里不直接改变 SkillState 或 Mastery。
  return performance === "READY_TO_EXPAND"
    ? options.next_skill_id
    : options.remediation_skill_id;
}
