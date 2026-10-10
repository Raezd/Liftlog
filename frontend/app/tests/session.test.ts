// Workouts finished on the phone but not uploaded yet feed prefill, the
// last-session strip, and the most recent rest (src/lib/session.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { history, lastRest, lastSession, startWorkout } from "../src/lib/session.ts";
import type { Queued, UploadSet } from "../src/lib/session.ts";
import type { RoutineVersion, WorkoutDetail } from "../src/lib/types.ts";

const ROUTINE = "routine-day1";
const BENCH = "ex-bench";

function uset(weight: string, reps: number): UploadSet {
  return { id: `s-${weight}-${reps}`, set_type: "normal", weight_value: weight, weight_unit: "lb", reps, rpe: null,
    duration_seconds: null, distance_value: null, distance_unit: null, completed_at: "2026-10-09T17:10:00Z" };
}

// Uploaded last week, in the phone's copy.
const cached: WorkoutDetail = {
  id: "w-cached", title: "Day 1", workout_date: "2026-10-02", started_at: "2026-10-02T17:00:00Z", ended_at: "2026-10-02T18:00:00Z",
  source: "liftlog", notes: "", routine_version_id: "v1", routine_id: ROUTINE,
  exercises: [{ id: "we-1", exercise_id: BENCH, name: "Bench", logged_name: "Bench", position: 0, superset_group: null, notes: "",
    rest_seconds: 120, sets: [{ id: "s1", position: 0, set_type: "normal", weight_value: "175", weight_unit: "lb", reps: 5,
      rpe: null, duration_seconds: null, distance_value: null, distance_unit: null, completed_at: null }] }],
};

// Finished offline yesterday, still waiting to upload.
const queued: Queued = {
  id: "w-queued", login: "trav@example.com", routine_id: ROUTINE, queued_at: "2026-10-09T18:00:00Z", error: null,
  body: { title: "Day 1", notes: "", started_at: "2026-10-09T17:00:00Z", ended_at: "2026-10-09T18:00:00Z", routine_version_id: "v1",
    exercises: [{ id: "we-2", exercise_id: BENCH, superset_group: null, notes: "", rest_seconds: 150, sets: [uset("185", 5)] }] },
};

const version: RoutineVersion = {
  id: "v1", routine_id: ROUTINE, number: 1, parent_version_id: null, created_at: "2026-10-01T00:00:00Z", superset_rests: {},
  exercises: [{ id: "re-1", exercise_id: BENCH, name: "Bench", logging_type: "weight_reps", equipment: "barbell", position: 0,
    superset_group: null, notes: "", rest_seconds: null, sets: [{ id: "rs-1", position: 0, set_type: "normal", reps_min: 5,
      reps_max: 5, weight_value: "165", weight_unit: "lb", rpe: null, duration_seconds: null, distance_value: null, distance_unit: null }] }],
};

test("a queued workout feeds prefill, the last-session strip, and the rest lookup, as the same routine", () => {
  const hist = history([cached], [queued]);
  assert.deepEqual(hist.map((w) => w.id), ["w-queued", "w-cached"]);

  const w = startWorkout({ login: "trav@example.com", units: { weight_unit: "lb", distance_unit: "mi" }, hist,
    routine: { id: ROUTINE, name: "Day 1", version } });
  const [s] = w.exercises[0].sets;
  assert.deepEqual([s.weight, s.reps], ["185", "5"]);  // not last week's 175, not the 165 target
  assert.equal(w.exercises[0].rest, 150);              // the routine has no rest: the queued workout's

  assert.equal(lastSession(hist, BENCH)?.started_at, "2026-10-09T17:00:00Z");
  assert.deepEqual(lastSession(hist, BENCH)?.sets.map((x) => x.weight_value), ["185"]);
  assert.equal(lastRest(hist, BENCH), 150);
});

test("once uploaded and in the copy, it isn't counted twice", () => {
  const uploaded: WorkoutDetail = { ...cached, id: "w-queued", started_at: queued.body.started_at };
  assert.deepEqual(history([uploaded, cached], [queued]).map((w) => w.id), ["w-queued", "w-cached"]);
});
