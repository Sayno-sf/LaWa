import assert from "node:assert/strict";
import test from "node:test";
import {createTeachingEvolutionTools} from "./teachingEvolution.js";

const profile = {id: "goal", learning_domain: "数据库"};
const overview = {goal_profile: profile, current_goal: "学习数据库", current_focus: null, curriculum_spine: [], current_frontier: null,
  skills: [], recent_evidence: [], active_task: null, learning_history: [], current_goal_skill_ids: []};
const args = {text: "可以结束本次学习，也可继续复习。", reason: "逐节点记录已核对", scope: "GOAL" as const,
  assessment_ids: ["assessment-real"], proposal_id: "first-closure", expected_revision: 1};

for (let run = 0; run < 3; run++) {
  test(`new model-named closure starts at Kernel version one (isolated run ${run + 1})`, async () => {
    const writes: Record<string, unknown>[] = [];
    const tool = createTeachingEvolutionTools({fetchImpl: async (url, init) => {
      if (String(url).includes("overview")) return Response.json(overview);
      if (!init?.body) return Response.json({proposal_reference: {id: args.proposal_id, goal_id: "goal", status: "NOT_FOUND"}});
      const body = JSON.parse(String(init.body)); writes.push(body);
      if (body.expected_revision !== 0 || body.revision !== 1)
        return Response.json({detail: "New proposal must start at version 1"}, {status: 409});
      return Response.json({...body, status: "PENDING"});
    }}).find(tool => tool.name === "suggest_goal_completion")!;
    const result = await tool.execute(`fresh-${run}`, args, new AbortController().signal, undefined, {} as never);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.revision, 1);
    assert.equal(writes[0]!.expected_revision, 0);
    assert.match(JSON.stringify(result), /PENDING/);
  });
}

test("a missing identity with a higher revision is not silently recreated", async () => {
  let writes = 0;
  const tool = createTeachingEvolutionTools({fetchImpl: async (url, init) => {
    if (String(url).includes("overview")) return Response.json(overview);
    if (!init?.body) return Response.json({proposal_reference: {id: args.proposal_id, goal_id: "goal", status: "NOT_FOUND"}});
    writes++; return Response.json({});
  }}).find(tool => tool.name === "suggest_goal_completion")!;
  await assert.rejects(() => tool.execute("stale-missing", {...args, expected_revision: 4}, new AbortController().signal, undefined, {} as never), /版本|不存在/);
  assert.equal(writes, 0);
});

for (const reference of [
  {status: "DELETED", revision: 1}, {status: "UNAVAILABLE", revision: 1},
  {status: "REJECTED", revision: 1}, {status: "CONFIRMED", revision: 1},
  {status: "REVISION_REQUESTED", revision: 2},
]) {
  test(`old ${reference.status} version ${reference.revision} is not revived by a first-version call`, async () => {
    let writes = 0;
    const tool = createTeachingEvolutionTools({log: () => undefined, fetchImpl: async (url, init) => {
      if (String(url).includes("overview")) return Response.json(overview);
      if (!init?.body) return Response.json({proposal_reference: {id: args.proposal_id, goal_id: "goal", kind: "CLOSURE", ...reference}});
      writes++; return Response.json({});
    }}).find(tool => tool.name === "suggest_goal_completion")!;
    await assert.rejects(() => tool.execute("old-identity", args, new AbortController().signal, undefined, {} as never));
    assert.equal(writes, 0);
  });
}
