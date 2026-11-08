import assert from "node:assert/strict";
import {setImmediate} from "node:timers/promises";
import test from "node:test";
import {MaterialReadingRuntime} from "./materialReadingRuntime.js";

test("startup discovery retries after a temporarily unavailable Kernel without a learner message", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let discoveries = 0;
  const failures: string[] = [];
  const runtime = new MaterialReadingRuntime({baseUrl: "http://isolated-discovery.invalid", selection: async () => {
    assert.fail("no model work without a discovered resource");
  }, onError: code => failures.push(code), fetcher: async () => {
    discoveries++;
    return discoveries === 1 ? new Response(JSON.stringify({code: "KERNEL_STARTING"}), {status: 503})
      : Response.json({jobs: [], next_offset: null});
  }});
  try {
    runtime.start(); await setImmediate();
    assert.equal(discoveries, 1); assert.deepEqual(failures, ["KERNEL_STARTING"]);
    t.mock.timers.tick(29_999); await setImmediate(); assert.equal(discoveries, 1);
    t.mock.timers.tick(1); await setImmediate(); assert.equal(discoveries, 2);
    t.mock.timers.tick(90_000); await setImmediate(); assert.equal(discoveries, 2, "successful empty discovery must not poll the catalog");
  } finally {runtime.dispose();}
});

test("disposing failed startup discovery removes its scheduled retry", async t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let discoveries = 0;
  const runtime = new MaterialReadingRuntime({baseUrl: "http://disposed-discovery.invalid", selection: async () => {
    assert.fail("no model request");
  }, fetcher: async () => {discoveries++; throw new Error("offline");}});
  runtime.start(); await setImmediate(); runtime.dispose();
  t.mock.timers.tick(90_000); await setImmediate(); assert.equal(discoveries, 1);
});
