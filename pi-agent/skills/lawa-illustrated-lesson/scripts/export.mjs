/** node scripts/export.mjs page.json page.html [art-directory] */
import {lstatSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {BOOK_IMAGE_MODEL,pngSize} from "./bailian.mjs";
import {prepareFigure,figureKey} from "../assets/ink.mjs";
const [input,output,artDirectory] = process.argv.slice(2);
if (!input || !output || resolve(input) === resolve(output)) throw new Error("请提供不同的画稿与 HTML 输出路径");
const lesson = JSON.parse(readFileSync(input,"utf8").replace(/^\uFEFF/,""));
if (typeof lesson.body !== "string" || !lesson.body.trim() || lesson.body.length > 40000 || !Array.isArray(lesson.figures) || !lesson.figures.length || lesson.figures.length > 4) throw new Error("需要正文与 1–4 幅图");
const vectors = [];
const plates = new Map();
const used = new Set();
const esc = value => value.replace(/[&<>"']/g,c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const inline = value => esc(value).replace(/\*\*([^*\n]+)\*\*/g,"<strong>$1</strong>").replace(/\x60([^\x60\n]+)\x60/g,"<code>$1</code>");
for (const value of lesson.figures) {
  if (!value || typeof value!=="object" || plates.has(value.key)) throw new Error("每幅图需要唯一 key");
  if (!("art" in value)) {
    const {figure}=prepareFigure(value);
    vectors.push(figure);
    plates.set(figure.key,'<div data-plate="'+figure.key+'"></div>');
    continue;
  }
  const {key,alt,caption,source,art}=value;
  if (!artDirectory || !/^[a-z][a-z0-9-]{0,39}$/.test(key) || !art || !/^[0-9a-f]{64}$/.test(art.id) ||
      art.model!==BOOK_IMAGE_MODEL || source!=="百炼生成插画" || typeof alt!=="string" || !alt.trim() || alt.length>180 ||
      typeof caption!=="string" || !caption.trim() || caption.length>300) throw new Error("请提供完整的插画来源与本地 PNG 目录");
  const png=join(resolve(artDirectory),art.id+".png"), info=lstatSync(png);
  if (!info.isFile() || info.size>10*1024*1024) throw new Error("本地插画需要是有效大小的 PNG 文件");
  const bytes=readFileSync(png),[width,height]=pngSize(bytes);
  plates.set(key,'<figure class="lesson-plate"><img width="'+width+'" height="'+height+'" alt="'+esc(alt)+'" src="data:image/png;base64,'+
    bytes.toString("base64")+'"><figcaption class="lesson-plate-caption">'+esc(caption)+'<small class="lesson-plate-source">'+source+'</small></figcaption></figure>');
}
const body = lesson.body.trim().split(/\r?\n\s*\r?\n/).map(paragraph => {
  const key = figureKey(paragraph);
  if (key) {
    if (!plates.has(key)) throw new Error("缺少正文所引用的图 " + key);
    used.add(key);
    return plates.get(key);
  }
  const heading = /^(#{1,3})\s+([\s\S]*)$/.exec(paragraph);
  if (heading) return "<h"+heading[1].length+">"+esc(heading[2])+"</h"+heading[1].length+">";
  const lines=paragraph.split(/\r?\n/);
  if (lines.every(line=>/^[-*] /.test(line))) return "<ul>"+lines.map(line=>"<li>"+inline(line.slice(2))+"</li>").join("")+"</ul>";
  return "<p>"+inline(paragraph).replace(/\n/g,"<br>")+"</p>";
}).join("\n");
if (used.size !== plates.size) throw new Error("每幅图需要唯一 key，并在正文中独立成段引用");
const asset = name => readFileSync(new URL("../assets/" + name,import.meta.url),"utf8");
const bundledModule = name => asset(name).replace(/^import [^\n]+;\r?\n/gm,"");
const script = ["motion.mjs","ink.mjs","prediction-view.mjs","reader.mjs"].map(bundledModule).join("\n") + "\n" +
  "const figures=JSON.parse(document.getElementById('ink').textContent);const plates=[];for(const slot of document.querySelectorAll('[data-plate]')){const plate=mountFigure(figures.find(f=>f.key===slot.dataset.plate),{onInteract:()=>plates.forEach(p=>p.pause())});plates.push(plate);slot.replaceWith(plate.node);}window.addEventListener('blur',()=>plates.forEach(p=>p.pause()));";
const title = lesson.body.split(/\r?\n/)[0].replace(/^#+\s*/,"");
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:"><title>'+esc(title)+'</title><style>body{margin:2.5rem auto;padding:0 1.25rem;max-width:42rem;background:#fcfbf7;color:#293a37;font:17px/1.85 system-ui,sans-serif}h1{font-size:1.7em}'+asset("paper.css")+'</style></head><body><main>'+body+'</main><script id="ink" type="application/json">'+JSON.stringify(vectors).replaceAll("<","\\u003c")+'</script><script type="module">'+script+'</script></body></html>';
writeFileSync(output,html);
