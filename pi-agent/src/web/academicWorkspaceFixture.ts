import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

// 只提供隔离样例与构建资源。没有 Kernel、Pi 或外部模型连接。
const staticDir = resolve(process.env.READABLE_STATIC_DIR ?? "web-dist");
const sample = `# 理解模型如何学习\n\n从一个**具体例子**开始，把概念和实践联系起来。\n\n## 原文与解释\n\n> 学习需要通过实际尝试检验。\n> 来源：教材第 18–20 行。\n\n### 两个步骤\n\n1. 先说明目标和当前情况。\n2. 用小练习验证自己的理解。\n\n参考：[PyTorch 文档](https://pytorch.org/docs/)\n\n行内公式 $a < b$，以及损失函数：\n\n$$\\mathcal{L}=\\frac{1}{N}\\sum_{i=1}^{N}(y_i-\\hat y_i)^2$$\n\n\`\`\`python\nimport torch\nloss = ((prediction - target) ** 2).mean()\n\`\`\`\n\n| 阶段 | 当前输入与动作 | 要验证的现象 |\n| --- | --- | --- |\n| 解释 | 一个真实问题，不凭熟悉感确认掌握 | 能够说明输入、输出和边界 |\n| 实践 | 一个可运行的小练习 | 能用结果修正自己的理解 |`;
const timestamp = "2026-10-09T13:00:00Z";
const skills = ["理解神经网络的输入、输出与训练过程", "辨别常见问题", "独立解释结果"].map((name, i) => ({
  id: `skill-${i}`, name, description: "用具体例子检验理解：①说明输入（包含边界）；②解释输出；③独立验证结果。",
  status: i === 0 ? "LEARNING" : "NOT_STARTED", target_depth: "PRACTICAL", evidence_ids: [] }));
const cards = [{ id: "card-0", skill_id: "skill-0", question: "## 为什么需要损失函数？\n\n请解释 $a < b$ 的含义。",
  answer: sample, feedback: null, learner_note: "损失函数描述预测与目标之间的差异。参数更新使用梯度，二者并不是同一个量。", source_conversation_id: null, created_at: timestamp }];
const goal = { id: "goal-0", goal_description: "从概念到实践：理解模型训练", desired_outcome: "用实践检验理解", background_summary: "" };
const evidence = [{id:"evidence-0",skill_id:"skill-0",evidence_type:"EXPLAIN",assistance_level:"INDEPENDENT",created_at:timestamp,
  description:"问题：解释损失函数与训练过程的关系。\n1. 描述预测结果与目标之间的差异。\n2. 说明参数更新的方向。\n帮助：没有额外提示。\n结论：能用自己的话解释基本过程，并保留代码原有格式。\n```python\nloss = ((prediction - target) ** 2).mean()\n```"}];
const project = { status: "CURRENT", goal_profile: goal, curriculum_spine: skills.map((s, i) => ({ id: `milestone-${i}`, name: s.name, skill_ids: [s.id], description: s.description, target_depth: s.target_depth })),
  skills, knowledge_cards: cards, evidence, archived_at: null };
const session = { sessionId: "readable-fixture", messages: [{ role: "assistant", content: sample }, ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: "学习记录：从概念走向一次独立尝试。\n\n通过结果判断理解是否清楚，而不是只凭熟悉感。" }))], state: {
  view_mode: "CURRENT", active_goal_id: goal.id, overview: { current_goal: goal.goal_description, current_goal_skill_ids: skills.map(s => s.id),
    skills, curriculum_spine: project.curriculum_spine, recent_evidence: evidence, knowledge_cards: cards,
    current_frontier: { focus_skill_id: "skill-0", supporting_skill_ids: [], reason: "", target_depth: "PRACTICAL", next_action: "" },
    active_task: { id: "task-0", title: "解释损失函数与训练结果", description: "", related_skill_ids: ["skill-0"], status: "ACTIVE" } },
  teaching: { active_skill_id: "skill-0", teaching_mode: "EXPLAIN" }, onboarding: { status: "IDLE", replace_existing: false }, recommended_action: null } };
const material = { id: "material-0", name: "PyTorch 训练与实践课程.md", format: "md", goal_id: goal.id, unit_count: 120, unit_kind: "line", readable: true, warnings: [] };
const provider = { provider: "fixture", model: "隔离预览模型", baseUrl: "https://example.invalid/v1", thinkingLevel: "off", maxOutputTokens: 32768, hasApiKey: false, apiKeyHint: null };
let previewAttempts = 0;
let materialsEmpty = false;
const historicalSkill = {...skills[0], id: "skill-history", name: "Session → Context 构建逻辑"};
const historicalCard = {...cards[0], id: "card-history", skill_id: historicalSkill.id, question: "Session 与 Context 有什么区别？", answer: "Session 保存消息历史；Context 是一次调用所需的输入。\n\n```ts\nconst context = session.messages.slice(-8);\n```", learner_note: "持久记录与一次模型调用的输入具有不同生命周期。"};
const historical = {...project, status: "ARCHIVED", goal_profile: {...goal, id: "goal-history", goal_description: "Pi Agent 源码学习：理解会话与模型输入的边界"}, skills: [historicalSkill], knowledge_cards: [historicalCard]};
const question = {id:"question-1", purpose:"CHECK", session_id:session.sessionId, goal_id:goal.id, skill_id:skills[0]!.id, task_id:"task-0", questions:[{id:"q1", selection:"freeform", options:[], prompt:"解释下面的代码，并指出每个变量属于哪一次调用。\n\n```ts\nfunction makeStore() {\n  const items: string[] = [];\n  return { add: (item: string) => items.push(item), list: () => items };\n}\nconst first = makeStore();\nfirst.add(\"a\");\nconst second = makeStore();\nsecond.add(\"z\");\nconsole.log(second.list());\n```\n请说明输出和原因。"}]};
Object.assign(session.state.teaching, {learner_questions:{pending:question,last_answer:null}});
const extraProjects = ["TypeScript 实践", "蚁群算法入门", "批判性思维", "数据结构", "概率论", "科学写作"].map((name,index) => ({...historical, goal_profile:{...goal,id:`goal-extra-${index}`,goal_description:`${name}：用实际问题检验理解，记录关键概念与边界。`}, skills:[{...historicalSkill,id:`skill-extra-${index}`,name}],knowledge_cards:[{...historicalCard,id:`card-extra-${index}`,skill_id:`skill-extra-${index}`,learner_note:index===2 ? "长笔记样例：概念需要放回具体问题中理解。\n\n".repeat(45) : "保留问题与自己的判断，回顾时说明推理过程。"}]}));
let speechConfig = {enabled:false,profileId:null,region:"beijing",asrModel:"qwen3-asr-flash",ttsModel:"qwen3-tts-flash",voice:"Cherry"};
let retrievalConfig = {version:1,enabled:false,profileId:"preview-profile",embeddingModel:"text-embedding-v4",dimensions:1024,rerankModel:"qwen3-rerank",embeddingUrl:"https://example.invalid/embeddings",rerankUrl:"https://example.invalid/rerank",minimumRerankScore:0.1,visionEnabled:false,graphEnabled:false,visionModel:"",extractionModel:"",profiles:[{id:"preview-profile",provider:"aliyun-bailian",model:"隔离预览模型"}]};
let profiles = [{...provider,id:"preview-profile",name:"隔离预览配置",provider:"aliyun-bailian"}];
let failSave = "";
let version = 1;
let run: {id:string;sessionId:string;status:"running";text:string}|null = null;
const clients = new Set<import("node:http").ServerResponse>();
const requests: string[] = [];
const snapshot = () => ({session, run, version:String(version), sequence:version});
const publish = (value: unknown) => clients.forEach(client => client.write(`data: ${JSON.stringify(value)}\n\n`));

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const json = (payload: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(payload)); };
  try {
    if (url.pathname === "/fixture/requests") return json(requests);
    if (url.pathname === "/fixture/materials-empty") { materialsEmpty=true; return json({ok:true}); }
    if (url.pathname === "/fixture/snapshot") { version++; clients.forEach(client => client.write(`data: ${JSON.stringify({type:"snapshot",snapshot:snapshot()})}\n\n`)); return json(snapshot()); }
    if (url.pathname === "/fixture/card-missing") { historical.knowledge_cards = []; return json({ok:true}); }
    if (url.pathname === "/fixture/save-error") { failSave = url.searchParams.get("kind") ?? "speech"; return json({ok:true}); }
    if (url.pathname === "/fixture/cards-empty") { session.state.overview.knowledge_cards=[]; version++; publish({type:"snapshot",snapshot:snapshot()}); return json({ok:true}); }
    if (url.pathname === "/fixture/stream") {
      if (!run) {run={id:"fixture-run",sessionId:session.sessionId,status:"running",text:""};version++;publish({type:"snapshot",snapshot:snapshot()});}
      const delta="\n\n新的讲解片段：历史阅读位置应当保持，只有原本位于底部的阅读者继续跟随。";
      run.text+=delta;version++;publish({type:"event",sequence:version,runId:run.id,event:{type:"assistant_delta",delta}});
      return json({ok:true});
    }
    if (url.pathname === "/fixture/stream-end") {if(run) session.messages.push({role:"assistant",content:run.text});run=null;version++;publish({type:"snapshot",snapshot:snapshot()});return json({ok:true});}
    if (url.pathname.startsWith("/api/")) {
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "PUT" && /(?:speech|retrieval|provider)-settings$/.test(url.pathname)) {
        const chunks:Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        await new Promise(resolve => setTimeout(resolve,650));
        if (failSave && url.pathname.includes(failSave)) {failSave="";return json({detail:"隔离测试：保存失败，请重试。"},503);}
        if (url.pathname.includes("speech")) {speechConfig={...speechConfig,...input};return json(speechConfig);}
        if (url.pathname.includes("retrieval")) {retrievalConfig={...retrievalConfig,...input};return json(retrievalConfig);}
        profiles=[{...profiles[0],...input,name:input.name||"隔离预览配置"}];return json({activeProfileId:"preview-profile",active:profiles[0],profiles});
      }
      if (url.pathname === "/api/web/study-time") return json({scope:{goalId:goal.id,taskId:"task-0",goalName:goal.goal_description,taskName:"独立解释"},taskFocusedMs:0,goalFocusedMs:0,runFocusedMs:0,taskObservedMs:0,taskWaitingMs:0,observation:"UNKNOWN",recording:false});
      if (url.pathname === "/api/web/classroom/events") {response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"}); response.write(": connected\n\n"); clients.add(response); request.on("close",()=>clients.delete(response)); return;}
      if (url.pathname === "/api/web/classroom/snapshot") return json(snapshot());
      if (url.pathname.endsWith("/state")) return json(session.state);
      if (url.pathname === "/api/web/teaching") return json({current_goal_id:goal.id,proposals:["CONFIRMED","WITHDRAWN"].map((status,index)=>({id:`preference-${index}`,revision:1,kind:"STRATEGY",text:index?"每节课结束后给出一组练习。":"先用具体例子说明概念；让我独立尝试后，再给反馈。",reason:"",scope:"USER",subject:"general",status,goal_id:goal.id,source_independent:true}))});
      if (url.pathname === "/api/web/teaching-instructions") return json({text:"先讲一个具体例子，然后让我独立尝试。",updatedAt:null,maxChars:4000});
      if (url.pathname.includes("/teaching")) return json({items:[]});
      if (url.pathname.includes("/assistant")) return json({available:true,scope:{goalId:goal.id,taskId:"task-0",skillId:skills[0]!.id,attemptId:null,mainSessionId:session.sessionId},messages:[],busy:false});
      if (url.pathname === "/api/web/retrieval-settings") return json(retrievalConfig);
      if (url.pathname.endsWith("/activate")) return json(session);


      if (url.pathname === "/api/web/sessions") return json(request.method === "POST" ? session : { activeSessionId: session.sessionId, sessions: [0,1].map(i => ({ id: i ? "old-session" : session.sessionId, name: "请先读取学习资料，然后依据资料规划学习路线", goalDescription: i ? "学会提问：解释论题与结论" : goal.goal_description, goalId: goal.id, updatedAt: timestamp, createdAt: timestamp, messageCount: 9, active: !i })) });
      if (url.pathname === "/api/web/provider-settings") return json({ activeProfileId: "preview-profile", active: profiles[0], profiles });
      if (url.pathname === "/api/web/speech-settings") return json(speechConfig);
      if (url.pathname === "/api/web/materials") return json({ materials: materialsEmpty ? [] : [material] });
      if (url.pathname === "/api/web/materials/material-0") {
        if (++previewAttempts === 1) return json({ detail: "预览服务暂不可用。" }, 503);
        return json({ text: sample, citation: material.name + " · 第 1–60 行", truncated: true });
      }
      if (url.pathname === "/api/web/retrieval-status") return json({ enabled: false, chunks: 1, building_generation: null, warning: null, sources: [] });
      if (url.pathname === "/api/web/retrieval-traces") return json(url.searchParams.has("id") ? { query: "怎样解释论题？", scope: "current", current_scope: "old-goal", warnings: [], reads: [], timings_ms: { total: 10 }, stages: { bm25: [{ name: "学会提问.txt", goal_name: "学会提问", snippet: "先找到论题。", score: 1, locator: { kind: "line", start: 5, end: 7 } }] } } : [{ id: "old-trace", at: timestamp, query: "怎样解释论题？", scope: "current", warnings: [] }]);
      if (url.pathname === "/api/web/learning-library") return json({ projects: [project, historical,...extraProjects] });
      if (url.pathname === "/api/web/growth") {
        const dimensions = ["数理分析", "技术应用", "语言表达", "人文理解", "艺术创造", "生活实践"].map((name, i) => ({id: `dimension-${i}`, name}));
        const layer = {status: "READY", evaluation: {dimensions: dimensions.map(d => ({...d, score: 0, rationale: "合成样例暂无评价", coverage: [], missing: [], source_refs: []})), created_at: null, model_id: null}};
        return json({points: [project, historical,...extraProjects].map((p, i) => ({goal_id: p.goal_profile.id, title: p.goal_profile.goal_description, status: p.status, x: (i % 4) * .15, y: .25, classification: null})),
          dimensions, capability: layer, jobs: [], recommendations: [], supplements: [], imports: []});
      }
      if (url.pathname.startsWith("/api/web/growth/goals/")) return json({records: [], samples: [], requires_initial_route: false});
      return json({ detail: "隔离预览禁止该操作。" }, 400);
    }
    const path = resolve(staticDir, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    if (!path.startsWith(staticDir + sep)) { response.writeHead(403); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, { "Content-Type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" } as Record<string,string>)[extname(path)] ?? "application/octet-stream" }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(Number(process.env.READABLE_PORT ?? 19986), "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
console.log(`Academic fixture: ${base}; static=${staticDir}; no Kernel or model connection`);
