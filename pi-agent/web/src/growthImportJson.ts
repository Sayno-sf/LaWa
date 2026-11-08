/** 仅剥离完整代码围栏/BOM，不改写引号、原答换行或代码内容。 */
export function parseGrowthImportJson(input: string): unknown {
  if (new TextEncoder().encode(input).length > 1048576) throw new Error("JSON 超过 1 MiB，请分批导入。");
  let source = input.replace(/^\uFEFF/, "").trim();
  const fenced = source.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) source = fenced[1]!;
  try {return JSON.parse(source);} catch {
    throw new Error("JSON 格式不完整：请保留完整对象并检查括号、引号；无需手动改写原答。可重新复制导出提示词生成。");
  }
}
