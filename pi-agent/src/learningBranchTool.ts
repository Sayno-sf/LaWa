import {createHash} from "node:crypto";
import {defineTool} from "@earendil-works/pi-coding-agent";
import {Type} from "typebox";
import {fetchLearningOverview} from "./learningOverviewTool.js";
import {teachingRequest} from "./teachingEvolution.js";
import type {LearningToolHttpOptions} from "./learningWriteTools.js";
import type {LearningBranch} from "./learningBranchTypes.js";

export const LEARNING_BRANCH_POLICY = `
路线分支与Pi session分支、复习分支是不同概念。主线和路线分支共用同一课堂会话，聊天连续保留。
当当前学习确实被前置知识卡住，或用户采纳深化/跨领域挑战时，可用propose_learning_branch提出补足或拓展。说明学什么、为什么、挂在主线哪里、做到什么可返回；一句解释或小提示不建分支。普通提案等待用户进入；用户明确要求“先补一下”时承接其本次意图，不再重复索要确认。提案结果continuation.entered=true表示系统已承接该次明确请求进入分支，立即按返回的learning_context接着教学，不再要求点击进入；否则仅保存了提案。
以当前learning_paths为准，ACTIVE分支期间只围绕该分支范围教学。跨目标来源用read_learning_branch_context回读实际资料，区分自述与已评审表现。遇到更基础的缺口，在当前分支追加必要小步骤，不创建子分支，不静默更改主线阶段或主线任务。其他目标只读引用。
分支达到本次目的时简短说明可以完成并返回，让用户使用界面入口；用户随时可以返回，未完成只暂停。返回不要求整个知识点Mastery、不强制考试，不完成原任务。返回后的handoff区分教师讲解、实际作答和未解决问题，帮助必须如实计入原题评价。分支结束不必弹Mastery确认；用户可另行确认真正掌握。
主线完成不要求所有拓展分支完成，分支专属知识点不计入主线完成率。`;

export function createLearningBranchTool(options: LearningToolHttpOptions,
  proposed?: (branch: LearningBranch) => Promise<unknown>) {
  return defineTool({
    name: "propose_learning_branch", label: "提出学习分支",
    description: "在当前主线知识点或阶段旁提出一层补足/拓展路线，不创建新目标或新session。只保存提案，通常由用户进入；分支中再遇缺口用apply_curriculum_plan扩充本分支。",
    parameters: Type.Object({
      anchor_kind: Type.Union([Type.Literal("skill"), Type.Literal("milestone")]), anchor_id: Type.String(),
      purpose: Type.Union([Type.Literal("prerequisite"), Type.Literal("extension")]),
      title: Type.String({minLength: 1, maxLength: 200}), reason: Type.String({minLength: 1, maxLength: 1600}),
      scope: Type.String({minLength: 1, maxLength: 1600}), return_condition: Type.String({minLength: 1, maxLength: 1600}),
      skill_ids: Type.Optional(Type.Array(Type.String(), {maxItems: 12, description: "只引用当前Goal已有知识点；新内容省略，由Kernel保持独立身份。"})),
    }),
    execute: async (_id, params, signal) => {
      const overview = await fetchLearningOverview(options, signal);
      const goal = overview.goal_profile as {id?: string} | null;
      if (!goal?.id || overview.learning_paths?.active_branch_id) throw new Error("只能从当前主线提议分支；分支中的基础缺口继续在本分支处理。");
      const id = "route-" + createHash("sha256").update(JSON.stringify([goal.id, params])).digest("hex").slice(0, 24);
      const branch = await teachingRequest(options, "learning/branches/propose", {...params, id, goal_id: goal.id,
        expected_plan_revision: overview.plan_revision ?? 0}, signal) as LearningBranch;
      const continuation = await proposed?.(branch);
      return {content: [{type: "text" as const, text: JSON.stringify({branch, continuation: continuation ?? "等待用户选择进入；尚未切换教学焦点。"})}], details: {learningBranch: branch}};
    },
  });
}

export function createReadLearningBranchTool(options: LearningToolHttpOptions) {
  return defineTool({name: "read_learning_branch_context", label: "读取分支背景",
    description: "只读当前目标的路线分支及关联目标背景，含来源、实际表现、自述与省略数量；不会切换课堂或更改其他目标。",
    parameters: Type.Object({branch_id: Type.String({minLength: 1})}),
    execute: async (_id, params, signal) => {
      const value = await teachingRequest(options, `learning/branches/${encodeURIComponent(params.branch_id)}/context`, undefined, signal);
      return {content: [{type: "text" as const, text: JSON.stringify(value)}], details: {readOnly: true}};
    }});
}
