import { readCodeSpan, renderMarkdown } from "./markdown";

export function plainTextSummary(value: string, limit = 100): string {
  const prose = (text: string) => text
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|[\s([{，。：；！？])\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*(?=$|[\s)\]},.，。：；！？])/gu, "$1$2")
    .replace(/(^|[\s([{，。：；！？])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s)\]},.，。：；！？])/gu, "$1$2");
  // 代码先独立处理；不能把乘法、指针、幂或标识符中的符号当作排版删掉。
  const inline = (line: string) => {
    const pieces: string[] = [];
    let start = 0, cursor = 0;
    const budget = {remaining: Math.max(1024, line.length * 8)};
    while (cursor < line.length) {
      if (line[cursor] !== "`") {cursor++;continue;}
      const span = readCodeSpan(line, cursor, budget);
      if (!span) {cursor += /^`+/.exec(line.slice(cursor))![0].length;continue;}
      pieces.push(prose(line.slice(start, cursor)), span.content);
      start = cursor = span.end;
    }
    pieces.push(prose(line.slice(start)));
    return pieces.join("");
  };
  let fence = "";
  const lines: string[] = [];
  for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = "";
      else lines.push(line);
    } else if (marker) fence = marker[1]!;
    else lines.push(inline(line));
  }
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return Array.from(text).length > limit ? `${Array.from(text).slice(0, limit).join("")}…` : text;
}

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));
const labels: Record<string, string> = {"问题":"问题", "实际帮助":"帮助", "帮助":"帮助", "区别在于":"结论", "结论":"结论"};

/** 只按已有明确字段拆分，不替学习记录生成结论，也不把有帮助的练习标成独立完成。 */
export function recordSections(description: string): {label: string; text: string}[] {
  const sections: {label: string; text: string}[] = [];
  const lines = description.split("\n");
  let fence = "";
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker) { fence = fence === marker ? "" : fence || marker; }
    const parts = fence || marker ? [line] : line.split(/(?<=[；;])\s*(?=(?:问题|实际帮助|帮助|区别在于|结论)[：:])/u);
    for (const part of parts) {
      const match = !fence && !marker ? /^(问题|实际帮助|帮助|区别在于|结论)[：:]\s*(.*)$/u.exec(part.trimStart()) : null;
      if (match) sections.push({label: labels[match[1]!]!, text: match[2]!});
      else if (sections.length) sections[sections.length - 1]!.text += `\n${part}`;
      else sections.push({label: "记录", text: part});
    }
  }
  return sections.filter(section => section.text.trim());
}

export function learningRecordMarkup(record: {id?: string; description: string; evidence_type: string; assistance_level: string}): string {
  const kind = ({EXPLAIN:"解释", EXPLANATION:"解释", BUILD:"练习", DEBUG:"排查", TRANSFER:"迁移应用"} as Record<string,string>)[record.evidence_type] ?? "学习记录";
  const help = ({WITH_HELP:"帮助后完成", WITH_HINT:"提示后完成", WITH_REFERENCE:"参考资料完成", INDEPENDENT:"独立完成", NONE:"独立完成", TRANSFERRED:"迁移应用"} as Record<string,string>)[record.assistance_level] ?? "学习过程";
  const sections = recordSections(record.description);
  const preview = sections.map(section => `${section.label}：${plainTextSummary(section.text, 200)}`).join("　");
  return `<details class="learning-record"${record.id ? ` data-disclosure-key="evidence:${escape(record.id)}"` : ""}><summary><span class="learning-record-meta"><span>${kind}</span><span>${help}</span></span><span class="learning-record-preview">${escape(preview)}</span><span class="learning-record-toggle"><span class="learning-record-expand">展开记录</span><span class="learning-record-collapse">收起记录</span></span></summary><dl>${sections.map(section => `<div><dt>${section.label}</dt><dd class="reading-content">${renderMarkdown(section.text)}</dd></div>`).join("")}</dl></details>`;
}
