export interface ConversationAttachment {
  id: string;
  name: string;
  isImage: boolean;
}

const marker = "LAWA_ATTACHMENT_REFS";
const identity = /^mat-[0-9a-f]{32}$/;

export function attachmentReferences(attachments: readonly ConversationAttachment[]): string {
  return `[${marker}]${JSON.stringify(attachments.map(({id, name, isImage}) => ({id, name, isImage})))}[/${marker}]`;
}

/** 只恢复原user消息里的附件身份，不能凭聊天标记取得资料读取权限或提供外部图片URL。 */
export function projectConversationAttachments(text: string): ConversationAttachment[] {
  const found = text.match(/\[LAWA_ATTACHMENT_REFS\]([\s\S]*?)\[\/LAWA_ATTACHMENT_REFS\]/);
  if (!found) {
    // 兼容清单出现前由Web生成的三种固定引用；不从任意正文/模型回复抓取ID或URL。
    const legacy = text.match(/\[LAWA_MATERIAL_CONTEXT\]\s*([\s\S]*?)\s*\[\/LAWA_MATERIAL_CONTEXT\]/)?.[1];
    if (!legacy || legacy.length > 64_000) return [];
    const seen = new Set<string>();
    return legacy.split("\n").flatMap(line => {
      const row = line.trim().match(/^(?:请先读取|请看看这张)「([^\r\n]{1,255})」（material_id: (mat-[0-9a-f]{32})）(?:，再依据资料帮我规划学习目标和路线。|，结合我当前的学习内容讲解它的含义，来源请在回复末尾简短列出。|的(?:前几张幻灯片|开头部分)，结合我当前的学习内容讲解，来源请在回复末尾简短列出。)$/);
      if (!row || seen.has(row[2]!) || seen.size >= 128) return [];
      seen.add(row[2]!);
      return [{id: row[2]!, name: row[1]!, isImage: /\.(png|jpe?g|webp|tiff)$/i.test(row[1]!)}];
    });
  }
  if (found[1]!.length > 64_000) return [];
  try {
    const value: unknown = JSON.parse(found[1]!);
    if (!Array.isArray(value) || value.length > 128) return [];
    const seen = new Set<string>();
    return value.filter((row): row is ConversationAttachment => {
      if (!row || typeof row !== "object" || !identity.test(row.id) || typeof row.name !== "string"
          || !row.name.trim() || row.name.length > 255 || typeof row.isImage !== "boolean" || seen.has(row.id)) return false;
      seen.add(row.id); return true;
    }).map(({id, name, isImage}) => ({id, name, isImage}));
  } catch { return []; }
}
