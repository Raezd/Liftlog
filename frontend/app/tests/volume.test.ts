// The volume rules (src/lib/volume.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { volume } from "../src/lib/volume.ts";
import type { VolumeExercise, VolumeSet } from "../src/lib/volume.ts";

function set(set_type: VolumeSet["set_type"], weight: string | null, reps: number | null, unit: "lb" | "kg" = "lb"): VolumeSet {
  return { set_type, weight_value: weight, weight_unit: weight === null ? null : unit, reps };
}

test("warm-ups never count; normal, drop, and failure do", () => {
  const bench: VolumeExercise = { logging_type: "weight_reps", sets: [
    set("warmup", "95", 10), set("normal", "135", 10), set("drop", "115", 8), set("failure", "135", 6),
  ] };
  assert.equal(volume([bench], "lb"), 1350 + 920 + 810);
  assert.equal(volume([{ logging_type: "weight_reps", sets: [set("warmup", "95", 10)] }], "lb"), null);
});

test("lb entries are exact", () => {
  const sets = [set("normal", "135", 10), set("normal", "135", 10), set("normal", "135", 10)];
  assert.equal(volume([{ logging_type: "weight_reps", sets }], "lb"), 4050);
  assert.equal(volume([{ logging_type: "weight_reps", sets: [set("normal", "137.5", 5), set("normal", "2.25", 3)] }], "lb"), 694.25);
  // Shown in kg, it's the normalized kg times reps.
  assert.ok(Math.abs(volume([{ logging_type: "weight_reps", sets }], "kg")! - 4050 * 0.45359237) < 1e-9);
  // kg entries stay exact in kg, and mixed units add up.
  assert.equal(volume([{ logging_type: "weight_reps", sets: [set("normal", "100", 5, "kg")] }], "kg"), 500);
  const mixed = volume([{ logging_type: "weight_reps", sets: [set("normal", "100", 1, "kg"), set("normal", "45", 1)] }], "kg")!;
  assert.ok(Math.abs(mixed - (100 + 45 * 0.45359237)) < 1e-9);
});

test("bodyweight logging types add no tonnage; weighted bodyweight counts the added weight", () => {
  const none: VolumeExercise[] = [
    { logging_type: "bodyweight_reps", sets: [set("normal", null, 12)] },
    { logging_type: "assisted_bodyweight", sets: [set("normal", "40", 8)] },
    { logging_type: "duration", sets: [set("normal", null, null)] },
    { logging_type: "distance_duration", sets: [set("normal", null, null)] },
  ];
  assert.equal(volume(none, "lb"), null);
  assert.equal(volume([...none, { logging_type: "weighted_bodyweight", sets: [set("normal", "45", 8)] }], "lb"), 360);
});
