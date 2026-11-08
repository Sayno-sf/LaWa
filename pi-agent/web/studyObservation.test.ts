import assert from "node:assert/strict";
import test from "node:test";
import { classifyStudyFace, StudyClock } from "./src/studyObservation.js";
test("face observations distinguish missing, multiple, head turn and sustained closure", () => {
  const points = Array.from({length:468}, () => ({x:.5,y:.5})); points[33]!.x=.3; points[263]!.x=.7;
  assert.equal(classifyStudyFace([points],0),"FOCUSED");
  points[1]!.x=.31; assert.equal(classifyStudyFace([points],0),"AWAY");
  points[1]!.x=.5; assert.equal(classifyStudyFace([points],.95),"AWAY");
  assert.equal(classifyStudyFace([],0),"NO_FACE"); assert.equal(classifyStudyFace([points,points],0),"UNKNOWN");
});
test("clock needs stable fresh observations; distraction, hidden tab, sleep and model wait cannot count as focus", () => {
  const c = new StudyClock(0);
  for(let at=0;at<=4000;at+=500){c.tick(at,false,true);c.sample("FOCUSED",at);}
  assert.equal(c.take().focusedMs,2000);
  c.sample("AWAY",4000); c.tick(4500,false,true); assert.equal(c.take().focusedMs,0);
  for(let at=5000;at<=8000;at+=500){c.tick(at,true,true);c.sample("FOCUSED",at);}
  const waiting=c.take();assert.equal(waiting.focusedMs,0);assert.ok(waiting.waitingMs>0);
  c.tick(8500,false,false);c.suspend(8500);c.tick(9000,false,true);assert.equal(c.take().focusedMs,0);
  c.tick(60000,false,true);c.sample("FOCUSED",60000);assert.equal(c.current(60000,true),"UNKNOWN");
  assert.equal(c.current(62000,true),"UNKNOWN");assert.equal(c.current(62000,false),"HIDDEN");
});
