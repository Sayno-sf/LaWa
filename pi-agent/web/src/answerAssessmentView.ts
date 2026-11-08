import type { AnswerAssessmentCard } from "../../src/answerAssessmentTypes.js";
import {icon} from "./icons.js";

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]!));

export function answerAssessmentMarkup(a: AnswerAssessmentCard, history = false, collapsed = false): string {
  const status = a.score >= 8 ? "本题表现扎实" : a.score >= 6 ? "基本到位，还有缺口" : "需要巩固";
  const help: Record<string, string> = {WITH_HINT: "使用了提示", WITH_REFERENCE: "参考后完成", WITH_HELP: "获得了实质帮助", UNKNOWN: "帮助情况待核对"};
  const followUp = a.follow_up === "SECURE" ? "这个知识点暂不重复讲解。"
    : a.follow_up === "RECHECK" ? "后续自然用到时，再观察这个知识点。" : "继续往下学，后续用到时针对缺口补充。";
  const heading = `<div><h3>${escape(a.topic)}</h3><p class="assessment-status ${a.score >= 8 ? "is-strong" : "is-developing"}">${status}${help[a.assistance_level] ? `<span>${help[a.assistance_level]}</span>` : ""}</p></div><p class="assessment-score"><strong>${a.score}</strong><span>/ 10</span><small>本题得分</small></p>`;
  // 课堂里的评分卡可收起：看完收起只留标题、状态与得分；历史回看仍由学习库外层折叠控制。
  if (!history) return `<details class="answer-assessment" data-assessment-id="${escape(a.id)}"${collapsed ? "" : " open"} aria-label="本次作答评分 ${a.score} 分，满分 10 分">
    <summary class="assessment-heading" title="展开或收起评分依据">${heading}<span class="assessment-chevron" aria-hidden="true">${icon("chevronDown")}</span></summary>
    <div class="assessment-body">
      <p class="assessment-summary">${escape(a.summary)}</p>
      ${a.correction_reason ? `<p class="assessment-summary"><strong>评价已更正：</strong>${escape(a.correction_reason)}</p>` : ""}
      <table class="assessment-rubric"><caption>评分依据</caption><thead><tr><th scope="col">评分点</th><th scope="col">得分</th></tr></thead><tbody>${a.criteria.map(c => `<tr><th scope="row">${escape(c.label)}<small>${escape(c.feedback)}</small></th><td>${c.earned}<span> / ${c.possible}</span></td></tr>`).join("")}</tbody></table>
      <p class="assessment-follow-up">已保存到学习记录。${followUp}</p>
    </div>
  </details>${a.strengths.length || a.gaps.length ? `<div class="assessment-prose">
    ${a.strengths.length ? `<p><strong>做到了：</strong>${a.strengths.map(escape).join("；")}</p>` : ""}
    ${a.gaps.length ? `<p><strong>再补一点：</strong>${a.gaps.map(escape).join("；")}</p>` : ""}
  </div>` : ""}`;
  return `<section class="answer-assessment${history ? " answer-assessment-history" : ""}" data-assessment-id="${escape(a.id)}" aria-label="本次作答评分 ${a.score} 分，满分 10 分">
    <header class="assessment-heading">${heading}</header>
    <p class="assessment-summary">${escape(a.summary)}</p>
    ${a.correction_reason ? `<p class="assessment-summary"><strong>评价已更正：</strong>${escape(a.correction_reason)}</p>` : ""}
    ${history ? `<p class="assessment-question"><strong>题目</strong><span>${escape(a.question)}</span></p>` : ""}
    <table class="assessment-rubric"><caption>评分依据</caption><thead><tr><th scope="col">评分点</th><th scope="col">得分</th></tr></thead><tbody>${a.criteria.map(c => `<tr><th scope="row">${escape(c.label)}<small>${escape(c.feedback)}</small></th><td>${c.earned}<span> / ${c.possible}</span></td></tr>`).join("")}</tbody></table>
    <p class="assessment-follow-up">${history ? "当时的安排：" : "已保存到学习记录。"}${followUp}</p>
  </section>${a.strengths.length || a.gaps.length ? `<div class="assessment-prose">
    ${a.strengths.length ? `<p><strong>做到了：</strong>${a.strengths.map(escape).join("；")}</p>` : ""}
    ${a.gaps.length ? `<p><strong>再补一点：</strong>${a.gaps.map(escape).join("；")}</p>` : ""}
  </div>` : ""}`;
}

export function assessmentHistoryMarkup(assessments: AnswerAssessmentCard[]): string {
  if (!assessments.length) return "";
  return `<section class="library-assessments"><h5>答题表现</h5>${[...assessments].reverse().map(a => `<details class="library-assessment-item" data-disclosure-key="assessment:${escape(a.id)}"><summary><span class="assessment-history-topic">${icon("chevronDown", "assessment-disclosure")}${escape(a.topic)}</span><strong>${a.score}<small> / 10</small></strong><time datetime="${escape(a.created_at)}">${escape(new Date(a.created_at).toLocaleDateString("zh-CN"))}</time></summary>${answerAssessmentMarkup(a, true)}</details>`).join("")}</section>`;
}
