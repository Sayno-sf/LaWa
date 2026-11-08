import assert from "node:assert/strict";
import test from "node:test";

import {
  abandonTask,
  clearCardNote,
  confirmMastery,
  deleteCard,
  updateCard,
  reopenSkill,
  setCardFeedback,
  setCardNote,
  startPracticing,
} from "./userApi.js";

const mastered = {
  id: "training-loop",
  name: "Training Loop",
  description: "",
  prerequisites: ["pytorch"],
  status: "MASTERED_BY_USER",
  evidence_ids: ["evidence-training-loop"],
};

test("confirmMastery and reopenSkill use the user-owned HTTP routes", async () => {
  const requests: string[] = [];
  const options = {
    baseUrl: "http://learning.test/",
    fetchImpl: async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return Response.json(
        url.endsWith("/reopen")
          ? { ...mastered, status: "PRACTICING" }
          : mastered,
      );
    },
  };

  assert.equal((await confirmMastery("training-loop", options)).status, "MASTERED_BY_USER");
  assert.equal((await reopenSkill("training-loop", options)).status, "PRACTICING");
  assert.deepEqual(requests, [
    "http://learning.test/api/user/skills/training-loop/confirm-mastery",
    "http://learning.test/api/user/skills/training-loop/reopen",
  ]);
});

test("user-owned HTTP errors preserve the server detail", async () => {
  await assert.rejects(
    confirmMastery("cnn", {
      fetchImpl: async () =>
        Response.json(
          { detail: "Only a practicing Skill can be user-confirmed" },
          { status: 409 },
        ),
    }),
    /HTTP 409: Only a practicing Skill can be user-confirmed/,
  );
});

test("mastery invitations bind the exact expected Goal and Task without changing legacy user actions", async () => {
  const requests: Array<{url:string;body:unknown;contentType:string|null}> = [];
  const options = {baseUrl: "http://learning.test", masteryScope: {goalId:"goal",taskId:"task"},
    fetchImpl: async (input:string|URL|Request, init?:RequestInit) => {
      requests.push({url:String(input),body:init?.body,contentType:new Headers(init?.headers).get("Content-Type")});
      return Response.json(mastered);
    }};
  await confirmMastery("training-loop", options);
  await reopenSkill("training-loop", options);
  assert.deepEqual(JSON.parse(String(requests[0]!.body)), {expected_goal_id:"goal",expected_task_id:"task"});
  assert.equal(requests[0]!.contentType,"application/json");
  assert.equal(requests[1]!.body,undefined,"mastery scope must not add authority to other user actions");
  assert.equal(requests[1]!.contentType,null);
});

test("an invalid invitation scope cannot fall back to unscoped manual confirmation", async () => {
  let calls = 0;
  for (const masteryScope of [{goalId:"",taskId:"task"}, {goalId:"goal",taskId:" "}]) {
    await assert.rejects(confirmMastery("training-loop", {masteryScope,
      fetchImpl: async () => {calls++;return Response.json(mastered);}}), /exact Goal and Task scope/);
  }
  assert.equal(calls,0);
});

test("startPracticing uses the user-owned practice route", async () => {
  const requests: string[] = [];
  const result = await startPracticing("cnn", {
    baseUrl: "http://learning.test",
    fetchImpl: async (input) => {
      requests.push(String(input));
      return Response.json({
        id: "cnn",
        name: "CNN",
        description: "",
        prerequisites: ["pytorch"],
        status: "PRACTICING",
        evidence_ids: [],
      });
    },
  });

  assert.deepEqual(requests, [
    "http://learning.test/api/user/skills/cnn/start-practicing",
  ]);
  assert.equal(result.status, "PRACTICING");
});

test("abandonTask uses the user-owned task route", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const result = await abandonTask("task-old", {
    baseUrl: "http://learning.test/",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({
        id: "task-old",
        title: "Old task",
        description: "",
        related_skill_ids: ["cnn"],
        expected_evidence_types: ["EXPLAIN"],
        status: "SKIPPED",
      });
    },
  });

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/tasks/task-old/abandon",
      method: "POST",
    },
  ]);
  assert.equal(result.status, "SKIPPED");
});

test("setCardFeedback posts the status to the card feedback route", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const result = await setCardFeedback(
    "card-1",
    { status: "GOOD" },
    {
      baseUrl: "http://learning.test/",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return Response.json({ id: "card-1", feedback: "GOOD" });
      },
    },
  );

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/cards/card-1/feedback",
      method: "POST",
      body: JSON.stringify({ status: "GOOD" }),
    },
  ]);
  assert.deepEqual(result, { id: "card-1", feedback: "GOOD" });
});

test("setCardNote puts the note to the card note route", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const result = await setCardNote(
    "card-1",
    { note: "复习时重点记这一点" },
    {
      baseUrl: "http://learning.test/",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return Response.json({ id: "card-1", learner_note: "复习时重点记这一点" });
      },
    },
  );

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/cards/card-1/note",
      method: "PUT",
      body: JSON.stringify({ note: "复习时重点记这一点" }),
    },
  ]);
  assert.deepEqual(result, { id: "card-1", learner_note: "复习时重点记这一点" });
});

test("clearCardNote deletes the card note route without a body", async () => {
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const result = await clearCardNote("card-1", {
    baseUrl: "http://learning.test/",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
      });
      return Response.json({ id: "card-1", learner_note: null });
    },
  });

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/cards/card-1/note",
      method: "DELETE",
      body: undefined,
    },
  ]);
  assert.deepEqual(result, { id: "card-1", learner_note: null });
});

test("deleteCard sends DELETE to the card route without a body", async () => {
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const result = await deleteCard("card-1", {
    baseUrl: "http://learning.test/",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
      });
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/cards/card-1",
      method: "DELETE",
      body: undefined,
    },
  ]);
});

test("updateCard sends PUT with question and answer body", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const result = await updateCard("card-1", { question: "新问题？", answer: "新答案。" }, {
    baseUrl: "http://learning.test/",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      return Response.json({ id: "card-1", question: "新问题？", answer: "新答案。" });
    },
  });

  assert.deepEqual(requests, [
    {
      url: "http://learning.test/api/user/cards/card-1",
      method: "PUT",
      body: JSON.stringify({ question: "新问题？", answer: "新答案。" }),
    },
  ]);
  assert.deepEqual(result, { id: "card-1", question: "新问题？", answer: "新答案。" });
});

test("card actions preserve User API HTTP error details", async () => {
  await assert.rejects(
    setCardFeedback("card-x", { status: "GOOD" }, {
      fetchImpl: async () =>
        Response.json({ detail: "Card not found" }, { status: 404 }),
    }),
    /User API returned HTTP 404: Card not found/,
  );
});
