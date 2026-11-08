import type {ReadingJob, ReadingNote} from "./materialReading.js";

export interface ReadingContextNode {ref: string; start: number; end: number; level: number; note: ReadingNote;
  model: {provider: string; id: string}; citation_refs: string[]}
export interface ReadingFold extends ReadingNote {lease_id: string; start: number; end: number; input_refs: string[];
  input_hash: string; max_note_bytes: number; model: {provider: string; id: string}}

const keys = ["summary", "concepts", "facts", "dependencies", "uncertainties"] as const;
export const normalizedReadingNote = (note: ReadingNote): ReadingNote => ({summary: note.summary.trim(),
  ...Object.fromEntries(keys.slice(1).map(key => [key, ((note[key] ?? []) as string[]).map(value => value.trim())]))});
export function readingNoteBytes(note: ReadingNote): number {
  return Buffer.byteLength(JSON.stringify(normalizedReadingNote(note)), "utf8");
}

/** 仅改变发给模型的机器笔记投影；全部原始笔记与中间节点仍可在原资源中展开复核。 */
export function materialReadingContext(job: Pick<ReadingJob, "notes" | "folds">): ReadingContextNode[] {
  const nodes = new Map<string, ReadingContextNode>(), cover = new Map<number, ReadingContextNode>();
  job.notes.forEach((note, index) => nodes.set(note.lease_id, {ref: note.lease_id, start: index, end: index + 1,
    level: 0, note: normalizedReadingNote(note), model: note.model, citation_refs: note.batch.citation_refs}));
  for (const fold of job.folds ?? []) {
    const children = fold.input_refs.map(ref => nodes.get(ref));
    if (children.length < 2 || children.some(node => !node) || nodes.has(fold.lease_id)
        || children[0]!.start !== fold.start || children.at(-1)!.end !== fold.end
        || children.some((node, i) => i > 0 && children[i - 1]!.end !== node!.start)) throw new Error("READING_CONTEXT_INVALID");
    const node: ReadingContextNode = {ref: fold.lease_id, start: fold.start, end: fold.end,
      level: Math.max(...children.map(child => child!.level)) + 1, note: normalizedReadingNote(fold), model: fold.model, citation_refs: []};
    nodes.set(node.ref, node);
    if (!cover.has(node.start) || cover.get(node.start)!.end <= node.end) cover.set(node.start, node);
  }
  const projected: ReadingContextNode[] = [];
  for (let index = 0; index < job.notes.length;) {
    const node = cover.get(index) ?? nodes.get(job.notes[index]!.lease_id)!;
    if (!Number.isSafeInteger(node.end) || node.end <= index || node.end > job.notes.length) throw new Error("READING_CONTEXT_INVALID");
    projected.push(node); index = node.end;
  }
  return projected;
}
