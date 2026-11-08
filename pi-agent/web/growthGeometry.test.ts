import assert from "node:assert/strict";
import test from "node:test";
import {mapPositions, radarVertex} from "./src/growthGeometry.js";

test("dense goal points stay individually selectable and deterministic", () => {
  const points = Array.from({length: 60}, (_, n) => ({goal_id: `goal-${n}`, x: .7, y: .2}));
  const positions = mapPositions(points), values = [...positions.values()];
  for (let a = 0; a < values.length; a++) for (let b = a + 1; b < values.length; b++)
    assert.ok(Math.hypot(values[a]!.x - values[b]!.x, values[a]!.y - values[b]!.y) >= 23);
  assert.deepEqual(mapPositions([...points].reverse()), positions);
  const extended = mapPositions([...points, {goal_id: "additional", x: .7, y: .2}], positions);
  for (const [id, position] of positions) assert.deepEqual(extended.get(id), position);
  assert.equal(mapPositions([{goal_id: "unknown", x: null, y: null}]).size, 0);
});

test("zero stays at the center and decimal scores vary continuously", () => {
  assert.deepEqual(radarVertex(2, 0), [180, 154]);
  const a = radarVertex(0, 2.1), b = radarVertex(0, 2.2);
  assert.ok(a[1] > b[1]); assert.ok(a[1] - b[1] < 3);
});
