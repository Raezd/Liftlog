// Records, estimated 1RM, and hard sets per muscle (src/lib/stats.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Queued } from "../src/lib/session.ts";
import {
  UNASSIGNED, e1rm, muscleSets, records, recordsFor, statWorkouts, workoutDate,
  type RecordType, type StatSet, type StatWorkout,
} from "../src/lib/stats.ts";
import type { LoggingType, SetType, WeightUnit, WorkoutDetail } from "../src/lib/types.ts";

let n = 0;
function set(weight: string | null, reps: number | null, opts: { unit?: WeightUnit; type?: SetType; seconds?: number; meters?: string } = {}): StatSet {
  return {
    id: `s${++n}`, set_type: opts.type ?? "normal", weight_value: weight, weight_unit: weight === null ? null : opts.unit ?? "lb", reps,
    duration_seconds: opts.seconds ?? null, distance_value: opts.meters ?? null, distance_unit: opts.meters ? "m" : null,
  };
}

function wo(id: string, day: number, exercises: Record<string, StatSet[]>, source: StatWorkout["source"] = "liftlog"): StatWorkout {
  const started_at = `2026-09-${String(day).padStart(2, "0")}T17:00:00Z`;
  return {
    id, title: id, started_at, workout_date: started_at.slice(0, 10), source, status: "uploaded",
    exercises: Object.entries(exercises).map(([exercise_id, sets]) => ({ exercise_id, sets })),
  };
}

const TYPES: Record<string, LoggingType> = {
  bench: "weight_reps", dip: "weighted_bodyweight", pushup: "bodyweight_reps", plank: "duration", run: "distance_duration", pullup: "assisted_bodyweight",
};
const logging = (id: string) => TYPES[id];
const earned = (ws: StatWorkout[], id: string) => (records(ws, logging).byWorkout.get(id) ?? []).map((p) => p.type).sort();
const kinds = (...t: RecordType[]) => t.sort();

test("the first session is the baseline; later sessions earn each weight record they beat", () => {
  const ws = [
    wo("w1", 1, { bench: [set("185", 5), set("185", 5)] }),
    wo("w2", 2, { bench: [set("195", 3), set("185", 5), set("185", 5)] }),
  ];
  assert.deepEqual(earned(ws, "w1"), []);
  // 195 x 3: heavier (heaviest, reps at a heavier weight); e1RM 214.5 vs 215.8, set volume 585 vs 925: no.
  // Session volume 2435 vs 1850: yes.
  assert.deepEqual(earned(ws, "w2"), kinds("heaviest", "reps_at_weight", "session_volume"));
  const w3 = wo("w3", 3, { bench: [set("185", 8)] });
  // 185 x 8: e1RM 234.3, set volume 1480, more reps at 185: records. Heaviest ties nothing (185 < 195).
  assert.deepEqual(earned([...ws, w3], "w3"), kinds("reps_at_weight", "e1rm", "set_volume"));
});

test("ties are not records, and weights within 0.05 kg are equal across units", () => {
  const ws = [
    wo("w1", 1, { bench: [set("225", 5)] }),
    wo("w2", 2, { bench: [set("225", 5)] }),
    wo("w3", 3, { bench: [set("102.06", 5, { unit: "kg" })] }), // 225 lb is 102.058 kg
    wo("w4", 4, { bench: [set("102.2", 5, { unit: "kg" })] }),
  ];
  assert.deepEqual(earned(ws, "w2"), []);
  assert.deepEqual(earned(ws, "w3"), []);
  assert.deepEqual(earned(ws, "w4"), kinds("heaviest", "reps_at_weight", "e1rm", "set_volume", "session_volume"));
});

test("best reps at a weight: a set is a record only if no earlier set had as many reps at that weight or heavier", () => {
  const base = wo("w1", 1, { bench: [set("200", 5)] });
  // Fewer reps at a lighter weight than 200 x 5: dominated.
  assert.ok(!earned([base, wo("w2", 2, { bench: [set("180", 5)] })], "w2").includes("reps_at_weight"));
  // More reps at a lighter weight: a record.
  assert.ok(earned([base, wo("w2", 2, { bench: [set("180", 6)] })], "w2").includes("reps_at_weight"));
  // The same reps at the same weight: a tie.
  assert.ok(!earned([base, wo("w2", 2, { bench: [set("200", 5)] })], "w2").includes("reps_at_weight"));
});

test("best reps at a weight: of several qualifying sets within 0.05 kg of each other, the most reps counts, then the first", () => {
  const base = wo("w1", 1, { bench: [set("200", 3)] });
  const at = (ws: StatWorkout[]) => records(ws, logging).byWorkout.get("w2")!.filter((p) => p.type === "reps_at_weight");
  // 225 lb x 5 and 102.06 kg x 7 are the same weight: the 7 counts, and only it.
  const more = at([base, wo("w2", 2, { bench: [set("225", 5), set("102.06", 7, { unit: "kg" })] })]);
  assert.equal(more.length, 1);
  assert.deepEqual([more[0].set!.weight_value, more[0].reps], ["102.06", 7]);
  // The same weight and reps: the first one logged.
  const first = at([base, wo("w2", 2, { bench: [set("102.06", 6, { unit: "kg" }), set("225", 6)] })]);
  assert.deepEqual([first.length, first[0].set!.weight_value], [1, "102.06"]);
  // A heavier set beyond 0.05 kg beats more reps at a lighter one.
  const heavier = at([base, wo("w2", 2, { bench: [set("205", 10), set("215", 4)] })]);
  assert.deepEqual([heavier.length, heavier[0].set!.weight_value], [1, "215"]);
});

test("warm-ups never count, and within a workout only its best set per type is a record", () => {
  const ws = [
    wo("w1", 1, { bench: [set("135", 5)] }),
    wo("w2", 2, { bench: [set("315", 1, { type: "warmup" }), set("140", 5), set("145", 5)] }),
  ];
  const prs = records(ws, logging).byWorkout.get("w2")!;
  const heaviest = prs.filter((p) => p.type === "heaviest");
  assert.equal(heaviest.length, 1);
  assert.equal(heaviest[0].set!.weight_value, "145");
  assert.equal(prs.filter((p) => p.type === "reps_at_weight").length, 1);
  assert.equal(records(ws, logging).byExercise.get("bench")!.best.heaviest!.set!.weight_value, "145");
});

test("weighted bodyweight keeps records on the added weight, with no estimated 1RM", () => {
  const ws = [wo("w1", 1, { dip: [set("25", 8)] }), wo("w2", 2, { dip: [set("45", 8)] })];
  assert.deepEqual(earned(ws, "w2"), kinds("heaviest", "reps_at_weight", "set_volume", "session_volume"));
  assert.equal(records(ws, logging).byExercise.get("dip")!.best.e1rm, undefined);
});

test("bodyweight, duration, and distance records; none for assisted", () => {
  const ws = [
    wo("w1", 1, { pushup: [set(null, 20)], plank: [set(null, null, { seconds: 60 })], run: [set(null, null, { meters: "5000" })], pullup: [set("50", 5)] }),
    wo("w2", 2, { pushup: [set(null, 25)], plank: [set(null, null, { seconds: 90 })], run: [set(null, null, { meters: "5000" })], pullup: [set("30", 8)] }),
  ];
  assert.deepEqual(earned(ws, "w2"), kinds("most_reps", "longest_time"));
});

test("imported and queued workouts count", () => {
  const imported = wo("hevy", 1, { bench: [set("185", 5)] }, "hevy_import");
  const detail = (w: StatWorkout): WorkoutDetail => ({
    ...w, ended_at: null, notes: "", routine_version_id: null, routine_id: null,
    exercises: w.exercises.map((e, i) => ({ id: `we${i}`, exercise_id: e.exercise_id, name: "", logged_name: "", position: i,
      superset_group: null, notes: "", rest_seconds: null,
      sets: e.sets.map((s, k) => ({ ...s, position: k, rpe: null, completed_at: null })) })),
  });
  const queued = (id: string, day: number, weight: string): Queued => ({
    id, login: "trav", routine_id: null, queued_at: "", error: null,
    body: { title: id, notes: "", started_at: `2026-09-0${day}T17:00:00Z`, ended_at: `2026-09-0${day}T18:00:00Z`, routine_version_id: null,
      routine_version: null, exercises: [{ id: `we-${id}`, exercise_id: "bench", superset_group: null, notes: "", rest_seconds: null,
        sets: [{ ...set(weight, 5), rpe: null, completed_at: "" }] }] },
  });
  const ws = statWorkouts([detail(imported)], [queued("q1", 2, "195"), queued("q2", 3, "190")], "America/Los_Angeles");
  assert.deepEqual(ws.map((w) => [w.id, w.status]), [["hevy", "uploaded"], ["q1", "waiting"], ["q2", "waiting"]]);
  // The imported session is the baseline, the first queued one beats it, and
  // the second queued one is judged against the first.
  assert.ok(earned(ws, "q1").includes("heaviest"));
  assert.ok(!earned(ws, "q2").includes("heaviest"));
});

test("the finish summary judges a workout only against earlier history", () => {
  const ws = [
    wo("w1", 1, { bench: [set("185", 5)] }),
    wo("now", 2, { bench: [set("205", 5)] }),
    wo("later", 3, { bench: [set("225", 5)] }), // started after: doesn't count against it
  ];
  assert.ok(recordsFor(ws, "now", logging).some((p) => p.type === "heaviest"));
  // Alone, a workout has nothing earlier: it's the baseline, never a record against itself.
  assert.deepEqual(recordsFor([wo("now", 2, { bench: [set("205", 5)] })], "now", logging), []);
});

test("Epley: a single is its own weight, and over 10 reps there's no estimate", () => {
  assert.equal(e1rm(100, 1), 100);
  assert.equal(e1rm(100, 3), 110);
  assert.equal(e1rm(90, 10), 120);
  assert.equal(e1rm(100, 11), null);
  assert.equal(e1rm(100, 0), null);
});

test("hard sets per muscle: primary 1, secondary 0.5, warm-ups out, unassigned counted, weeks start Monday", () => {
  const maps: Record<string, { primary: string[]; secondary: string[] }> = {
    bench: { primary: ["chest"], secondary: ["triceps", "front_delts"] },
    pushup: { primary: [], secondary: [] },
    plank: { primary: ["abdominals"], secondary: [] },
  };
  const ws = [
    // Sunday Sep 6 and Monday Sep 7, 2026.
    { ...wo("sun", 6, { bench: [set("135", 10, { type: "warmup" }), set("185", 5), set("185", 5)] }), workout_date: "2026-09-06" },
    { ...wo("mon", 7, { bench: [set("185", 5)], pushup: [set(null, 20), set(null, 20)], plank: [set(null, null, { seconds: 60 })] }), workout_date: "2026-09-07" },
  ];
  const weeks = muscleSets(ws, (id) => maps[id]);
  assert.deepEqual(Object.fromEntries(weeks.get("2026-08-31")!), { chest: 2, triceps: 1, front_delts: 1 });
  assert.deepEqual(Object.fromEntries(weeks.get("2026-09-07")!), { chest: 1, triceps: 0.5, front_delts: 0.5, [UNASSIGNED]: 2, abdominals: 1 });
});

test("a workout started before 4 AM Monday belongs to Sunday's week", () => {
  // 2:30 AM Monday Sep 7 in Los Angeles is 09:30 UTC.
  assert.equal(workoutDate("2026-09-07T09:30:00Z", "America/Los_Angeles"), "2026-09-06");
  assert.equal(workoutDate("2026-09-07T11:30:00Z", "America/Los_Angeles"), "2026-09-07");
  const q: Queued = {
    id: "late", login: "trav", routine_id: null, queued_at: "", error: null,
    body: { title: "", notes: "", started_at: "2026-09-07T09:30:00Z", ended_at: "2026-09-07T10:30:00Z", routine_version_id: null, routine_version: null,
      exercises: [{ id: "we", exercise_id: "bench", superset_group: null, notes: "", rest_seconds: null, sets: [{ ...set("185", 5), rpe: null, completed_at: "" }] }] },
  };
  const weeks = muscleSets(statWorkouts([], [q], "America/Los_Angeles"), () => ({ primary: ["chest"], secondary: [] }));
  assert.deepEqual([...weeks.keys()], ["2026-08-31"]);
});
