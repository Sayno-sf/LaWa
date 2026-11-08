import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeCardNotice } from "../../web/src/knowledgeCardNotice.js";

test("existing cards form a baseline; repeated snapshots and edits do not notify", () => {
  const notice = new KnowledgeCardNotice();
  notice.observe("goal", ["old"]);
  notice.observe("goal", ["old"]);
  assert.equal(notice.count("goal", ["old"]), 0);
  notice.observe("goal", ["old", "new"]);
  notice.observe("goal", ["old", "new"]);
  assert.equal(notice.count("goal", ["old", "new"]), 1);
});

test("only opening the displayed skill acknowledges its cards", () => {
  const notice = new KnowledgeCardNotice();
  notice.observe("goal", []);
  notice.observe("goal", ["first-skill", "second-skill"]);
  notice.markViewed("goal", ["first-skill"]);
  assert.equal(notice.count("goal", ["first-skill"]), 0);
  assert.equal(notice.count("goal", ["second-skill"]), 1);
});

test("first cards from a live teaching turn notify even before the goal has a baseline", () => {
  const notice = new KnowledgeCardNotice();
  notice.observe("new-goal", ["first-card"], true);
  assert.equal(notice.count("new-goal", ["first-card"]), 1);
  notice.markViewed("new-goal", ["first-card"]);
  notice.observe("new-goal", ["first-card"], true);
  assert.equal(notice.count("new-goal", ["first-card"]), 0);
});

test("equal card counts and deletions use identity instead of count differences", () => {
  const notice = new KnowledgeCardNotice();
  notice.observe("goal", ["old"]);
  notice.observe("goal", ["new"]);
  assert.equal(notice.count("goal", ["new"]), 1);
  notice.observe("goal", []);
  assert.equal(notice.count("goal", ["new"]), 0);
});

test("refresh restores unread cards and acknowledged cards stay quiet", () => {
  const before = new KnowledgeCardNotice();
  before.observe("goal", []);
  before.observe("goal", ["new"]);
  const restored = new KnowledgeCardNotice(before.serialize());
  restored.observe("goal", ["new"]);
  assert.equal(restored.count("goal", ["new"]), 1);
  restored.markViewed("goal", ["new"]);
  assert.equal(new KnowledgeCardNotice(restored.serialize()).count("goal", ["new"]), 0);
});

test("goal changes do not mix cards or discard pending notices", () => {
  const notice = new KnowledgeCardNotice();
  notice.observe("first", []);
  notice.observe("first", ["same-id"]);
  notice.observe("second", ["same-id"]);
  notice.markViewed("second", ["same-id"]);
  notice.observe("first", ["same-id"]);
  assert.equal(notice.count("first", ["same-id"]), 1);
  assert.equal(notice.count("second", ["same-id"]), 0);
});

test("damaged or incompatible browser preferences do not block card display", () => {
  for (const saved of ["broken", "null", '{"version":2,"goals":[]}', '{"version":1,"goals":[["goal",null,[]],["bad",[false],[]]]}']) {
    const notice = new KnowledgeCardNotice(saved);
    notice.observe("goal", ["old"]);
    assert.equal(notice.count("goal", ["old"]), 0);
  }
});
