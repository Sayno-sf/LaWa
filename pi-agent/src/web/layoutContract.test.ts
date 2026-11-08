import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("long chat stays inside a height-bounded dashboard and scrolls internally", async () => {
  const css = await readFile(new URL("../../web/src/styles.css", import.meta.url), "utf8");

  assert.match(css, /\.dashboard-grid\s*\{[^}]*\bheight\s*:/s);
  assert.match(css, /\.center-column\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.conversation-panel\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.messages\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
});

test("delivered frontend keeps persisted conversation restore and incremental streaming", async () => {
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  // 外部 UI 交付不能删掉这个协议字段，否则 Gateway 虽然保存了消息，页面刷新后仍会显示白板。
  assert.match(source, /interface SessionResponse\s*\{[^}]*messages:\s*UiMessage\[\]/s);
  assert.match(source, /messages\.splice\(0,\s*messages\.length,\s*\.\.\.payload\.messages\)/);

  // 流式回复只更新当前 assistant 节点，避免长对话时反复重建全部历史。
  assert.match(source, /function updateStreamingMessage\(assistant:\s*UiMessage\)/);
  assert.match(source, /assistant\.content \+= event\.delta \?\? "";\s*updateStreamingMessage\(assistant\);/s);
});

test("provider settings stay a multi-profile main page and never persist API keys in browser storage", async () => {
  const html = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  assert.match(html, /<section id="provider-settings-page"/);
  assert.match(html, /id="settings-button"/);
  assert.match(html, /id="provider-profile-list"/);
  assert.match(html, /id="new-provider-profile-button"/);
  assert.match(html, /id="activate-provider-profile-button"/);
  assert.match(html, /id="delete-provider-profile-button"/);
  assert.match(html, /id="thinking-level-input"/);
  assert.match(html, /id="max-output-tokens-input"/);
  assert.match(html, /value="off"/);
  assert.match(html, /value="high"/);
  assert.match(html, /type="password"/);
  assert.match(source, /\/api\/web\/provider-settings\/test/);
  assert.match(source, /\/api\/web\/provider-settings\/activate/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /thinkingLevel:\s*elements\.thinkingLevelInput\.value/);
  assert.match(source, /maxOutputTokens:\s*Number\(elements\.maxOutputTokensInput\.value\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(api.?key|provider)/i);
});

test("current route excludes skills retained only for archived learning history", async () => {
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  assert.match(source, /current_goal_skill_ids:\s*string\[\]/);
  assert.match(source, /function currentGoalSkills\(/);
  assert.match(source, /renderLearningRoute\(overview, currentGoalSkills\(overview\)/);
  assert.doesNotMatch(
    source,
    /elements\.skillRoute\.innerHTML\s*=\s*overview\.skills\.length/,
  );
});

test("starting a new Goal first creates an isolated Pi conversation", async () => {
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /newGoalDialog\.addEventListener\("close"[\s\S]*body:\s*JSON\.stringify\(\{ mode: "new-goal" \}\)[\s\S]*\/new-goal/,
  );
  // 新草稿的权威payload必须在第二次/new-goal请求前投影；清空内存数组本身不能更新可见课堂。
  assert.match(source, /newGoalDialog\.addEventListener\("close"[\s\S]*applySessionPayload\(created\);[\s\S]*\/new-goal/);
});

test("replacement onboarding does not project the old Goal as current learning", async () => {
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  assert.match(source, /function renderGoalOnboardingState\(/);
  assert.match(
    source,
    /if \(onboardingActive\) \{\s*renderGoalOnboardingState\(next\);\s*syncKnowledgeCardNotice\(\);\s*void renderRouteMaterials\(\);\s*return;\s*\}/,
  );
});

test("learning and conversation libraries stay separate in the browser contract", async () => {
  const html = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  assert.match(html, /id="learning-library-button"/);
  assert.match(html, /<section id="learning-library-page"/);
  assert.match(html, /id="conversation-list"/);
  assert.match(html, /id="new-conversation-button"/);
  assert.match(html, /id="conversation-library-menu-button"/);
  assert.match(html, /<section id="conversation-library-page"/);
  assert.match(source, /\/api\/web\/learning-library/);
  assert.match(source, /\/api\/web\/sessions\/\$\{encodeURIComponent\(id\)\}\/activate/);
  const library = await readFile(new URL("../../web/src/growthLibraryView.ts", import.meta.url), "utf8");
  assert.match(library, /学习记录/);
  assert.match(library, /data-library-action="goal"/);
  assert.match(source, /历史目标只读；学习资料已随对话切换/);
  assert.match(source, /viewMode\(next\) === "CURRENT"/);
});

test("mobile shell keeps the classroom on one screen with route/records surfaces", async () => {
  const css = await readFile(new URL("../../web/src/mobileShell.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../web/src/main.ts", import.meta.url), "utf8");

  // 桌面端不加载壳层：默认隐藏切换栏，规则全部限定在 820px 以下。
  assert.match(css, /\.mobile-surface-tabs\s*\{\s*display:\s*none/s);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /body\[data-workspace="learn"\]\s*\.workspace-main\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /body\[data-mobile-screen="route"\]\s*#learning-workspace \.dashboard-grid > \.route-card/s);
  assert.match(html, /id="mobile-surface-tabs"/);
  assert.equal((html.match(/data-mobile-surface="/g) ?? []).length, 3);
  // 切换只换显示与滚动位置，不调用教学入口。
  assert.match(source, /function applyMobileSurface\(surface: MobileSurface\)/);
  assert.doesNotMatch(source.slice(source.indexOf("function applyMobileSurface")), /requestSubmit|\/messages|sendMessage/);
});
