import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import type {AnimationArtifact, AnimationLesson, AnimationPresentation, AnimationState, AnimationValidation, CallStackState, LinearBalanceState} from "./animationTypes.js";

export const ANIMATION_SKILL_VERSION = "0.3.0";
export const ANIMATION_VALIDATOR_VERSION = "animation-validator-v1";
const skillRoot = new URL("../resources/legacy-animation/", import.meta.url);
const catalog = [{id: "factorial-3-return", file: "factorial-3-return.lesson.json", template: "call-stack-v1"},
  {id: "linear-2x-plus3", file: "linear-2x-plus3.lesson.json", template: "linear-balance-v1"}] as const;

function finite(value: unknown): value is number {return typeof value === "number" && Number.isFinite(value);}
function text(value: unknown, limit = 500): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(value);
}
const equal = (a: number, b: number) => Math.abs(a-b) <= 1e-7 * Math.max(1, Math.abs(b));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(message: string): never {throw new Error("动画校验失败：" + message);}

/** 校验数学状态和结构，不把“通过”当作讲解或学习效果已获验证。 */
export function validateAnimationLesson(value: unknown): {lesson: AnimationLesson; validation: AnimationValidation} {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 48_000) fail("材料无效或过大。");
  const lesson = value as AnimationLesson;
  if (lesson.schema_version !== "lawa.lesson.v1" || lesson.decision !== "animate" || !["linear_balance", "call_stack"].includes(lesson.recipe)) fail("本版只支持方程与阶乘调用栈。");
  if (!text(lesson.title,80) || !text(lesson.target,250)) fail("标题或教学目标无效。");
  for (const list of [lesson.prerequisites, lesson.assumptions])
    if (!Array.isArray(list) || list.length > 12 || list.some(item => !text(item,300))) fail("前提或假设无效。");
  if (!lesson.parameters || typeof lesson.parameters !== "object" || !Array.isArray(lesson.scenes) || lesson.scenes.length < 3 || lesson.scenes.length > 12) fail("参数或场景无效。");
  let expected = 0;
  if (lesson.recipe === "linear_balance") {
    const p = lesson.parameters as {variable: string; original: number[]};
    if (p.variable !== "x" || !Array.isArray(p.original) || p.original.length !== 4 || !p.original.every(n => finite(n) && Math.abs(n) <= 30)) fail("原方程无效。");
    const [a,b,c,d] = p.original as [number,number,number,number];
    if (c !== 0 || a === c) fail("方程超出本版范围。");
    expected = (d-b)/(a-c);
  } else {
    const p = lesson.parameters as {function: string; n: number};
    if (p.function !== "factorial" || !Number.isInteger(p.n) || p.n < 0 || p.n > 5) fail("只支持0至5的阶乘。");
    expected = 1; for (let n=2;n<=p.n;n++) expected *= n;
  }
  const ids = new Set<string>(); let previous: AnimationState | undefined;
  for (const [index,scene] of lesson.scenes.entries()) {
    if (!scene || !text(scene.id,50) || ids.has(scene.id) || !text(scene.caption,140) || !text(scene.why,500) || !finite(scene.duration_s) || scene.duration_s < 3 || scene.duration_s > 12) fail("分镜内容、时长或标识无效。");
    ids.add(scene.id);
    if (!scene.state || typeof scene.state !== "object") fail("缺少场景状态。");
    if (lesson.recipe === "linear_balance") {
      const state = scene.state as LinearBalanceState; const old = previous as LinearBalanceState | undefined;
      if (!Array.isArray(state.equation) || state.equation.length !== 4 || !state.equation.every(finite) || !finite(state.operand)) fail("方程状态无效。");
      let wanted: number[];
      if (!index) {
        if (state.operation !== "start" || state.operand !== 0) fail("首幕必须是原方程。");
        wanted = (lesson.parameters as {original:number[]}).original;
      } else if (state.operation === "subtract") wanted = old!.equation.map((n,i) => i%2 ? n-state.operand : n);
      else if (state.operation === "divide" && state.operand !== 0) wanted = old!.equation.map(n => n/state.operand);
      else if (state.operation === "hold" && state.operand === 0) wanted = old!.equation;
      else fail("非法变形或除零。");
      if (!state.equation.every((n,i) => equal(n,wanted[i]!))) fail("必须保留两边同一变形。");
      if (equal(state.equation[0],state.equation[2]) || !equal((state.equation[3]-state.equation[1])/(state.equation[0]-state.equation[2]),expected)) fail("原解未保留。");
    } else {
      const s = scene.state as CallStackState, old = previous as CallStackState | undefined;
      if (!Array.isArray(s.frames) || s.frames.some(n => !Number.isInteger(n) || n < 0 || n > 5) || !(s.return_value === null || finite(s.return_value))) fail("调用栈状态无效。");
      if (!index) {
        if (s.phase !== "call" || !same(s.frames,[(lesson.parameters as {n:number}).n]) || s.return_value !== null) fail("必须从最外层调用开始。");
      } else if (s.phase === "call") {
        if (old!.phase !== "call" || old!.frames.at(-1)! <= 1 || !same(s.frames,[...old!.frames,old!.frames.at(-1)!-1]) || s.return_value !== null) fail("内层调用跳步。");
      } else if (s.phase === "base") {
        if (old!.phase !== "call" || !same(s.frames,old!.frames) || !s.frames.length || s.frames.at(-1)! > 1 || s.return_value !== 1) fail("基例必须先独立入栈。");
      } else if (s.phase === "return") {
        if (!["base","return"].includes(old!.phase) || !same(s.frames,old!.frames.slice(0,-1)) || !s.frames.length || old!.return_value === null || s.return_value !== s.frames.at(-1)!*old!.return_value) fail("返回顺序或乘法错误。");
      } else if (s.phase === "done") {
        if (!["base","return"].includes(old!.phase) || old!.frames.length !== 1 || s.frames.length || s.return_value !== old!.return_value || s.return_value !== expected) fail("最终返回无效。");
      } else fail("调用阶段无效。");
    }
    previous = scene.state;
  }
  if (lesson.recipe === "linear_balance" && !(previous as LinearBalanceState).equation.every((n,i) => equal(n,[1,0,0,expected][i]!))) fail("末幕必须解出x。");
  if (lesson.recipe === "call_stack" && (previous as CallStackState).phase !== "done") fail("缺少返回外部调用者。");
  const cp = lesson.checkpoint;
  if (!cp || !ids.has(cp.after_scene) || cp.after_scene === lesson.scenes.at(-1)!.id || !text(cp.prompt,160) || cp.metric !== (lesson.recipe === "linear_balance" ? "solution" : "final_return")) fail("预测位置或判定量无效。");
  const before = lesson.scenes.slice(0,lesson.scenes.findIndex(s => s.id === cp.after_scene)+1);
  if (lesson.recipe === "linear_balance" && before.some(s => (s.state as LinearBalanceState).equation.every((n,i) => equal(n,[1,0,0,expected][i]!)))) fail("预测前已显示答案。");
  if (lesson.recipe === "call_stack" && before.some(s => {const state=s.state as CallStackState; return ["return","done"].includes(state.phase) && state.return_value === expected && state.frames.length <= 1;})) fail("预测前已显示最终返回。");
  if (!Array.isArray(cp.options) || cp.options.length !== 3) fail("预测需要三个数值选项。");
  const optionIds = new Set<string>(); const correct: string[] = [];
  for (const option of cp.options) {
    if (!option || !text(option.id,20) || optionIds.has(option.id) || !finite(option.value)) fail("预测选项无效。");
    optionIds.add(option.id);
    if (Math.abs(option.value-expected) <= .01*Math.max(Math.abs(expected),1e-6)) correct.push(option.id);
  }
  if (correct.length !== 1) fail("必须恰好一个数值选项正确。");
  for (const branch of [cp.branches?.correct, cp.branches?.incorrect])
    if (!branch || !text(branch.caption,140) || !text(branch.why,500) || !ids.has(branch.replay_scene)) fail("回放分支无效。");
  return {lesson: structuredClone(lesson), validation: {expected,correctOptionId: correct[0]!,canonicalQuestion: lesson.recipe === "linear_balance" ? "根据原方程，最终 x 的值是多少？" : `factorial(${(lesson.parameters as {n:number}).n}) 最后返回给外部调用者的值是多少？`}};
}

export function canonicalAnimationJson(value: unknown): string {
  if (Array.isArray(value)) return "["+value.map(canonicalAnimationJson).join(",")+"]";
  if (value && typeof value === "object") return "{"+Object.keys(value).sort().map(key => JSON.stringify(key)+":"+canonicalAnimationJson((value as Record<string,unknown>)[key])).join(",")+"}";
  return JSON.stringify(value);
}
export function animationArtifactHash(value: Omit<AnimationArtifact,"contentSha256">): string {
  return createHash("sha256").update(canonicalAnimationJson(value)).digest("hex");
}
function makeArtifact(id: string, file: string, templateVersion: string): AnimationArtifact {
  const {lesson,validation} = validateAnimationLesson(JSON.parse(readFileSync(new URL("artifacts/"+file,skillRoot),"utf8")));
  const artifact = {id,version: "1",skillVersion: ANIMATION_SKILL_VERSION,templateVersion,validatorVersion: ANIMATION_VALIDATOR_VERSION,lesson,validation};
  return {...artifact,contentSha256: animationArtifactHash(artifact)};
}
export function listAnimationArtifacts(): AnimationArtifact[] {return catalog.map(item => makeArtifact(item.id,item.file,item.template));}
export function getAnimationArtifact(id: string): AnimationArtifact {
  const item = catalog.find(entry => entry.id === id); if (!item) throw new Error("这个演示尚未登记，请先使用文字解释。");
  return makeArtifact(item.id,item.file,item.template);
}

/** 只读取已保存的快照；旧版本不依赖当前catalog，升级不会重写历史教学。 */
export function readAnimationPresentation(value: unknown): AnimationPresentation | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 54_000) return null;
    const p = value as AnimationPresentation;
    for (const id of [p.id,p.sourceSessionId,p.goalId,p.taskId,p.skillId]) if (!text(id,200)) return null;
    const a=p.artifact; if (!a || !text(a.id,100) || !text(a.version,50) || !text(a.skillVersion,50) || a.validatorVersion !== ANIMATION_VALIDATOR_VERSION) return null;
    if (a.templateVersion !== (a.lesson?.recipe === "linear_balance" ? "linear-balance-v1" : "call-stack-v1")) return null;
    const {lesson,validation}=validateAnimationLesson(a.lesson);
    if (canonicalAnimationJson(a.validation) !== canonicalAnimationJson(validation) || !/^[a-f0-9]{64}$/.test(a.contentSha256)) return null;
    const {contentSha256,...snapshot}=a;
    if (animationArtifactHash(snapshot) !== contentSha256) return null;
    return {id:p.id,sourceSessionId:p.sourceSessionId,goalId:p.goalId,taskId:p.taskId,skillId:p.skillId,artifact:{...snapshot,lesson,validation,contentSha256}};
  } catch {return null;}
}

/** @deprecated 旧入口只返回迁移提示，不再把技能正文放入常驻教师策略。 */
export function animationTeachingPrompt(surface: "WEB" | "CLI"): string {
  if (surface !== "WEB") return "当前没有教学动画播放器；使用文字解释，不调用present_teaching_animation。";
  return `lawa-teaching-animation ${ANIMATION_SKILL_VERSION} 已改为按需加载，仅提供factorial-3-return（factorial(3)）和linear-2x-plus3（2x+3=11）两个精确样例。先用load_learning_skill读取入口；其他题可用图解讲页。正常课堂仍自然回复。`;
}
