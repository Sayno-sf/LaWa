/** 保存组件后的会话重投影只替换权威内容；保留当前页面已经展示的用户附件。 */
export function preserveConversationAttachments<T extends { role: string; content: string; entryId?: string; attachments?: unknown[] }>(saved: T[], displayed: T[]): T[] {
  const users = displayed.filter(message => message.role === "user");
  const byId = new Map(users.filter(message => message.entryId).map(message => [message.entryId!, message]));
  let userIndex = 0;
  return saved.map(message => {
    if (message.role !== "user") return message;
    const atIndex = users[userIndex++];
    const previous = message.entryId ? byId.get(message.entryId) : undefined;
    // 新提交的页面消息还没有Pi ID，只允许同一用户序位、相同文字的待确认附件配对。
    const pending = !atIndex?.entryId && atIndex?.content.trim() === message.content.trim() ? atIndex : undefined;
    const attachments = (previous ?? pending)?.attachments;
    return attachments?.length ? { ...message, attachments } : message;
  });
}
