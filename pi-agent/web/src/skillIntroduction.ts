import {renderMarkdown} from "./markdown";

/** 只展开原文已有的连续圈号条目；引文、代码及已有 Markdown 不猜测重写。 */
export function skillIntroductionMarkup(description: string): string {
  if (/[\r\n`]/u.test(description)) return renderMarkdown(description);
  const closing: Record<string,string> = {"（":"）", "(":")", "[":"]", "{":"}", "「":"」", "『":"』", "“":"”", "‘":"’", '"':'"', "'":"'"};
  const quotes: string[] = [];
  const markers: {index:number; number:number}[] = [];
  for (let index=0; index<description.length; index++) {
    const char=description[index]!;
    if (char === "\\") {index++;continue;}
    if (quotes.at(-1) === char) quotes.pop();
    else if (closing[char]) quotes.push(closing[char]!);
    else if (!quotes.length && /[①-⑳]/u.test(char)) markers.push({index,number:char.charCodeAt(0)-"①".charCodeAt(0)+1});
  }
  if (quotes.length || markers.length<2 || markers.some((marker,index)=>marker.number!==index+1)) return renderMarkdown(description);
  const lead=description.slice(0,markers[0]!.index).trim();
  const items=markers.map((marker,index)=>description.slice(marker.index+1,markers[index+1]?.index ?? description.length).trim());
  if (items.some(item=>!item)) return renderMarkdown(description);
  return `${lead ? renderMarkdown(lead) : ""}<ol class="skill-introduction-points">${items.map(item=>`<li>${renderMarkdown(item)}</li>`).join("")}</ol>`;
}
