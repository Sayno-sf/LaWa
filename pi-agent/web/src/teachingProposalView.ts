import { renderMarkdown } from "./markdown";
interface Proposal {
  id: string; revision: number; kind: "STRATEGY" | "CLOSURE"; text: string; reason: string;
  scope: string; subject: string; status: string; goal_id: string | null; source_independent?: boolean;
}
export interface GoalClosureProgress {
  goal_id: string; snapshot_signature: string; milestone_count: number; covered_milestone_count: number;
  route_learning_complete: boolean; formal_assessment_coverage_complete: boolean;
  verification_status: "NOT_INFERRED"; user_confirmed_count: number; expanded_skill_count: number;
  latest_end_choice_status: string | null; active_task_present: boolean; unscored_skill_ids: string[];
  milestones: Array<{id: string; name: string; expanded: boolean; covered: boolean; tasks_completed: boolean; skills: ClosureSkill[]}>;
  unassigned_skills: ClosureSkill[];
}
interface ClosureSkill {
  id: string; name: string; task_completed: boolean; response_recorded: boolean; assessment_count: number;
  evidence_count: number; assistance_levels: string[]; latest_assessment: {id: string; score: number} | null; mastered_by_user: boolean;
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));
const subjects: Record<string, string> = {language: "语言交流", "language:literacy": "语言阅读、写作与考试", history: "历史材料理解", "history:exam": "历史考试与记忆", technical: "程序阅读与修改", "technical:build": "程序开发与作品实践", general: "当前领域与用途"};
const scope = (p: Proposal) => p.scope === "USER" ? p.source_independent ? "通用教学偏好，不随某个学习目标一起删除。" : "适用于你的后续学习，随来源目标保留。" : p.scope === "SUBJECT" ? p.subject.startsWith("domain:") ? `适用领域：${p.subject.slice("domain:".length)}；按具体活动使用。` : `仅用于原学习目标（原范围：${subjects[p.subject] ?? p.subject}）` : "仅用于这个学习目标";

function closureProgressContent(progress?: GoalClosureProgress | null): string {
  if (!progress) return '<p class="proposal-scope">当前路线记录尚未读取。结束本次学习不代表路线完成或确认掌握。</p>';
  const assistance: Record<string, string> = {WITH_HELP:"获得帮助",WITH_HINT:"获得提示",WITH_REFERENCE:"使用参考",INDEPENDENT:"记录为独立完成",TRANSFERRED:"记录为迁移表现"};
  const skills = (items: ClosureSkill[]) => items.map(s => `<li>${escape(s.name)}：${s.latest_assessment ? `正式评分 ${s.latest_assessment.score} / 10` : "正式评分缺失"}；${s.response_recorded ? "已有实际表现记录" : "尚无实际表现记录"}${s.assistance_levels.length ? `；${s.assistance_levels.map(a=>escape(assistance[a] ?? a)).join("、")}` : ""}</li>`).join("");
  return `<div class="closure-progress"><p>学习记录覆盖：${progress.covered_milestone_count} / ${progress.milestone_count} 阶段</p><p>${progress.route_learning_complete ? "路线各阶段已有作答记录且相关任务已完成。" : "路线仍有未覆盖或未完成的部分，可以先结束本次学习。"}${progress.formal_assessment_coverage_complete ? "各已展开知识点均至少有一条正式评分，不代表每次作答都已评分。" : "部分知识点缺少正式评分，保留缺失，不补造分数。"}</p><p class="proposal-scope">整体能力尚未单独验证；用户确认掌握：${progress.user_confirmed_count} 项 / 已展开 ${progress.expanded_skill_count} 项。完成流程不等于全部掌握。</p><details><summary>查看逐阶段记录与缺项</summary><ol>${progress.milestones.map(stage=>`<li>${escape(stage.name)}：${stage.covered ? "已有实际表现记录" : stage.expanded ? "未覆盖" : "未展开 · 未覆盖"}${stage.skills.length ? `<ul>${skills(stage.skills)}</ul>` : ""}</li>`).join("")}</ol>${progress.unassigned_skills.length ? `<p>尚未归入阶段的知识点</p><ul>${skills(progress.unassigned_skills)}</ul>` : ""}</details></div>`;
}

export function preferenceContent(text: string): string {
  const rendered = renderMarkdown(text);
  // 只整理旧的纯文本单段；保留已有Markdown。引用内的句号/分号仍属于同一句示例。
  if (/[\r\n]/u.test(text) || !/^<p>[^<>]*<\/p>$/u.test(rendered)) return rendered;
  const closing: Record<string, string> = {"「": "」", "『": "』", "“": "”", "‘": "’", "（": "）", "(": ")", '"': '"'};
  const quotes: string[] = [];
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\") { index++; continue; }
    if (quotes.at(-1) === char) quotes.pop();
    else if (closing[char]) quotes.push(closing[char]!);
    else if (!quotes.length && (char === "；" || char === "。")) {
      parts.push(text.slice(start, index + 1).trim());
      start = index + 1;
    }
  }
  // 不完整的引文不猜测边界；只改变展示，不改已保存规则和教师输入。
  if (quotes.length) return rendered;
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts.length > 1 ? renderMarkdown(parts.map(part => `- ${part}`).join("\n")) : rendered;
}

// 此处只收集独立的用户决策，绝不从聊天框取文字或生成learner_reply。
export class TeachingProposalView {
  readonly node = document.createElement("section");
  readonly management = document.createElement("section");
  private session: string | null = null;
  private revision = 0;
  private signature = "";
  private busy = false;
  private current: Proposal[] = [];
  private drafts = new Map<string, string>();
  private requestIds = new Map<string, string>();
  private loading?: Promise<void>;
  private loadingSession?: string;
  private progress: GoalClosureProgress | null = null;
  get closureProgress(): GoalClosureProgress | null { return this.progress; }
  constructor(private readonly changed: () => void = () => {}) {
    this.node.className = "teaching-proposals";
    this.node.setAttribute("aria-label", "教学偏好建议");
    this.management.className = "teaching-arrangements";
    this.management.innerHTML = '<div data-strategies></div><p data-status role="status" aria-live="polite"></p>';
    for (const root of [this.node, this.management]) {
      root.addEventListener("input", event => {
        const input = event.target as HTMLTextAreaElement;
        if (input.matches("textarea[data-proposal]")) this.drafts.set(input.dataset.proposal!, input.value);
      });
      root.addEventListener("click", event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-decision]");
        if (button && !this.busy) void this.decide(button.dataset.proposal!, button.dataset.decision!);
      });
    }
  }
  async refresh(session: string | null, enabled: boolean): Promise<void> {
    if (this.session !== session) {this.session = session; this.signature = ""; this.progress = null; this.revision++; this.node.replaceChildren();}
    this.node.hidden = !enabled || !session;
    const loadingKey = session ?? "personal";
    if (this.loading && this.loadingSession === loadingKey) return this.loading;
    this.loadingSession = loadingKey;
    const revision = this.revision;
    this.loading = (async () => {
      try {
        const response = await fetch("/api/web/teaching");
        if (!response.ok) throw new Error("教学偏好暂时无法读取，请稍后重试。");
        const value = await response.json() as {proposals?: Proposal[]; current_goal_id?: string; closure_progress?: GoalClosureProgress | null};
        if (revision !== this.revision || session !== this.session || !Array.isArray(value.proposals)) return;
        this.current = value.proposals;
        this.progress = value.closure_progress && value.closure_progress.goal_id === value.current_goal_id ? value.closure_progress : null;
        this.management.querySelector<HTMLElement>("[data-status]")!.textContent = "";
        const signature = JSON.stringify([this.node.hidden, value.current_goal_id, value.proposals, this.progress]);
        if (signature === this.signature) return;
        this.signature = signature;
        const pending = this.node.hidden ? [] : this.current.filter(p => p.status === "PENDING" && p.goal_id === value.current_goal_id).slice(-1);
        const receipt = this.node.hidden || this.progress?.active_task_present || pending.some(p=>p.kind === "CLOSURE") || !["CONFIRMED","PAUSED"].includes(this.progress?.latest_end_choice_status ?? "") ? undefined : [...this.current].reverse().find(p=>p.goal_id === value.current_goal_id && p.kind === "CLOSURE" && ["CONFIRMED","PAUSED"].includes(p.status));
        // 保留提案原文作历史，但当前结束卡只展示Kernel即时事实，旧自由总结不能覆盖补学结果。
        this.node.innerHTML = pending.map(p => `<div class="teaching-proposal" data-id="${escape(p.id)}"><h3>${p.kind === "STRATEGY" ? "以后这样教你，可以吗？" : "结束本次学习？"}</h3>${p.kind === "CLOSURE" ? closureProgressContent(this.progress) : `<p>${escape(p.text)}</p><p class="proposal-reason">${escape(p.reason)}</p><p class="proposal-scope">${escape(scope(p))}</p>`}<div class="proposal-actions"><button type="button" class="primary-button" data-proposal="${escape(p.id)}" data-decision="CONFIRM">${p.kind === "STRATEGY" ? "确认" : "接受结束建议"}</button><button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="REJECT">${p.kind === "STRATEGY" ? "拒绝" : "继续学习"}</button>${p.kind === "CLOSURE" ? `<button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="PAUSE">暂时结束</button>` : ""}</div><details><summary>补充意见</summary><label>想调整哪些地方？<textarea rows="2" maxlength="4000" data-proposal="${escape(p.id)}">${escape(this.drafts.get(p.id) ?? "")}</textarea></label><button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="SUPPLEMENT">提交意见</button></details><p data-status role="status" aria-live="polite"></p></div>`).join("") + (receipt ? `<div class="teaching-proposal" data-closure-receipt data-goal-id="${escape(receipt.goal_id!)}" data-status="${escape(receipt.status)}"><h3>此前结束选择已保存 · 可继续复习</h3><p>原路线、作答和学习记录保留；这里展示当前记录，不代表本次会话再次结束。</p>${closureProgressContent(this.progress)}</div>` : "");
        this.management.querySelector("[data-strategies]")!.innerHTML = this.current.filter(p => p.kind === "STRATEGY" && ["CONFIRMED", "WITHDRAWN", "REVISION_REQUESTED"].includes(p.status)).map(p => `<div class="confirmed-strategy" data-id="${escape(p.id)}" data-state="${escape(p.status)}"><span class="strategy-state">${p.status === "CONFIRMED" ? "已启用" : p.status === "WITHDRAWN" ? "已停用" : "待修订 · 未启用"}</span><div class="reading-content">${preferenceContent(p.text)}</div><p class="proposal-scope">${escape(scope(p))}</p><div class="proposal-actions">${p.status === "CONFIRMED" ? `<button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="WITHDRAW">停用</button>` : p.status === "WITHDRAWN" ? `<button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="RESTORE">启用</button>` : ""}<button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="DELETE">删除</button></div>${p.status === "CONFIRMED" ? `<details><summary>修改意见</summary><label>希望怎样调整？<textarea rows="2" maxlength="4000" data-proposal="${escape(p.id)}">${escape(this.drafts.get(p.id) ?? "")}</textarea></label><button type="button" class="ghost-button" data-proposal="${escape(p.id)}" data-decision="SUPPLEMENT">提交修改意见</button></details>` : ""}<p data-status role="status" aria-live="polite"></p></div>`).join("") || "<p>还没有已确认的教学偏好。</p>";
      } catch (error) {
        if (revision === this.revision) this.management.querySelector<HTMLElement>("[data-status]")!.textContent = error instanceof Error ? error.message : "无法读取教学偏好。";
      } finally {if (revision === this.revision) this.loading = undefined;}
    })();
    return this.loading;
  }
  private async decide(id: string, action: string) {
    const proposal = this.current.find(p => p.id === id);
    const session = this.session;
    const personal = proposal?.kind === "STRATEGY" && proposal.status !== "PENDING" && ["WITHDRAW", "RESTORE", "DELETE", "SUPPLEMENT"].includes(action);
    if (!proposal || !personal && !session) return;
    if (action === "DELETE" && !window.confirm("删除这条教学偏好？删除后老师不再使用；如果只是暂时关闭，可以选择停用。")) return;
    const feedback = (this.drafts.get(id) ?? "").trim();
    const root = this.node.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? this.management.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? this.management;
    const status = root.querySelector<HTMLElement>("[data-status]");
    if (feedback && action === "CONFIRM") {if (status) status.textContent = "已有补充意见，请使用“提交意见”，修订后再确认。"; return;}
    if (action === "SUPPLEMENT" && !feedback) {root.querySelector("textarea")?.focus(); return;}
    const key = JSON.stringify([id, proposal.revision, action, action === "SUPPLEMENT" ? feedback : ""]);
    const requestId = this.requestIds.get(key) ?? crypto.randomUUID(); this.requestIds.set(key, requestId);
    this.busy = true;
    for (const node of root.querySelectorAll<HTMLButtonElement>("button")) node.disabled = true;
    try {
      const response = await fetch(personal ? `/api/web/teaching/${encodeURIComponent(id)}/decision` : `/api/web/sessions/${encodeURIComponent(session!)}/teaching/${encodeURIComponent(id)}/decision`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({expected_revision: proposal.revision, action, feedback: action === "SUPPLEMENT" ? feedback : "", request_id: requestId}),
      });
      if (!response.ok) {const value = await response.json(); throw new Error(value.detail ?? "未能保存，请重试。");}
      if (session !== this.session) return;
      this.drafts.delete(id);
      this.signature = "";
      await this.refresh(session, !this.node.hidden);
      this.changed();
    } catch (error) {if (status) status.textContent = error instanceof Error ? error.message : "未能保存，请重试。";}
    finally {this.busy = false; for (const node of root.querySelectorAll<HTMLButtonElement>("button")) node.disabled = false;}
  }
}
