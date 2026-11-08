import assert from "node:assert/strict";
import test from "node:test";

import {
  activateLearningTask,
  createActivateLearningTaskTool,
  completeLearningTask,
  createCompleteLearningTaskTool,
  createCreateKnowledgeCardTool,
  createCreateLearningTaskTool,
  createKnowledgeCard,
  createSubmitEvidenceTool,
  createLearningTask,
  submitEvidence,
} from "./learningWriteTools.js";

const todoTask = {
  id: "task-new",
  title: "实现 CNN classifier",
  description: "连接网络与训练循环",
  related_skill_ids: ["cnn-classifier"],
  expected_evidence_types: ["BUILD"],
  status: "TODO",
};

test("create_learning_task posts one task and returns it as TODO", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedBody = "";
  const task = await createLearningTask(
    {
      title: todoTask.title,
      description: todoTask.description,
      related_skill_ids: todoTask.related_skill_ids,
      expected_evidence_types: ["BUILD"],
    },
    {
      baseUrl: "http://learning.test/",
      log: () => undefined,
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedMethod = init?.method ?? "";
        requestedBody = String(init?.body);
        return Response.json(todoTask, { status: 201 });
      },
    },
  );

  assert.equal(requestedUrl, "http://learning.test/api/learning/tasks");
  assert.equal(requestedMethod, "POST");
  assert.deepEqual(JSON.parse(requestedBody), {
    title: "实现 CNN classifier",
    description: "连接网络与训练循环",
    related_skill_ids: ["cnn-classifier"],
    expected_evidence_types: ["BUILD"],
  });
  assert.equal(task.status, "TODO");
});

test("create_learning_task Pi tool returns the created task", async () => {
  const tool = createCreateLearningTaskTool({
    log: () => undefined,
    fetchImpl: async () => Response.json(todoTask, { status: 201 }),
  });
  const result = await tool.execute(
    "call-create",
    {
      title: todoTask.title,
      description: todoTask.description,
      related_skill_ids: ["cnn-classifier"],
      expected_evidence_types: ["BUILD"],
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  const content = result.content[0];
  assert.equal(content?.type, "text");
  assert.match(content?.type === "text" ? content.text : "", /task-new/);
  assert.deepEqual(result.details, { taskId: "task-new", status: "TODO" });
});

test("activate_learning_task posts to the explicit activation endpoint", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  const activated = await activateLearningTask("task-new", {
    baseUrl: "http://learning.test/",
    log: () => undefined,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "";
      return Response.json({ ...todoTask, status: "ACTIVE" });
    },
  });

  assert.equal(
    requestedUrl,
    "http://learning.test/api/learning/tasks/task-new/activate",
  );
  assert.equal(requestedMethod, "POST");
  assert.equal(activated.status, "ACTIVE");
});

test("activate_learning_task Pi tool returns the activated task", async () => {
  const tool = createActivateLearningTaskTool({
    log: () => undefined,
    fetchImpl: async () =>
      Response.json({ ...todoTask, status: "ACTIVE" }),
  });
  const result = await tool.execute(
    "call-activate",
    { task_id: "task-new" },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  assert.deepEqual(result.details, { taskId: "task-new", status: "ACTIVE" });
});

test("complete_learning_task posts to the task completion endpoint", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  const completed = await completeLearningTask("task-new", {
    baseUrl: "http://learning.test/",
    log: () => undefined,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "";
      return Response.json({ ...todoTask, status: "DONE" });
    },
  });

  assert.equal(
    requestedUrl,
    "http://learning.test/api/learning/tasks/task-new/complete",
  );
  assert.equal(requestedMethod, "POST");
  assert.equal(completed.status, "DONE");
});

test("complete_learning_task Pi tool returns the completed task", async () => {
  const tool = createCompleteLearningTaskTool({
    log: () => undefined,
    fetchImpl: async () => Response.json({ ...todoTask, status: "DONE" }),
  });
  const result = await tool.execute(
    "call-complete",
    { task_id: "task-new" },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  assert.deepEqual(result.details, { taskId: "task-new", status: "DONE" });
});

test("submit_evidence posts the explicit evidence and assistance level", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const evidence = await submitEvidence(
    {
      skill_id: "training-loop",
      evidence_type: "BUILD",
      description: "照着教程完成 validation",
      assistance_level: "WITH_REFERENCE",
      source: "user report",
    },
    {
      baseUrl: "http://learning.test/",
      log: () => undefined,
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedBody = String(init?.body);
        return Response.json(
          {
            id: "evidence-new",
            ...JSON.parse(requestedBody),
            created_at: "2026-09-16T00:00:00Z",
          },
          { status: 201 },
        );
      },
    },
  );

  assert.equal(requestedUrl, "http://learning.test/api/learning/evidence");
  assert.equal(JSON.parse(requestedBody).assistance_level, "WITH_REFERENCE");
  assert.equal(evidence.id, "evidence-new");
});

test("submit_evidence Pi tool returns the linked evidence", async () => {
  const tool = createSubmitEvidenceTool({
    log: () => undefined,
    fetchImpl: async () =>
      Response.json(
        {
          id: "evidence-new",
          skill_id: "training-loop",
          evidence_type: "BUILD",
          description: "独立完成 validation",
          assistance_level: "INDEPENDENT",
          source: "user report",
          created_at: "2026-09-16T00:00:00Z",
        },
        { status: 201 },
      ),
  });
  const result = await tool.execute(
    "call-evidence",
    {
      skill_id: "training-loop",
      evidence_type: "BUILD",
      description: "独立完成 validation",
      assistance_level: "INDEPENDENT",
      source: "user report",
    },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  assert.deepEqual(result.details, {
    evidenceId: "evidence-new",
    skillId: "training-loop",
    assistanceLevel: "INDEPENDENT",
  });
});

test("write tools preserve Learning API conflict details", async () => {
  await assert.rejects(
    createLearningTask(
      {
        title: "duplicate",
        description: "duplicate",
        related_skill_ids: ["cnn"],
        expected_evidence_types: ["BUILD"],
      },
      {
        log: () => undefined,
        fetchImpl: async () =>
          Response.json(
            { detail: "Duplicate current LearningTask" },
            { status: 409 },
          ),
      },
    ),
    /HTTP 409: Duplicate current LearningTask/,
  );
});

const cardPayload = {
  id: "card-new",
  skill_id: "cnn",
  question: "什么是卷积核？",
  answer: "卷积核是滑动窗口权重。",
  created_at: "2026-09-22T00:00:00Z",
  source_conversation_id: "conv-1",
  feedback: null,
  feedback_updated_at: null,
  learner_note: null,
  note_updated_at: null,
};

test("create_knowledge_card posts skill, question and answer to the cards endpoint", async () => {
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedBody = "";
  const card = await createKnowledgeCard(
    {
      skill_id: "cnn",
      question: "什么是卷积核？",
      answer: "卷积核是滑动窗口权重。",
      source_conversation_id: "conv-1",
    },
    {
      baseUrl: "http://learning.test/",
      log: () => undefined,
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedMethod = init?.method ?? "";
        requestedBody = String(init?.body);
        return Response.json(cardPayload, { status: 201 });
      },
    },
  );

  assert.equal(requestedUrl, "http://learning.test/api/learning/cards");
  assert.equal(requestedMethod, "POST");
  assert.deepEqual(JSON.parse(requestedBody), {
    skill_id: "cnn",
    question: "什么是卷积核？",
    answer: "卷积核是滑动窗口权重。",
    source_conversation_id: "conv-1",
  });
  assert.equal(card.id, "card-new");
  assert.equal(card.source_conversation_id, "conv-1");
});

test("create_knowledge_card Pi tool exposes the fixed tool name and returns the created card", async () => {
  const tool = createCreateKnowledgeCardTool({
    log: () => undefined,
    fetchImpl: async () => Response.json(cardPayload, { status: 201 }),
  });
  assert.equal(tool.name, "create_knowledge_card");
  assert.match(tool.description, /coherent learning unit.*preferably after related practice/);
  assert.match(tool.description, /practice is not a mandatory gate/);
  assert.match(tool.description, /knowledge_cards.*avoid duplicate/);
  assert.match(tool.description, /defer instead of fetching overview on every message/);
  const result = await tool.execute(
    "call-card",
    { skill_id: "cnn", question: "什么是卷积核？", answer: "卷积核是滑动窗口权重。" },
    new AbortController().signal,
    undefined,
    {} as Parameters<typeof tool.execute>[4],
  );

  const content = result.content[0];
  assert.equal(content?.type, "text");
  assert.match(content?.type === "text" ? content.text : "", /card-new/);
  assert.deepEqual(result.details, { cardId: "card-new", skillId: "cnn" });
});

test("create_knowledge_card preserves Learning API HTTP error details", async () => {
  await assert.rejects(
    createKnowledgeCard(
      { skill_id: "cnn", question: "q", answer: "a" },
      {
        log: () => undefined,
        fetchImpl: async () =>
          Response.json({ detail: "Skill not found" }, { status: 404 }),
      },
    ),
    /HTTP 404: Skill not found/,
  );
});

test("create_knowledge_card rejects an invalid knowledge card payload", async () => {
  await assert.rejects(
    createKnowledgeCard(
      { skill_id: "cnn", question: "q", answer: "a" },
      {
        log: () => undefined,
        fetchImpl: async () =>
          Response.json({ id: "card-new", skill_id: "cnn" }, { status: 201 }),
      },
    ),
    /invalid knowledge card payload/,
  );
});
