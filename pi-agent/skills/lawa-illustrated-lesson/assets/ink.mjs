import {compileMotion} from "./motion.mjs";
/** Portable drawing model shared by the page, the offline player and the tutor. */
export const TICKS = 240;
const palette = {ink:"#293a37",paper:"#faf8f1",leaf:"#778e70",water:"#507c91",clay:"#ac7154",muted:"#a7ada2",none:"none",black:"#000",white:"#fff"};
const geometry = {
  path:["d"], line:["x1","y1","x2","y2"], rect:["x","y","width","height","rx","ry"],
  circle:["cx","cy","r"], ellipse:["cx","cy","rx","ry"], polygon:["points"], polyline:["points"],
  text:["x","y","font-size","text-anchor"]
};
const style = ["fill","stroke","stroke-width","opacity","stroke-linecap","stroke-linejoin","stroke-dasharray","fill-rule"];
const nonnegative = new Set(["width","height","r","rx","ry","stroke-width","font-size"]);
const keyPattern = /^[a-z][a-z0-9-]{0,39}$/;

function requireValue(ok, message) {
  if (!ok) throw new Error("图解讲页 · " + message);
}
function record(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key)), label + " 含未知字段或格式不正确");
}
function plain(value, max, label) {
  requireValue(typeof value === "string" && value.trim() && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value), label + " 需要 1–" + max + " 字符的单行文字");
  return value.trim();
}
function scalar(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e6;
}

// A bounded arithmetic grammar. Author input never becomes JavaScript or CSS.
function arithmetic(source) {
  requireValue(typeof source === "string" && source.length > 0 && source.length <= 100, "算式过长或为空");
  const text = source.replace(/\s+/g,"");
  const tokens = text.match(/\d+(?:\.\d*)?|\.\d+|x|[()+*/-]/g) ?? [];
  requireValue(tokens.length <= 72 && tokens.join("") === text, "算式使用 x、数、四则运算与括号");
  let i = 0;
  function primary() {
    const token = tokens[i++];
    if (token === "-") { const a = primary(); return x => -a(x); }
    if (token === "+") return primary();
    if (token === "x") return x => x;
    if (token === "(") {
      const a = sum();
      requireValue(tokens[i++] === ")", "算式缺少右括号");
      return a;
    }
    requireValue(token !== undefined && /^[.\d]/.test(token) && scalar(Number(token)), "算式缺少数值");
    return () => Number(token);
  }
  function product() {
    let value = primary();
    while (tokens[i] === "*" || tokens[i] === "/") {
      const left = value, op = tokens[i++], right = primary();
      value = op === "*" ? x => left(x) * right(x) : x => left(x) / right(x);
    }
    return value;
  }
  function sum() {
    let value = product();
    while (tokens[i] === "+" || tokens[i] === "-") {
      const left = value, op = tokens[i++], right = product();
      value = op === "+" ? x => left(x) + right(x) : x => left(x) - right(x);
    }
    return value;
  }
  const value = sum();
  requireValue(i === tokens.length, "算式末尾有多余内容");
  return value;
}

function attribute(key, value) {
  if (key === "fill" || key === "stroke") {
    requireValue(typeof value === "string" && (Object.hasOwn(palette,value) || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)), "请使用纯色或纸面色名");
    return Object.hasOwn(palette,value) ? palette[value] : value;
  }
  if (key === "d") {
    requireValue(typeof value === "string" && value.length <= 2400 && /^\s*[Mm][MmZzLlHhVvCcSsQqTtAaEe\d.,+\s-]+$/.test(value), "path 需要有限的 SVG 路径数据");
    return value;
  }
  if (key === "points" || key === "stroke-dasharray") {
    requireValue(typeof value === "string" && value.trim() && value.length <= 900, key + " 需要数值列表");
    const values = value.trim().split(/[\s,]+/).map(Number);
    requireValue(values.every(scalar) && (key === "points" ? values.length >= 4 && values.length % 2 === 0 : values.every(n => n >= 0)), key + " 数值不正确");
    return values.join(" ");
  }
  const tokens = {"stroke-linecap":["butt","round","square"],"stroke-linejoin":["round","miter","bevel"],
    "fill-rule":["nonzero","evenodd"],"text-anchor":["start","middle","end"]};
  if (Object.hasOwn(tokens,key)) {
    requireValue(tokens[key].includes(value), key + " 的选项无效");
    return value;
  }
  if (typeof value === "string" && value.startsWith("=")) return arithmetic(value.slice(1));
  const n = typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : value;
  requireValue(scalar(n), key + " 需要有限数或以 = 开头的算式");
  return n;
}

export function prepareFigure(input) {
  requireValue(input && JSON.stringify(input).length <= 20000, "每幅画稿最多 20000 字符");
  record(input,["key","alt","caption","source","view","ink","axis","motion","prediction"],"插画");
  const figure = structuredClone(input);
  requireValue(typeof figure.key === "string" && keyPattern.test(figure.key), "key 用小写字母起首，可含数字和连字符");
  figure.alt = plain(figure.alt,180,"替代说明");
  figure.caption = plain(figure.caption,300,"图注");
  if (figure.source !== undefined) figure.source = plain(figure.source,180,"来源");
  requireValue(Array.isArray(figure.view) && figure.view.length === 2 && figure.view.every(Number.isInteger) &&
    figure.view[0] >= 96 && figure.view[0] <= 1000 && figure.view[1] >= 64 && figure.view[1] <= 640, "view 需要画纸的宽和高");
  requireValue(Array.isArray(figure.ink) && figure.ink.length >= 1 && figure.ink.length <= 96, "每幅画需要 1–96 笔");
  requireValue(figure.prediction===undefined || figure.motion!==undefined,"预测点需要时间动画");
  const axis = figure.axis;
  requireValue(figure.motion===undefined || axis===undefined,"按时间讲解填写 motion，可调示意填写 axis，请选择一种");
  let measures = [];
  if (axis !== undefined) {
    record(axis,["label","min","max","unit","readings"],"axis");
    axis.label = plain(axis.label,32,"变量名称");
    requireValue(scalar(axis.min) && scalar(axis.max) && axis.min < axis.max, "变量范围必须递增");
    if (axis.unit !== undefined) axis.unit = plain(axis.unit,12,"单位");
    if (axis.readings !== undefined) {
      requireValue(Array.isArray(axis.readings) && axis.readings.length <= 4, "最多四个图外读数");
      measures = axis.readings.map(reading => {
        record(reading,["label","expr","unit"],"读数");
        reading.label = plain(reading.label,32,"读数名称");
        if (reading.unit !== undefined) reading.unit = plain(reading.unit,12,"读数单位");
        return arithmetic(reading.expr);
      });
    }
  }
  let dynamic = false;
  const strokes = figure.ink.map((stroke,index) => {
    requireValue(Array.isArray(stroke) && typeof stroke[0] === "string" && Object.hasOwn(geometry,stroke[0]), "第 " + (index+1) + " 笔形状未知");
    const [tag, attrs, label] = stroke;
    requireValue(stroke.length === (tag === "text" ? 3 : 2), "每笔用 [形状,属性]，text 另加短标签");
    if (tag === "text") plain(label,16,"图内短标签");
    record(attrs,[...geometry[tag],...style,...(figure.motion!==undefined?["id"]:[])],"第 " + (index+1) + " 笔属性");
    const required = {path:["d"],line:["x1","y1","x2","y2"],rect:["width","height"],circle:["r"],ellipse:["rx","ry"],polygon:["points"],polyline:["points"],text:["x","y"]};
    requireValue(required[tag].every(key => Object.hasOwn(attrs,key)), "第 " + (index+1) + " 笔缺少几何属性");
    const entries = Object.entries(attrs).filter(([key])=>key!=="id").map(([key,value]) => {
      const compiled = attribute(key,value);
      if (typeof compiled === "function") {
        requireValue(axis !== undefined, "可变笔画需要 axis");
        dynamic = true;
      }
      return [key,compiled];
    });
    return {tag,label,entries};
  });
  requireValue(!axis || dynamic, "请把 x 用于画中发生变化的几何属性");
  function at(tick) {
    requireValue(Number.isInteger(tick) && tick >= 0 && tick <= (axis ? TICKS : 0), "观察位置超出范围");
    const x = axis ? axis.min + (axis.max-axis.min) * tick / TICKS : 0;
    const marks = strokes.map(({tag,label,entries}) => {
      const attrs = {};
      for (const [key,term] of entries) {
        const value = typeof term === "function" ? term(x) : term;
        if (typeof value === "number") requireValue(scalar(value) && (!nonnegative.has(key) || value >= 0) &&
          (key !== "opacity" || (value >= 0 && value <= 1)), key + " 在 x=" + formatValue(x) + " 时没有有效数值");
        attrs[key] = value;
      }
      return {tag,attrs,label};
    });
    const readings = measures.map((measure,index) => {
      const value = measure(x);
      requireValue(scalar(value), "图外读数在 x=" + formatValue(x) + " 时没有有效数值");
      const {label,unit} = axis.readings[index];
      return {label,value,unit:unit ?? ""};
    });
    return {x,marks,readings};
  }
  if (figure.motion!==undefined) return {figure,...compileMotion(figure,at(0).marks)};
  // 验收与播放使用完全相同的离散位置，避免中途除零后呈现错误数字。
  for (let tick=0; tick <= (axis ? TICKS : 0); tick++) at(tick);
  return {figure,at,durationMs:0};
}
export function formatValue(value) { return String(Number(value.toPrecision(5))); }
export function figureKey(line) {
  return /^!\[[^\]\r\n]{1,180}\]\(lawa-figure:([a-z][a-z0-9-]{0,39})\)$/.exec(line.trim())?.[1];
}
