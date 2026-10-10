// Workouts finished on the phone but not uploaded yet feed prefill, the
// last-session strip, and the most recent rest (src/lib/session.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REOPEN_BLOCKED, heaviest, heavySets, history, lastRest, lastSession, reopen, startWorkout, toUpload, tooHeavy } from "../src/lib/session.ts";
import type { ActiveWorkout } from "../src/lib/session.ts";
import { uploadQueue } from "../src/lib/uploader.ts";
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

// ---------- heavy weight warning ----------

const lb = (weight: string) => ({ weight, weight_unit: "lb" as const });

test("the heavy weight warning flags above 1.5 times the heaviest, not at or below it", () => {
  // Heaviest so far: 225 lb (cached at 175, queued at 225).
  const q225: Queued = { ...queued, body: { ...queued.body, exercises: [{ ...queued.body.exercises[0], sets: [uset("225", 5)] }] } };
  const top = heaviest(history([cached], [q225]), BENCH);
  assert.equal(top?.value, "225");
  assert.equal(tooHeavy(lb("337.5"), top), false); // exactly 1.5 times
  assert.equal(tooHeavy(lb("337.51"), top), true);
  assert.equal(tooHeavy(lb("225"), top), false);
  assert.equal(tooHeavy(lb("2252.5"), top), true);
  // Compared in kg: 153.08 kg is just over 337.5 lb (153.0874...), 153.08 just under.
  assert.equal(tooHeavy({ weight: "153.08", weight_unit: "kg" }, top), false);
  assert.equal(tooHeavy({ weight: "153.09", weight_unit: "kg" }, top), true);
});

test("queued workouts count toward the heaviest", () => {
  // Only the queued 185 makes 270 safe: 1.5 times 175 is 262.5, 1.5 times 185 is 277.5.
  assert.equal(tooHeavy(lb("270"), heaviest(history([cached], []), BENCH)), true);
  assert.equal(tooHeavy(lb("270"), heaviest(history([cached], [queued]), BENCH)), false);
});

test("no history means no warning", () => {
  assert.equal(heaviest(history([], []), BENCH), null);
  assert.equal(tooHeavy(lb("2252.5"), null), false);
  const w = startWorkout({ login: "trav@example.com", units: { weight_unit: "lb", distance_unit: "mi" }, hist: [],
    routine: { id: ROUTINE, name: "Day 1", version } });
  w.exercises[0].sets[0].weight = "2252.5";
  assert.deepEqual(heavySets(w, []), []);
  assert.deepEqual(heavySets(w, history([cached], [])).map((x) => [x.name, x.label, x.set.weight]), [["Bench", "Set 1", "2252.5"]]);
});

// ---------- reopen ----------

const refused: Queued = { ...queued, id: "w-refused", error: "Bench, set 1: the weight 2252.5 lb is over the limit.",
  body: { ...queued.body, routine_version: version,
    exercises: [{ ...queued.body.exercises[0], id: "we-r", sets: [uset("2252.5", 5)] }] } };
const UNITS = { weight_unit: "lb" as const, distance_unit: "mi" as const };

test("reopen keeps the id, started_at, and ended_at, and finishing again keeps ended_at", () => {
  const w = reopen(refused, null, [], UNITS) as ActiveWorkout;
  assert.ok(!("refused" in w));
  assert.deepEqual([w.id, w.started_at, w.ended_at], ["w-refused", "2026-10-09T17:00:00Z", "2026-10-09T18:00:00Z"]);
  assert.equal(w.exercises[0].name, "Bench");             // from the version it started from
  assert.deepEqual([w.exercises[0].sets[0].done, w.rest, w.excluded_plates], [true, null, []]);
  w.exercises[0].sets[0].weight = "225";
  const body = toUpload(w, "2026-10-10T09:00:00Z");
  assert.deepEqual([body.started_at, body.ended_at], ["2026-10-09T17:00:00Z", "2026-10-09T18:00:00Z"]);
  assert.equal(body.exercises[0].sets[0].weight_value, "225");
});

test("reopen is refused while another workout is in progress", () => {
  const other = startWorkout({ login: "trav@example.com", units: UNITS, hist: [] });
  assert.deepEqual(reopen(refused, other, [], UNITS), { refused: REOPEN_BLOCKED });
});

test("a reopened workout uploads once after it's finished again", async () => {
  const w = reopen(refused, null, [], UNITS) as ActiveWorkout;
  w.exercises[0].sets[0].weight = "225";
  const again: Queued = { id: w.id, login: w.login, routine_id: w.routine_id, queued_at: "2026-10-10T09:00:00Z",
    body: toUpload(w, "2026-10-10T09:00:00Z"), error: null };
  const puts: string[] = [];
  const queue = [again];
  const deps = {
    put: async (x: Queued) => { puts.push(`${x.id} ${x.body.ended_at} ${x.body.exercises[0].sets[0].weight_value}`); return x.id; },
    uploaded: async (x: Queued) => { queue.splice(queue.indexOf(x), 1); },
    refused: async () => { throw new Error("not refused"); },
  };
  await uploadQueue(queue, "trav@example.com", deps);
  await uploadQueue(queue, "trav@example.com", deps);
  assert.deepEqual(puts, ["w-refused 2026-10-09T18:00:00Z 225"]);
});
