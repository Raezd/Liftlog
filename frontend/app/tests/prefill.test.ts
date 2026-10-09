// The prefill rule (src/lib/prefill.ts). Runs on Node's own test runner with
// type stripping, no packages needed: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { prefill } from "../src/lib/prefill.ts";
import type { PastSet, PastWorkout, RoutinePlan, TargetSet } from "../src/lib/prefill.ts";

const BENCH = "ex-bench";
const ROW = "ex-row";
const ROUTINE = "routine-day1";

function target(t: Partial<TargetSet> = {}): TargetSet {
  return { set_type: "normal", reps_min: null, reps_max: null, weight_value: null, weight_unit: null,
    duration_seconds: null, distance_value: null, distance_unit: null, ...t };
}

function done(set_type: PastSet["set_type"], weight: string | null, reps: number | null): PastSet {
  return { set_type, weight_value: weight, weight_unit: weight === null ? null : "lb", reps,
    duration_seconds: null, distance_value: null, distance_unit: null };
}

function workout(id: string, day: number, sets: PastSet[], w: Partial<PastWorkout> = {}): PastWorkout {
  const started = `2026-10-${String(day).padStart(2, "0")}T17:00:00Z`;
  return { id, routine_id: null, started_at: started, ended_at: `2026-10-${String(day).padStart(2, "0")}T18:00:00Z`,
    source: "liftlog", exercises: [{ exercise_id: BENCH, sets }], ...w };
}

const plan = (sets: TargetSet[], exercise_id = BENCH): RoutinePlan =>
  ({ routine_id: ROUTINE, exercises: [{ exercise_id, sets }] });

test("same-routine history wins over newer history from anywhere", () => {
  const history = [
    workout("other-newer", 8, [done("normal", "200", 3)]),
    workout("same-older", 2, [done("normal", "185", 5)], { routine_id: ROUTINE }),
  ];
  const [[s]] = prefill(plan([target({ reps_min: 5, reps_max: 5, weight_value: "175", weight_unit: "lb" })]), history);
  assert.equal(s.source, "same_routine");
  assert.equal(s.workout_id, "same-older");
  assert.deepEqual([s.weight_value, s.weight_unit, s.reps], ["185", "lb", 5]);
});

test("the most recent finished workout is used, and unfinished ones are skipped", () => {
  const history = [
    workout("older", 1, [done("normal", "135", 10)], { routine_id: ROUTINE }),
    workout("newer", 5, [done("normal", "145", 8)], { routine_id: ROUTINE }),
    workout("in-progress", 9, [done("normal", "999", 1)], { routine_id: ROUTINE, ended_at: null }),
  ];
  const [[s]] = prefill(plan([target()]), history);
  assert.equal(s.workout_id, "newer");
  assert.deepEqual([s.weight_value, s.reps], ["145", 8]);
});

test("without same-routine history, the latest workout from anywhere is used, and imports count", () => {
  const history = [
    workout("imported", 7, [done("normal", "155", 6)], { source: "hevy_import", ended_at: null }),
    workout("same-routine-but-no-bench", 8, [], { routine_id: ROUTINE, exercises: [{ exercise_id: ROW, sets: [done("normal", "100", 10)] }] }),
    workout("liftlog-older", 3, [done("normal", "150", 6)]),
  ];
  const [[s]] = prefill(plan([target()]), history);
  assert.equal(s.source, "history");
  assert.equal(s.workout_id, "imported");
  assert.deepEqual([s.weight_value, s.reps], ["155", 6]);
});

test("sets match by position within the same set type", () => {
  const history = [workout("last", 4, [
    done("warmup", "45", 10), done("warmup", "95", 5), done("normal", "185", 5), done("normal", "185", 4),
    done("drop", "135", 8),
  ])];
  const sets = prefill(plan([
    target({ set_type: "warmup" }), target({ set_type: "normal" }), target({ set_type: "warmup" }),
    target({ set_type: "normal" }), target({ set_type: "normal" }), target({ set_type: "drop" }),
    target({ set_type: "failure" }),
  ]), history)[0];
  assert.deepEqual(sets.map((s) => [s.set_type, s.weight_value, s.reps]), [
    ["warmup", "45", 10],   // first warm-up
    ["normal", "185", 5],   // first normal
    ["warmup", "95", 5],    // second warm-up, even though it's third in the routine
    ["normal", "185", 4],   // second normal
    ["normal", null, null], // no third normal last time: target, which is empty
    ["drop", "135", 8],
    ["failure", null, null], // no failure set last time
  ]);
  assert.deepEqual(sets.map((s) => s.source), ["history", "history", "history", "history", "empty", "history", "empty"]);
});

test("no matching past set falls back to the target, then to empty", () => {
  const history = [workout("last", 4, [done("normal", "185", 5)])];
  const [sets] = prefill(plan([
    target({ reps_min: 5, reps_max: 5, weight_value: "185", weight_unit: "lb" }),
    target({ reps_min: 5, reps_max: 5, weight_value: "190", weight_unit: "lb" }),
    target(),
  ]), history);
  assert.deepEqual([sets[1].weight_value, sets[1].weight_unit, sets[1].reps, sets[1].source], ["190", "lb", 5, "target"]);
  assert.deepEqual([sets[2].weight_value, sets[2].reps, sets[2].source, sets[2].workout_id], [null, null, "empty", null]);

  // No history at all for this exercise.
  const [fresh] = prefill(plan([target({ weight_value: "60", weight_unit: "kg" }), target()], ROW), history);
  assert.deepEqual([fresh[0].weight_value, fresh[0].weight_unit, fresh[0].reps, fresh[0].source], ["60", "kg", null, "target"]);
  assert.equal(fresh[1].source, "empty");
});

test("a rep range shows as a hint and doesn't change the prefilled value", () => {
  const history = [workout("last", 4, [done("normal", "135", 11)])];
  const [sets] = prefill(plan([target({ reps_min: 8, reps_max: 12 }), target({ reps_min: 8, reps_max: 12 }),
    target({ reps_min: 5, reps_max: 5 })]), history);
  assert.deepEqual([sets[0].reps, sets[0].reps_hint], [11, "8 to 12"]);  // from history, not the range
  assert.deepEqual([sets[1].reps, sets[1].reps_hint], [8, "8 to 12"]);   // no history: low end of the range
  assert.equal(sets[2].reps_hint, null);                                 // fixed reps: no hint
});
