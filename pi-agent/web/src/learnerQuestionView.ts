import type { LearnerQuestionRequest, LearnerQuestionReply } from "../../src/learnerQuestionTypes";
import { icon } from "./icons";
import { renderMarkdown } from "./markdown";
import { learnerQuestionPrompt } from "../../src/learnerQuestionPrompt";
import type { VoiceInputMetadata } from "./voiceInput";

type Draft = { selected: string[]; other: string; voice_input?: VoiceInputMetadata; voiceExpectedOther?: string };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** 题面保持原文；代码结构由来源 Markdown 明确声明，展示层不猜测或补写。 */
export function questionMarkdown(value: string): string {
  return value;
}

// 选项草稿只属于当前题目的页面状态；发出前不会成为学习事实。
export class LearnerQuestionView {
  readonly node = document.createElement("section");
  private request: LearnerQuestionRequest | null = null;
  private renderedRequest = "";
  private busy = false;
  private readonly positions = new Map<string, number>();
  private readonly drafts = new Map<string, Map<string, Draft>>();
  private readonly editedRequests = new Set<string>();
  private readonly masteryFeedback = new Set<string>();
  constructor(private readonly submit: () => void, goBack: () => void) {
    this.node.id = "learner-questions";
    this.node.className = "learner-questions";
    this.node.setAttribute("aria-label", "待回答的问题");
    this.node.addEventListener("click", event => {
      if (!this.busy && (event.target as Element).closest("[data-question-back]")) goBack();
      if (!this.busy && (event.target as Element).closest("[data-question-submit]")) {
        if (this.request?.purpose === "CONFIRM_MASTERY" && !this.request.applied_reply) this.draft(this.request.questions[0]!.id).selected = ["revise"];
        this.submit(); return;
      }
      const action = (event.target as Element).closest<HTMLButtonElement>("[data-question-action]");
      if (!action || this.busy || !this.request) return;
      this.editedRequests.add(this.request.id);
      // 动作按钮是用户显式提交；补充说明一起发送，服务端不会据此自动同意。
      const draft = this.draft(this.request.questions[0]!.id);
      if (this.request.purpose === "CONFIRM_MASTERY" && action.dataset.questionAction === "revise") {
        // 自述欠缺属于学习意图，先展开草稿，不把一次展开当作提交或确认。
        draft.selected = ["revise"];
        this.masteryFeedback.add(this.request.id);
        this.render(this.request, this.busy);
        this.node.querySelector<HTMLTextAreaElement>("textarea")?.focus();
        return;
      }
      draft.selected = [action.dataset.questionAction!];
      this.submit();
      // 提交校验失败时不保留隐形选中，随后单独发送补充仍只是补充。
      draft.selected = [];
    });
    this.node.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (!input.matches("input[data-question]")) return;
      if (this.request) this.editedRequests.add(this.request.id);
      const draft = this.draft(input.dataset.question!);
      const inputs = [...this.node.querySelectorAll<HTMLInputElement>("input[data-question]")].filter((node) => node.dataset.question === input.dataset.question);
      draft.selected = inputs.filter((node) => node.checked).map((node) => node.value);
    });
    this.node.addEventListener("input", (event) => {
      const input = event.target as HTMLTextAreaElement;
      if (input.matches("textarea[data-question]")) {
        if (this.request) this.editedRequests.add(this.request.id);
        const draft = this.draft(input.dataset.question!);
        draft.other = input.value;
        if (draft.voice_input && draft.voiceExpectedOther !== input.value) draft.voice_input.transcriptEdited = true;
      }
    });
  }
  get pending(): boolean { return Boolean(this.request); }
  captureDraft() {
    return this.request ? {requestId: this.request.id, position: this.position, answers: [...(this.drafts.get(this.request.id) ?? [])]} : null;
  }
  restoreDraft(value: ReturnType<LearnerQuestionView["captureDraft"]>): void {
    if (!value || typeof value.requestId !== "string" || !Array.isArray(value.answers) || !Number.isInteger(value.position)) return;
    // 刷新/重连的旧快照可能迟于输入到达；保留用户本页已经编辑的答案，包括主动清空。
    if (this.editedRequests.has(value.requestId)) return;
    const answers = value.answers.filter(entry => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [id, draft] = entry;
      return typeof id === "string" && draft && typeof draft.other === "string" && draft.other.length <= 4000 &&
        Array.isArray(draft.selected) && draft.selected.every(v => typeof v === "string");
    });
    this.drafts.set(value.requestId, new Map(answers));
    this.positions.set(value.requestId, Math.max(0, Math.min(9, value.position)));
    this.renderedRequest = "";
  }
  get currentQuestionKey(): string { return this.request ? `${this.request.id}:${this.request.questions[this.position]?.id ?? ""}` : ""; }
  get lastQuestion(): boolean { return !this.request || this.position >= this.request.questions.length - 1; }
  private get position(): number { return this.request ? Math.min(this.request.questions.length - 1, this.positions.get(this.request.id) ?? 0) : 0; }
  private addComposerAnswer(text: string, voiceInput?: VoiceInputMetadata): void {
    if (!this.request || !text.trim()) return;
    this.editedRequests.add(this.request.id);
    const draft = this.draft(this.request.questions[this.position]!.id);
    const other = [draft.other.trim(), text.trim()].filter(Boolean).join("\n");
    if (other.length > 4000) throw new Error("这一题的补充最多 4000 字，请缩短后继续。");
    draft.other = other;
    if (voiceInput) {
      // 逐题草稿必须携带真实输入来源，最后统一提交时不能把口述变成独立书面作答。
      draft.voice_input = { source: "voice", transcriptEdited: Boolean(draft.voice_input?.transcriptEdited || voiceInput.transcriptEdited) };
      draft.voiceExpectedOther = other;
    }
  }
  previous(composerText: string, voiceInput?: VoiceInputMetadata): void {
    if (!this.request || this.busy || this.position === 0) return;
    this.addComposerAnswer(composerText, voiceInput);
    this.positions.set(this.request.id, this.position - 1);
    this.render(this.request, this.busy);
  }
  private draft(id: string): Draft {
    const requestId = this.request!.id;
    let group = this.drafts.get(requestId);
    if (!group) { group = new Map(); this.drafts.set(requestId, group); }
    let draft = group.get(id);
    if (!draft) { draft = { selected: [], other: "" }; group.set(id, draft); }
    return draft;
  }
  render(request: LearnerQuestionRequest | null, busy: boolean): void {
    this.request = request;
    this.busy = busy;
    this.node.hidden = !request;
    if (!request) { this.node.innerHTML = ""; this.renderedRequest = ""; delete this.node.dataset.readingKey; return; }
    this.node.dataset.readingKey = `question:${this.currentQuestionKey}`;
    const index = this.position;
    const decision = request.purpose === "CONFIRM_GOAL" || request.purpose === "START_LEARNING"
      || request.purpose === "CONFIRM_PLAN_REVISION" || request.purpose === "CONFIRM_MASTERY";
    this.node.classList.toggle("learner-decision", decision);
    this.node.classList.toggle("learner-mastery-review", request.purpose === "CONFIRM_MASTERY");
    const signature = `${JSON.stringify(request)}:${index}:${this.masteryFeedback.has(request.id)}`;
    // 同一题的状态刷新只更新可操作性，保留焦点、光标和原生键盘选择。
    if (signature === this.renderedRequest) {
      const status = this.node.querySelector(".learner-question-status");
      if (status) status.textContent = busy ? "处理中" : "待作答";
      this.node.querySelectorAll("fieldset").forEach(node => { node.disabled = busy; });
      this.node.querySelectorAll<HTMLButtonElement>("button").forEach(node => { node.disabled = busy; });
      return;
    }
    this.renderedRequest = signature;
    const q = request.questions[index]!;
    const prompt = renderMarkdown(questionMarkdown(learnerQuestionPrompt(request, q.prompt)));
    const draft = this.draft(q.id);
    if (request.purpose === "CONFIRM_MASTERY") {
      if (request.applied_reply) {
        // 已保存的真实选择可跨刷新恢复；继续只重送同一回执，不凭空选项或重新确认掌握。
        const accepted = this.displayReply(request.applied_reply, "");
        this.node.setAttribute("aria-label", "已保存的本节学习选择");
        this.node.innerHTML = `<fieldset ${busy ? "disabled" : ""}><legend>本节学习回顾</legend><h3 class="learner-mastery-title">你的选择已保存</h3><p class="learner-mastery-saved">${escape(accepted)}</p><p class="learner-mastery-note">继续课堂，老师会根据你刚才的选择接着教。</p><div class="learner-decision-actions"><button type="button" class="primary-button learner-decision-action" data-question-submit>继续课堂</button></div></fieldset>`;
        return;
      }
      const feedbackOpen = this.masteryFeedback.has(request.id);
      const feedbackId = `mastery-feedback-${request.id}`;
      this.node.setAttribute("aria-label", "本节学习回顾");
      const actions = q.options.map(option => `<button type="button" class="${option.id === "proceed" ? "primary-button" : option.id === "skip" ? "learner-mastery-skip" : "secondary-button"} learner-decision-action" data-question-action="${escape(option.id)}"${option.id === "revise" ? ` aria-expanded="${feedbackOpen}" aria-controls="${escape(feedbackId)}"` : ""}>${escape(option.label)}</button>`).join("");
      this.node.innerHTML = `<fieldset ${busy ? "disabled" : ""}><legend>本节学习回顾</legend><h3 class="learner-mastery-title">${escape(request.title || "这一节，你觉得掌握了吗？")}</h3><div class="reading-content learner-question-prompt">${prompt}</div><p class="learner-mastery-note">由你确认是否掌握，也可以先继续，之后再回来补学。</p><div class="learner-decision-actions">${actions}</div><div class="learner-mastery-feedback" id="${escape(feedbackId)}" ${feedbackOpen ? "" : "hidden"}><label class="learner-other"><span>还有哪里不清楚？</span><textarea rows="2" maxlength="4000" data-question="${escape(q.id)}" placeholder="例如：能看懂例子，但还不清楚什么时候使用……">${escape(draft.other)}</textarea></label><div class="learner-question-actions"><button type="button" class="secondary-button" data-question-submit>告诉老师</button></div></div></fieldset>`;
      return;
    }
    if (decision) {
      const label = request.purpose === "CONFIRM_GOAL" ? "确认学习目标"
        : request.purpose === "START_LEARNING" ? "开始学习" : "确认学习计划修订";
      this.node.setAttribute("aria-label", label);
      const actions = q.options.map(option => `<button type="button" class="${option.id === "proceed" ? "primary-button" : "secondary-button"} learner-decision-action" data-question-action="${escape(option.id)}">${escape(option.label)}</button>`).join("");
      this.node.innerHTML = `<fieldset ${busy ? "disabled" : ""}><legend>${label}</legend><div class="reading-content learner-question-prompt">${prompt}</div><div class="learner-decision-actions">${actions}</div><label class="learner-other"><span>想调整，可以在这里补充说明</span><textarea rows="1" maxlength="4000" data-question="${escape(q.id)}" placeholder="补充你的想法……">${escape(draft.other)}</textarea></label><div class="learner-question-actions"><button type="button" class="secondary-button" data-question-submit>发送补充</button></div></fieldset>`;
      return;
    }
    this.node.setAttribute("aria-label", "待回答的问题");
    const progress = request.questions.length > 1 ? `<div class="learner-question-progress">${index > 0 ? `<button type="button" data-question-back aria-label="上一题" title="上一题" ${busy ? "disabled" : ""}>${icon("arrowRight")}</button>` : ""}<span>问题 ${index + 1} / ${request.questions.length} · 最后提交才会发送</span></div>` : "";
    const freeform = q.selection === "freeform";
    const intro = request.review_topic_id ? "回顾一个之前的知识点，答完就继续往下学。" : request.purpose === "BACKGROUND" ? "选最接近你的情况，也可以自己补充。" : request.purpose === "PRACTICE_SET" ? (request.instructions || "完成这一组练习，全部答完后统一提交。") : freeform ? "用自己的话回答，也可以在下方输入框写代码。" : "选择你的判断，也可以补充理由或直接回答。";
    const setTitle = request.purpose === "PRACTICE_SET" && request.title ? `<h3 class="learner-question-set-title">${escape(request.title)}</h3>` : "";
    this.node.innerHTML = `<div class="learner-question-status">${busy ? "题目已准备好" : "待作答"}</div>${setTitle}${progress}<p class="learner-question-intro">${escape(intro)}</p><fieldset ${busy ? "disabled" : ""} data-question-group="${escape(q.id)}"><legend>第 ${index + 1} 题${q.selection === "multiple" ? '<span class="learner-question-mode">可多选</span>' : ""}</legend><div class="reading-content learner-question-prompt">${prompt}</div>${freeform ? "" : `<div class="learner-options">${q.options.map((option) => `<label class="learner-option"><input type="${q.selection === "single" ? "radio" : "checkbox"}" name="learner-${index}" data-question="${escape(q.id)}" value="${escape(option.id)}" ${draft.selected.includes(option.id) ? "checked" : ""}><span><strong>${escape(option.label)}</strong>${option.description ? `<small>${escape(option.description)}</small>` : ""}</span></label>`).join("")}</div>`}<label class="learner-other"><span>${freeform ? "你的回答" : "补充或自己回答"}</span><textarea rows="${freeform ? 3 : 1}" maxlength="4000" data-question="${escape(q.id)}" placeholder="${freeform ? "写下你的判断和理由……" : "也可以按自己的情况说……"}">${escape(draft.other)}</textarea></label></fieldset><div class="learner-question-actions"><span class="muted">答案在本题卡提交；也可以先在对话框回复老师。</span><button type="button" class="primary-button" data-question-submit ${busy ? "disabled" : ""}>${this.lastQuestion ? request.questions.length > 1 ? "提交整组答案" : "提交回答" : "下一题"}</button></div>`;
  }
  collect(composerText: string, voiceInput?: VoiceInputMetadata): LearnerQuestionReply | undefined {
    if (!this.request) return;
    if (this.request.purpose === "CONFIRM_MASTERY" && this.request.applied_reply) return structuredClone(this.request.applied_reply);
    // 逐题步骤只维护页面草稿；最后一题通过完整性检查，才返回可发送的整批回答。
    this.addComposerAnswer(composerText, voiceInput);
    const current = this.draft(this.request.questions[this.position]!.id);
    if (this.request.purpose === "CONFIRM_MASTERY" && current.other.trim() && current.selected[0] !== "revise") {
      throw new Error("你还有未发送的欠缺说明，请先告诉老师，或清空说明后再继续。");
    }
    if (!current.selected.length && !current.other.trim()) {
      this.node.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      throw new Error("请选择一项或写下自己的回答。");
    }
    if (!this.lastQuestion) {
      this.positions.set(this.request.id, this.position + 1);
      this.render(this.request, this.busy);
      this.node.scrollIntoView({ block: "nearest" });
      this.node.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
      return;
    }
    const answers = this.request.questions.map((q) => {
      const draft = this.draft(q.id);
      return { question_id: q.id, selected_option_ids: draft.selected, other_text: draft.other.trim(), ...(draft.voice_input ? { voice_input: draft.voice_input } : {}) };
    });
    const missing = answers.find((a) => !a.selected_option_ids.length && !a.other_text);
    if (missing) {
      this.positions.set(this.request.id, answers.indexOf(missing));
      this.render(this.request, this.busy);
      this.node.querySelector<HTMLTextAreaElement>(`textarea[data-question="${CSS.escape(missing.question_id)}"]`)?.focus();
      throw new Error("请补齐这一题，全部答完后再提交。");
    }
    return { request_id: this.request.id, answers };
  }
  displayReply(reply: LearnerQuestionReply, extra: string): string {
    const request = this.request!;
    return reply.answers.map((a) => {
      const q = request.questions.find((q) => q.id === a.question_id)!;
      const selections = a.selected_option_ids.map((id) => q.options.find((o) => o.id === id)!.label).join("；");
      if (request.purpose === "CONFIRM_GOAL" || request.purpose === "START_LEARNING" || request.purpose === "CONFIRM_PLAN_REVISION" || request.purpose === "CONFIRM_MASTERY") return [selections, a.other_text].filter(Boolean).join("\n");
      return `${q.prompt}\n${selections ? `选择：${selections}` : ""}${selections && a.other_text ? "\n" : ""}${a.other_text ? `补充：${a.other_text}` : ""}`;
    }).join("\n\n") + (extra.trim() ? `\n\n另外：${extra.trim()}` : "");
  }
}
