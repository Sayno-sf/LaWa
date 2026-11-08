import {figureKey} from "../../skills/lawa-illustrated-lesson/assets/ink.mjs";
import * as katex from "katex";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ]!,
  );
}

const MAX_NESTING_DEPTH = 12;
const MATH_OPTIONS = { throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20 };
type ParseBudget = { remaining: number };

function parseBudget(value: string): ParseBudget {
  return { remaining: Math.max(1024, value.length * 8) };
}

function spendParseWork(budget: ParseBudget | undefined, amount = 1): boolean {
  if (!budget) return true;
  budget.remaining -= amount;
  return budget.remaining >= 0;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && value[--index] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

export function readCodeSpan(value: string, start: number, budget?: ParseBudget): { content: string; end: number } | null {
  if (budget && budget.remaining <= 0) return null;
  const marker = /^`+/.exec(value.slice(start))?.[0];
  if (!marker) return null;
  if (!spendParseWork(budget, marker.length)) return null;
  let cursor = start + marker.length;
  while (cursor < value.length) {
    const next = value.indexOf("`", cursor);
    if (!spendParseWork(budget, (next < 0 ? value.length : next) - cursor + 1) || next < 0) return null;
    const candidate = /^`+/.exec(value.slice(next))![0];
    if (!spendParseWork(budget, candidate.length)) return null;
    if (candidate.length === marker.length) {
      return { content: value.slice(start + marker.length, next), end: next + marker.length };
    }
    cursor = next + candidate.length;
  }
  return null;
}

function readInlineMath(value: string, start: number, budget?: ParseBudget): { source: string; tex: string; end: number } | null {
  if (budget && budget.remaining <= 0) return null;
  const marker = value.startsWith("\\(", start) ? "\\(" : value[start] === "$" && value[start + 1] !== "$" && value[start - 1] !== "$" ? "$" : null;
  if (!marker) return null;
  const closing = marker === "$" ? "$" : "\\)";
  let end = value.indexOf(closing, start + marker.length);
  if (!spendParseWork(budget, (end < 0 ? value.length : end) - start)) return null;
  while (end >= 0 && (isEscaped(value, end) || (closing === "$" && (value[end + 1] === "$" || value[end - 1] === "$")))) {
    const previous = end;
    end = value.indexOf(closing, end + closing.length);
    if (!spendParseWork(budget, (end < 0 ? value.length : end) - previous)) return null;
  }
  if (end < 0 || !value.slice(start + marker.length, end).trim()) return null;
  return { source: value.slice(start, end + closing.length), tex: value.slice(start + marker.length, end), end: end + closing.length };
}

function readLink(value: string, start: number, budget: ParseBudget): { label: string; destination: string; end: number } | null {
  if (budget.remaining <= 0) return null;
  if (value[start] !== "[" || value[start - 1] === "!") return null;
  let brackets = 1;
  let cursor = start + 1;
  for (; cursor < value.length; cursor += 1) {
    if (!spendParseWork(budget)) return null;
    if (value[cursor] === "\\") { cursor += 1; continue; }
    if (value[cursor] === "`") {
      const code = readCodeSpan(value, cursor, budget);
      if (code) { cursor = code.end - 1; continue; }
    }
    if (value[cursor] === "[") brackets += 1;
    if (value[cursor] === "]" && --brackets === 0) break;
  }
  if (brackets !== 0 || value[cursor + 1] !== "(") return null;
  const label = value.slice(start + 1, cursor);
  const destinationStart = cursor + 2;
  let parentheses = 1;
  for (cursor = destinationStart; cursor < value.length; cursor += 1) {
    if (!spendParseWork(budget)) return null;
    if (value[cursor] === "\\") { cursor += 1; continue; }
    if (value[cursor] === "(") parentheses += 1;
    if (value[cursor] === ")" && --parentheses === 0) break;
  }
  if (parentheses !== 0) return null;
  let destination = value.slice(destinationStart, cursor).trim();
  if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1);
  destination = destination.replace(/\\([()])/g, "$1");
  return { label, destination, end: cursor + 1 };
}

function safeLinkDestination(value: string): boolean {
  // 工作区使用 hash 导航，裸锚点不作为内容链接；仅允许显式网络/邮件协议。
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function findEmphasisEnd(value: string, start: number, marker: string, budget: ParseBudget): number {
  let cursor = start;
  while (cursor < value.length) {
    if (!spendParseWork(budget)) return -1;
    if (value[cursor] === "\\" && !value.startsWith("\\(", cursor)) { cursor += 2; continue; }
    const code = value[cursor] === "`" ? readCodeSpan(value, cursor, budget) : null;
    const math = readInlineMath(value, cursor, budget);
    const link = value[cursor] === "[" ? readLink(value, cursor, budget) : null;
    const protectedEnd = code?.end ?? math?.end ?? link?.end;
    if (protectedEnd) { cursor = protectedEnd; continue; }
    if (value[cursor] === "*") {
      const run = /^\*+/.exec(value.slice(cursor))![0].length;
      // 单星号跳过内部的双星号；结尾 *** 可同时关闭内部强调与外部加粗。
      if (run >= marker.length && (marker.length !== 1 || run % 2 === 1) && !/\s/.test(value[cursor - 1] ?? "")) {
        return cursor + run - marker.length;
      }
      cursor += run;
    } else cursor += 1;
  }
  return -1;
}

function inlineMarkdown(value: string, depth = 0, allowLinks = true, budget = parseBudget(value)): string {
  if (depth >= MAX_NESTING_DEPTH) return escapeHtml(value);
  const output: string[] = [];
  let cursor = 0;
  // 不使用可由原文伪造的占位符。原文只在输出边界转义，代码与公式优先独立处理。
  while (cursor < value.length) {
    // 未完成的长括号/公式不能在每次流式更新中反复扫描剩余原文，预算耗尽后保持可读文本。
    if (!spendParseWork(budget)) { output.push(escapeHtml(value.slice(cursor))); break; }
    if (value[cursor] === "`") {
      const code = readCodeSpan(value, cursor, budget);
      if (!code) { output.push(escapeHtml(value.slice(cursor))); break; }
      output.push(`<code>${escapeHtml(code.content)}</code>`);
      cursor = code.end;
      continue;
    }
    const math = readInlineMath(value, cursor, budget);
    if (math) {
      try {
        output.push(katex.renderToString(math.tex.trim(), MATH_OPTIONS));
      } catch {
        output.push(escapeHtml(math.source));
      }
      cursor = math.end;
      continue;
    }
    if (["\\(", "\\)", "\\[", "\\]"].some((marker) => value.startsWith(marker, cursor))) {
      output.push(escapeHtml(value.slice(cursor, cursor + 2)));
      cursor += 2;
      continue;
    }
    if (value[cursor] === "\\" && /[\\`*\[\]()$]/.test(value[cursor + 1] ?? "")) {
      output.push(escapeHtml(value[cursor + 1]!));
      cursor += 2;
      continue;
    }
    const link = value[cursor] === "[" ? readLink(value, cursor, budget) : null;
    if (link) {
      if (allowLinks && safeLinkDestination(link.destination)) {
        output.push(`<a href="${escapeHtml(link.destination)}" target="_blank" rel="noopener noreferrer">${inlineMarkdown(link.label, depth + 1, false, budget)}</a>`);
      } else output.push(escapeHtml(value.slice(cursor, link.end)));
      cursor = link.end;
      continue;
    }
    if (value[cursor] === "*") {
      const run = /^\*+/.exec(value.slice(cursor))![0].length;
      const marker = "*".repeat(Math.min(run, 3));
      const end = !/\s/.test(value[cursor + marker.length] ?? " ") ? findEmphasisEnd(value, cursor + marker.length, marker, budget) : -1;
      if (end > cursor + marker.length) {
        const content = inlineMarkdown(value.slice(cursor + marker.length, end), depth + 1, allowLinks, budget);
        output.push(marker.length === 3 ? `<strong><em>${content}</em></strong>` : marker.length === 2 ? `<strong>${content}</strong>` : `<em>${content}</em>`);
        cursor = end + marker.length;
        continue;
      }
      output.push(marker);
      cursor += marker.length;
      continue;
    }
    output.push(escapeHtml(value[cursor]!));
    cursor += 1;
  }
  return output.join("");
}

type TableAlignment = "left" | "center" | "right" | null;

function splitTableRow(line: string): string[] | null {
  let source = line.trim();
  if (!source.includes("|")) return null;
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  const budget = parseBudget(source);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      cell += character === "|" ? "|" : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      const code = readCodeSpan(source, index, budget);
      if (code) {
        cell += source.slice(index, code.end);
        index = code.end - 1;
        continue;
      }
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function parseTableDelimiter(line: string): TableAlignment[] | null {
  const cells = splitTableRow(line);
  if (!cells || cells.some((cell) => !/^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))) {
    return null;
  }
  return cells.map((cell) => {
    const normalized = cell.replace(/\s/g, "");
    if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
    if (normalized.endsWith(":")) return "right";
    if (normalized.startsWith(":")) return "left";
    return null;
  });
}

function renderTableCell(tag: "th" | "td", value: string, alignment: TableAlignment): string {
  const className = alignment ? ` class="table-align-${alignment}"` : "";
  return `<${tag}${className}>${inlineMarkdown(value)}</${tag}>`;
}

function renderTable(lines: string[], startIndex: number): { html: string; nextIndex: number } | null {
  const header = splitTableRow(lines[startIndex] ?? "");
  const alignments = parseTableDelimiter(lines[startIndex + 1] ?? "");
  if (!header || !alignments || header.length !== alignments.length) return null;

  const body: string[][] = [];
  let nextIndex = startIndex + 2;
  while (nextIndex < lines.length && lines[nextIndex]!.trim()) {
    const row = splitTableRow(lines[nextIndex]!);
    if (!row) break;
    body.push(Array.from({ length: header.length }, (_, index) => row[index] ?? ""));
    nextIndex += 1;
  }

  const headHtml = header
    .map((cell, index) => renderTableCell("th", cell, alignments[index] ?? null))
    .join("");
  const bodyHtml = body
    .map(
      (row) =>
        `<tr>${row.map((cell, index) => renderTableCell("td", cell, alignments[index] ?? null)).join("")}</tr>`,
    )
    .join("");
  return {
    html: `<div class="markdown-table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    nextIndex,
  };
}

type ListMarker = { indentation: number; tag: "ul" | "ol"; start: number; content: string };

function readListMarker(line: string): ListMarker | null {
  const match = /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(.+)$/.exec(line);
  if (!match) return null;
  return {
    indentation: match[1]!.replace(/\t/g, "    ").length,
    tag: /^\d/.test(match[2]!) ? "ol" : "ul",
    start: Number.parseInt(match[2]!, 10) || 1,
    content: match[3]!,
  };
}

function renderList(lines: string[], startIndex: number, depth: number): { html: string; nextIndex: number } {
  const first = readListMarker(lines[startIndex]!)!;
  const start = first.tag === "ol" && first.start !== 1 ? ` start="${first.start}"` : "";
  const output = [`<${first.tag}${start}>`];
  let index = startIndex;
  while (index < lines.length) {
    const item = readListMarker(lines[index]!);
    if (!item || item.indentation !== first.indentation || item.tag !== first.tag) break;
    output.push(`<li>${inlineMarkdown(item.content)}`);
    index += 1;
    while (index < lines.length) {
      const nested = readListMarker(lines[index]!);
      if (nested && nested.indentation > first.indentation && depth + 1 < MAX_NESTING_DEPTH) {
        const list = renderList(lines, index, depth + 1);
        output.push(list.html);
        index = list.nextIndex;
      } else if (!nested && lines[index]!.trim() && (lines[index]!.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0) > first.indentation) {
        output.push(`<br>${inlineMarkdown(lines[index]!.trim())}`);
        index += 1;
      } else break;
    }
    output.push("</li>");
  }
  output.push(`</${first.tag}>`);
  return { html: output.join(""), nextIndex: index };
}

type FigureLine = (line:string)=>string|undefined;
function renderTextLines(text: string, depth = 0, figureLine?:FigureLine): string {
  if (depth >= MAX_NESTING_DEPTH) return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index]!;
    const line = raw.trimEnd();
    const figure=depth===0 && figureLine?.(line);
    if (figure) {output.push(figure);index++;continue;}
    if (line.trimStart().startsWith("![") && figureKey(line)) {
      const marker=line.trim();
      output.push("<p>"+escapeHtml(marker.slice(2,marker.lastIndexOf("](lawa-figure:")))+"</p>");
      index++;continue;
    }
    const table = renderTable(lines, index);
    if (table) {
      output.push(table.html);
      index = table.nextIndex;
      continue;
    }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }
    if (readListMarker(line)) {
      const list = renderList(lines, index, depth);
      output.push(list.html);
      index = list.nextIndex;
      continue;
    }
    if (/^ {0,3}> ?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}> ?/.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(/^ {0,3}> ?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${renderTextLines(quoted.join("\n"), depth + 1)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      output.push('<div class="paragraph-gap"></div>');
    } else if (/^#{1,3} /.test(line)) {
      const level = line.match(/^#+/)![0].length + 1;
      output.push(`<h${level}>${inlineMarkdown(line.replace(/^#{1,3} /, ""))}</h${level}>`);
    } else if (/^(问题|思考|试一试)[：:]/.test(line)) {
      output.push(`<div class="teaching-callout question">${inlineMarkdown(line)}</div>`);
    } else if (/^(提示|Hint)[：:]/i.test(line)) {
      output.push(`<div class="teaching-callout hint">${inlineMarkdown(line)}</div>`);
    } else {
      output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    index += 1;
  }
  return output.join("");
}

function findDisplayMathStart(value: string, start: number, budget: ParseBudget): { index: number; delimiter: "$$" | "\\[" } | null {
  let cursor = start;
  while (cursor < value.length) {
    if (!spendParseWork(budget)) return null;
    if (value[cursor] === "\\" && !value.startsWith("\\[", cursor) && !value.startsWith("\\(", cursor)) { cursor += 2; continue; }
    if (value[cursor] === "`") {
      const code = readCodeSpan(value, cursor, budget);
      if (!code) return null;
      cursor = code.end;
      continue;
    }
    const link = value[cursor] === "[" ? readLink(value, cursor, budget) : null;
    if (link) { cursor = link.end; continue; }
    const inlineMath = readInlineMath(value, cursor, budget);
    if (inlineMath) { cursor = inlineMath.end; continue; }
    if (value.startsWith("$$", cursor)) return { index: cursor, delimiter: "$$" };
    if (value.startsWith("\\[", cursor)) return { index: cursor, delimiter: "\\[" };
    cursor += 1;
  }
  return null;
}

function renderDisplayMath(value: string, figureLine?:FigureLine): string {
  const output: string[] = [];
  const budget = parseBudget(value);
  let cursor = 0;
  while (cursor < value.length) {
    const opening = findDisplayMathStart(value, cursor, budget);
    if (!opening) break;
    const { index: start, delimiter } = opening;
    const closing = delimiter === "$$" ? "$$" : "\\]";
    const end = value.indexOf(closing, start + delimiter.length);
    if (end < 0) break;
    if (start > cursor) output.push(renderTextLines(value.slice(cursor, start),0,figureLine));
    const source = value.slice(start, end + closing.length);
    try {
      output.push(`<div class="math-block">${katex.renderToString(value.slice(start + delimiter.length, end).trim(), { ...MATH_OPTIONS, displayMode: true })}</div>`);
    } catch {
      output.push(renderTextLines(source));
    }
    cursor = end + closing.length;
  }
  // 流式阶段未闭合的公式仍按文本显示，待闭合符到达后下一次渲染即可变成公式。
  if (cursor < value.length || !output.length) output.push(renderTextLines(value.slice(cursor),0,figureLine));
  return output.join("");
}

export function renderMarkdown(value: string, figureLine?:FigureLine): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let text: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(lines[index]!);
    if (!opening) { text.push(lines[index]!); index += 1; continue; }
    if (text.length) { output.push(renderDisplayMath(text.join("\n"),figureLine)); text = []; }
    const marker = opening[1]!;
    const language = opening[2]!.trim();
    const code: string[] = [];
    index += 1;
    while (index < lines.length) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]!);
      if (closing && closing[1]![0] === marker[0] && closing[1]!.length >= marker.length) break;
      code.push(lines[index]!);
      index += 1;
    }
    const closed = index < lines.length;
    const codeText = code.join("\n") + (closed && code.length ? "\n" : "");
    output.push(`<div class="code-block"><span>${escapeHtml(language || "code")}</span><pre><code>${escapeHtml(codeText)}</code></pre></div>`);
    if (closed) index += 1;
  }
  if (text.length) output.push(renderDisplayMath(text.join("\n"),figureLine));
  return output.join("");
}
