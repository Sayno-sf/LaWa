import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ConversationCatalog} from "./conversationCatalog.js";
import {GoalRecycle, type KernelRecycle, type KernelRequest} from "./goalRecycle.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lawa-recycle-"));
  const catalog = new ConversationCatalog(directory);
  const state: KernelRecycle = {goals: [], drafts: []};
  const calls: string[] = [];
  let failPath: string | null = null;
  const kernel: KernelRequest = async (path, method) => {
    calls.push(`${method} ${path}`);
    if (path === failPath) {failPath = null; throw new Error("Kernel write unavailable");}
    if (path === "/api/user/recycle") return structuredClone(state);
    const goal = path.match(/^\/api\/user\/goals\/(.+)$/)?.[1];
    if (goal) {
      const id = decodeURIComponent(goal);
      if (!state.goals.some(row => row.goal_id === id)) state.goals.push({goal_id: id, name: id, deleted_at: new Date().toISOString(), skill_count: 1, evidence_count: 1});
      return {};
    }
    const recycled = path.match(/^\/api\/user\/recycle\/goals\/([^/]+)/)?.[1];
    if (recycled) {state.goals = state.goals.filter(row => row.goal_id !== decodeURIComponent(recycled)); return {};}
    const draft = path.match(/^\/api\/user\/recycle\/drafts\/([^/]+)\/(delete|restore|purge)$/);
    if (draft) {
      const scope = "draft:" + decodeURIComponent(draft[1]!);
      if (draft[2] === "delete") state.drafts.push(scope);
      if (draft[2] === "restore") state.drafts = state.drafts.filter(row => row !== scope);
      return {};
    }
    throw new Error("Unexpected kernel route: " + path);
  };
  return {directory, catalog, state, kernel, calls, fail: (path: string) => {failPath = path;},
    close: () => rmSync(directory, {recursive: true, force: true})};
}

test("one failed recycle recovery does not block intact conversations or other cleanup", async () => {
  const f = fixture();
  try {
    const a=f.catalog.create(), b=f.catalog.create(), c=f.catalog.create();
    f.catalog.recordGoal(a,'a','A'); f.catalog.recordGoal(b,'b','B'); f.catalog.recordGoal(c,'c','C');
    const original=readFileSync(c.getSessionFile()!, 'utf8');
    const kernel:KernelRequest=async(path,method,body)=>{
      if(path==='/api/user/recycle/goals/a') throw Object.assign(new Error('pending cleanup'),{statusCode:409});
      return f.kernel(path,method,body);
    };
    const recycle=new GoalRecycle(f.catalog,kernel);
    await recycle.recycle('goal','a','A');
    const aItem=(await recycle.list()).find(item=>item.targetId==='a')!;
    await assert.rejects(recycle.act(aItem.id,'purge'),/pending cleanup/);
    await recycle.recycle('goal','b','B');
    const bItem=(await recycle.list()).find(item=>item.targetId==='b')!;
    f.fail('/api/user/recycle/goals/b');
    await assert.rejects(recycle.act(bItem.id,'purge'),/unavailable/);
    await recycle.recover();
    assert.equal((await recycle.list()).find(item=>item.targetId==='a')?.phase,'purging');
    assert.ok(!(await recycle.list()).some(item=>item.targetId==='b'));
    assert.equal(readFileSync(c.getSessionFile()!, 'utf8'),original);
    assert.ok((await f.catalog.list()).some(item=>item.id===c.getSessionId()));
  } finally {f.close();}
});

test("independent Goal observation cleanup stays retryable after Kernel purge", async () => {
  const f = fixture(); let attempts = 0;
  try {
    const manager = f.catalog.create(); f.catalog.recordGoal(manager, "a", "A");
    const cleanup = async (goalId: string) => { assert.equal(goalId, "a"); if (++attempts === 1) throw new Error("observation file locked"); };
    const recycle = new GoalRecycle(f.catalog, f.kernel, undefined, cleanup);
    await recycle.recycle("goal", "a", "A"); const item = (await recycle.list())[0]!;
    assert.equal(attempts, 0, "ordinary recycling retains study records");
    await assert.rejects(recycle.act(item.id, "purge"), /observation file locked/);
    assert.equal((await recycle.list())[0]?.phase, "purging");
    await new GoalRecycle(f.catalog, f.kernel, undefined, cleanup).recover();
    assert.equal(attempts, 2); assert.equal((await recycle.list()).length, 0);
  } finally { f.close(); }
});

test("whole Goal recycles every dedicated conversation including legacy trash; shared files and other goals stay intact", async () => {
  const f = fixture();
  try {
    const a = f.catalog.create(), a2 = f.catalog.create(), b = f.catalog.create(), shared = f.catalog.create();
    f.catalog.recordGoal(a, "a", "目标 A"); f.catalog.recordGoal(a2, "a", "目标 A");
    f.catalog.recordGoal(b, "b", "目标 B");
    f.catalog.recordGoal(shared, "a", "目标 A"); f.catalog.recordGoal(shared, "b", "目标 B");
    const original = readFileSync(a.getSessionFile()!, "utf8");
    await f.catalog.trash(a2.getSessionId());
    const recycle = new GoalRecycle(f.catalog, f.kernel);
    assert.equal((await recycle.list())[0]?.kind, "chat", "legacy trash must not silently delete goals");
    await recycle.recycle("goal", "a", "目标 A");
    assert.deepEqual((await f.catalog.list()).map(row => row.id).sort(), [b.getSessionId(), shared.getSessionId()].sort());
    const bin = await recycle.list(); assert.equal(bin.length, 1); assert.equal(bin[0]!.sessionIds.length, 2);
    assert.equal(f.state.goals.length, 1);
    await new GoalRecycle(f.catalog, f.kernel).act(bin[0]!.id, "restore");
    assert.equal((await f.catalog.list()).length, 4);
    assert.equal(readFileSync(a.getSessionFile()!, "utf8"), original);
    assert.equal(f.state.goals.length, 0);
    assert.equal((await recycle.list()).length, 0);
  } finally {f.close();}
});

test("delete interrupted after Kernel commit replays on restart; restore interrupted after file movement also replays", async () => {
  const f = fixture();
  try {
    const manager = f.catalog.create(); f.catalog.recordGoal(manager, "a", "A");
    const archive = f.catalog.archiveFiles.bind(f.catalog);
    f.catalog.archiveFiles = async () => {throw new Error("file temporarily locked");};
    const recycle = new GoalRecycle(f.catalog, f.kernel);
    await assert.rejects(recycle.recycle("goal", "a", "A"), /locked/);
    assert.equal(f.state.goals.length, 1);
    assert.equal((await recycle.list())[0]?.phase, "deleting");
    f.catalog.archiveFiles = archive;
    const restarted = new GoalRecycle(f.catalog, f.kernel); await restarted.recover();
    assert.equal((await f.catalog.list()).length, 0);
    const item = (await restarted.list())[0]!;
    f.fail("/api/user/recycle/goals/a/restore");
    await assert.rejects(restarted.act(item.id, "restore"), /unavailable/);
    assert.equal(f.state.goals.length, 1, "files alone cannot restore learning access");
    assert.equal((await f.catalog.list()).length, 1);
    await new GoalRecycle(f.catalog, f.kernel).recover();
    assert.equal(f.state.goals.length, 0);
    assert.equal((await restarted.list()).length, 0);
  } finally {f.close();}
});

test("purge failure retains a retryable item; resume completes without affecting shared conversations", async () => {
  const f = fixture();
  try {
    const a = f.catalog.create(), shared = f.catalog.create();
    f.catalog.recordGoal(a, "a", "A"); f.catalog.recordGoal(shared, "a", "A"); f.catalog.recordGoal(shared, "b", "B");
    const recycle = new GoalRecycle(f.catalog, f.kernel); await recycle.recycle("goal", "a", "A");
    const item = (await recycle.list())[0]!;
    f.fail("/api/user/recycle/goals/a");
    await assert.rejects(recycle.act(item.id, "purge"), /unavailable/);
    assert.equal((await recycle.list())[0]?.phase, "purging");
    await new GoalRecycle(f.catalog, f.kernel).recover();
    assert.equal((await recycle.list()).length, 0);
    assert.equal((await f.catalog.list())[0]!.id, shared.getSessionId());
    assert.equal(f.state.goals.length, 0);
  } finally {f.close();}
});

test("draft and clear-chat use their own scopes; unknown ids cannot traverse directories", async () => {
  const f = fixture();
  try {
    const draft = f.catalog.create(), chat = f.catalog.create(); f.catalog.recordGoal(chat, "a", "A");
    const recycle = new GoalRecycle(f.catalog, f.kernel);
    await recycle.recycle("draft", draft.getSessionId(), "草稿", [draft.getSessionId()]);
    await recycle.recycle("chat", chat.getSessionId(), "聊天", [chat.getSessionId()]);
    assert.equal(f.state.goals.length, 0);
    assert.deepEqual(f.state.drafts, ["draft:" + draft.getSessionId()]);
    await assert.rejects(recycle.act("../../outside", "purge"), /不存在/);
    const items = await recycle.list(); assert.equal(items.length, 2);
    for (const item of items) await recycle.act(item.id, "restore");
    assert.equal((await f.catalog.list()).length, 2);
    assert.equal((await recycle.list()).length, 0);
  } finally {f.close();}
});

test("shared conversation can select the surviving goal's own branch and retain structured material references", async () => {
  const f = fixture();
  try {
    const shared = f.catalog.create(), dedicated = f.catalog.create();
    f.catalog.recordGoal(shared, "b", "B");
    const material = "mat-" + "a".repeat(32);
    shared.appendMessage({role: "assistant", content: [{type: "text", text: "B的原学习内容 " + material}], timestamp: Date.now()} as any);
    f.catalog.recordGoal(shared, "a", "A");
    shared.appendMessage({role: "assistant", content: [{type: "text", text: "A的末尾"}], timestamp: Date.now()} as any);
    f.catalog.recordGoal(dedicated, "b", "B");
    f.catalog.selectGoalBranch(shared, "b");
    assert.equal(f.catalog.goalObservation(shared)?.goalId, "b");
    assert.equal(shared.getBranch().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("A的末尾")), false);
    assert.deepEqual(await f.catalog.materialReferencesOutside("a"), {[material]: "b"});
  } finally {f.close();}
});
