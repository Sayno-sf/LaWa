import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";

import { renderMarkdown } from "../../web/src/markdown.js";

test("thematic breaks share Markdown rendering and leave fenced code intact", () => {
  const document = new JSDOM(renderMarkdown("---\n正文\n* * *\n___\n```js\n---\n```\n- 列表")).window.document;
  assert.equal(document.querySelectorAll("hr").length, 3);
  assert.equal(document.querySelector("code")?.textContent, "---\n");
  assert.equal(document.querySelector("li")?.textContent, "列表");
});

test("minimal bracketed display math renders as KaTeX", () => {
  const html = renderMarkdown(String.raw`\[
x^2
\]`);
  assert.match(html, /class="katex-display"/);
});

test("renders LaTeX display delimiters from a teaching reply", () => {
  const html = renderMarkdown(String.raw`所以：

\[
\text{Session} \neq \text{Context}
\]

不是因为长度不同。`);

  assert.match(html, /class="katex-display"/);
  assert.doesNotMatch(html, /\\\[|\\\]/);
  assert.match(html, /不是因为长度不同/);
});

test("renders parenthesized inline math without changing code fences or incomplete streams", () => {
  const inline = renderMarkdown(String.raw`两者满足 \(a \neq b\)。`);
  assert.match(inline, /class="katex"/);
  assert.doesNotMatch(inline, /\\\(|\\\)/);

  const code = renderMarkdown(["```tex", String.raw`\[x^2\]`, "```"].join("\n"));
  assert.match(code, /<pre><code>\\\[x\^2\\\]\n<\/code><\/pre>/);
  assert.doesNotMatch(code, /katex-display/);

  const incomplete = renderMarkdown(String.raw`\[
x^2`);
  assert.doesNotMatch(incomplete, /katex-display/);
  assert.match(incomplete, /\\\[/);
});

test("retains dollar-delimited math and leaves malformed LaTeX readable", () => {
  const html = renderMarkdown(String.raw`行内 $a+b$。

$$
E = mc^2
$$`);
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);

  const malformed = renderMarkdown(String.raw`\[
\notARealCommand
\]`);
  assert.doesNotMatch(malformed, /katex-display/);
  assert.match(malformed, /\\notARealCommand/);
});

test("renders a GFM pipe table as semantic table markup", () => {
  const html = renderMarkdown(`Part 5 对照表

| 维度 | 梯度下降 | TSP / ACO |
| --- | --- | --- |
| 解的形态 | 实数向量 w ∈ Rⁿ | 城市的一个排列 |
| 移动方式 | 步长可任意小 | swap / 2-opt |

表格之后的正文`);

  assert.match(html, /<table>/);
  assert.match(html, /<thead><tr><th>维度<\/th><th>梯度下降<\/th><th>TSP \/ ACO<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody>[\s\S]*<td>swap \/ 2-opt<\/td>[\s\S]*<\/tbody>/);
  assert.match(html, /<p>表格之后的正文<\/p>/);
  assert.doesNotMatch(html, /<p>\| --- \| --- \| --- \|<\/p>/);
});

test("keeps incomplete streaming table syntax readable until its delimiter arrives", () => {
  const html = renderMarkdown("| 维度 | 梯度下降 |\n正在生成");

  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<p>\| 维度 \| 梯度下降 \|<\/p>/);
});

test("supports table alignment and keeps cell HTML escaped", () => {
  const html = renderMarkdown(`| 左 | 中 | 右 |
| :--- | :---: | ---: |
| <img src=x onerror=alert(1)> | **重点** | \`a|b\` |`);

  assert.match(html, /class="table-align-left"/);
  assert.match(html, /class="table-align-center"/);
  assert.match(html, /class="table-align-right"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>a\|b<\/code>/);
});

test("distinguishes heading levels and renders lists, quotes and existing teaching callouts", () => {
  const html = renderMarkdown(`# 主题\n## 方法\n### 细节\n\n3. 第一步\n4. 第二步\n   - 子项\n   - **重点**\n\n> 原文\n> **来源** [文档](https://example.com/docs)\n\n问题：试试看\n提示：从定义开始`);
  const document = new JSDOM(html).window.document;
  assert.deepEqual([...document.querySelectorAll("h2,h3,h4")].map((node) => [node.tagName, node.textContent]), [["H2", "主题"], ["H3", "方法"], ["H4", "细节"]]);
  assert.equal(document.querySelector("ol")?.getAttribute("start"), "3");
  assert.equal(document.querySelectorAll("ol > li").length, 2);
  assert.equal(document.querySelectorAll("ol > li > ul > li").length, 2);
  assert.equal(document.querySelector("blockquote strong")?.textContent, "来源");
  assert.equal(document.querySelector("blockquote a")?.textContent, "文档");
  assert.equal(document.querySelectorAll(".teaching-callout.question,.teaching-callout.hint").length, 2);
});

test("renders nested emphasis without interpreting code as links or math", () => {
  const html = renderMarkdown("**粗体里有 *强调* 和 `**原样** $x$ [链接](https://example.com)`**\n*强调里有 **粗体***\n***同时强调***\n``含 ` 号与 $$x$$``");
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("p > strong > em")?.textContent, "强调");
  assert.equal(document.querySelector("p > em > strong")?.textContent, "粗体");
  assert.equal(document.querySelectorAll("p > strong > em")[1]?.textContent, "同时强调");
  assert.deepEqual([...document.querySelectorAll("code")].map((node) => node.textContent), ["**原样** $x$ [链接](https://example.com)", "含 ` 号与 $$x$$"]);
  assert.equal(document.querySelectorAll("a,.katex").length, 0);
});

test("allows safe Markdown links and leaves unsafe or incomplete links readable", () => {
  const destinations = ["https://example.com/a_(b)?x=1&y=2", "HTTP://example.com", "mailto:learner@example.com"];
  const unsafe = ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "java\tscript:alert(1)", "#settings"];
  const html = renderMarkdown([...destinations.map((url) => `[**参考**](${url})`), ...unsafe.map((url) => `[危险](${url})`), "[未完成](https://example.com"].join("\n"));
  const document = new JSDOM(html).window.document;
  const links = [...document.querySelectorAll("a")];
  assert.deepEqual(links.map((node) => node.getAttribute("href")), destinations);
  assert.ok(links.every((node) => node.getAttribute("rel") === "noopener noreferrer" && node.getAttribute("target") === "_blank"));
  assert.ok(links.every((node) => node.querySelector("strong")?.textContent === "参考"));
  assert.ok(document.body.textContent?.includes("[未完成](https://example.com"));
  assert.equal(document.querySelectorAll("script").length, 0);
});

test("escapes untrusted HTML and attributes throughout shared content", () => {
  const html = renderMarkdown(`<script>alert(1)</script>\n# <img src=x onerror=alert(1)>\n> <iframe src=javascript:alert(1)>\n- <svg onload=alert(1)>\n[x](https://example.com/\"onclick=\"alert(1))\n\u0000${0}\u0000\n\n| <img src=x> | 链接 |\n| --- | --- |\n| <input autofocus onfocus=alert(1)> | [危险](javascript:alert(1)) |`);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll("script,img,iframe,svg,input").length, 0);
  assert.equal(document.querySelectorAll("[onclick],[onerror],[onload],[onfocus]").length, 0);
  assert.equal(document.querySelector("a")?.getAttribute("href"), 'https://example.com/"onclick="alert(1)');
  assert.ok(document.body.textContent?.includes("<script>alert(1)</script>"));
});

test("passes original LaTeX to KaTeX and keeps trust disabled", () => {
  const html = renderMarkdown(String.raw`比较 $a < b$，且 \(\text{A\&B}\)。\n\n$$\n\begin{aligned}a&=b\\c&=d\end{aligned}\n$$`.replaceAll("\\n", "\n"));
  const document = new JSDOM(html).window.document;
  const tex = [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map((node) => node.textContent);
  assert.deepEqual(tex, ["a < b", String.raw`\text{A\&B}`, String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`]);
  assert.equal(document.querySelectorAll(".katex-display").length, 1);
  const untrusted = new JSDOM(renderMarkdown(String.raw`$\href{javascript:alert(1)}{open}$\n\n$$\href{https://example.com}{x}$$`.replaceAll("\\n", "\n"))).window.document;
  assert.equal(untrusted.querySelectorAll("a").length, 0);
});

test("keeps code spans opaque while splitting table cells", () => {
  const document = new JSDOM(renderMarkdown("| 代码 | 说明 |\n| --- | --- |\n| ``a`|b $x$`` | [文档](https://example.com) |\n| `a\\|b` | **重点** |" )).window.document;
  assert.equal(document.querySelectorAll("tbody tr td").length, 4);
  assert.deepEqual([...document.querySelectorAll("tbody code")].map((node) => node.textContent), ["a`|b $x$", "a\\|b"]);
  assert.equal(document.querySelectorAll(".katex").length, 0);
  assert.equal(document.querySelector("tbody a")?.textContent, "文档");
});

test("preserves long code fences and incomplete streaming math or code", () => {
  const code = ["````markdown", "```js", "const value = '$$x$$ <img src=x> [link](javascript:alert(1))';", "```", "````", "之后"].join("\n");
  const document = new JSDOM(renderMarkdown(code)).window.document;
  assert.equal(document.querySelectorAll(".code-block").length, 1);
  assert.equal(document.querySelectorAll(".katex,a,img").length, 0);
  assert.ok(document.querySelector("pre code")?.textContent?.startsWith("```js\n"));
  assert.equal(document.querySelector("p")?.textContent, "之后");
  const partial = renderMarkdown("开始 `尚未关闭 $x$ [链接](https://example.com)\n\\(a < b\n\\[x^2\n```js\n<img src=x>");
  const incomplete = new JSDOM(partial).window.document;
  assert.equal(incomplete.querySelectorAll(".katex,a,img").length, 0);
  assert.ok(incomplete.body.textContent?.includes("\\(a < b"));
  assert.ok(incomplete.body.textContent?.includes("\\[x^2"));
  assert.equal(incomplete.querySelector("pre code")?.textContent, "<img src=x>");
});

test("bounds block nesting while retaining deeply nested untrusted content", () => {
  const quote = "> ".repeat(1000) + "<img src=x>";
  const lists = Array.from({ length: 150 }, (_, index) => "  ".repeat(index) + "- 项目").join("\n");
  const document = new JSDOM(renderMarkdown(quote + "\n\n" + lists)).window.document;
  let deepest = 0;
  for (const node of document.querySelectorAll("blockquote,ol,ul")) {
    let ancestors = 0;
    let current: Element | null = node;
    while (current) {
      if (current.matches("blockquote,ol,ul")) ancestors += 1;
      current = current.parentElement;
    }
    deepest = Math.max(deepest, ancestors);
  }
  assert.equal(deepest, 12);
  assert.equal(document.querySelectorAll("img").length, 0);
  assert.equal(document.body.textContent?.match(/项目/g)?.length, 150);
  assert.ok(document.body.textContent?.includes("<img src=x>"));
});

test("keeps long incomplete delimiters readable within the streaming render budget", () => {
  const source = "[".repeat(60000) + "\n" + "\\".repeat(60000) + "\n" + "\\(".repeat(20000);
  const start = performance.now();
  const html = renderMarkdown(source);
  const elapsed = performance.now() - start;
  // 原实现对 20k 未闭合方括号已需约 1.6s；宽裕上限只拦截明显的二次扫描退化。
  assert.ok(elapsed < 1000, `long incomplete input rendered in ${Math.round(elapsed)}ms`);
  assert.equal(html.match(/\[/g)?.length, 60000);
  assert.equal(html.match(/\\\(/g)?.length, 20000);
  assert.doesNotMatch(html, /<a |katex|<script/);
});

test("limits untrusted LaTeX dimensions and leaves recursive macros readable", () => {
  const html = renderMarkdown(String.raw`$\rule{999999em}{999999em}$`);
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /style="[^"]*999999em/);
  assert.match(html, /width:20em/);
  const recursive = renderMarkdown(String.raw`$\def\loop{\loop}\loop$`);
  assert.doesNotMatch(recursive, /class="katex"/);
  assert.match(recursive, /\\def\\loop/);
});
