/**
 * The workout in progress: its shape on the device, and the pure steps that
 * start it, add to it, time its rests, and turn it into an upload. Storage
 * is lib/active.ts; the screen is pages/Workout.tsx.
 */
import { duration } from "./format";
import { uuid7 } from "./ids";
import { prefill, type PastSet, type PastWorkout, type TargetSet } from "./prefill";
import { groupOf, units, type Linked } from "./reorder";
import type { DistanceUnit, Equipment, LoggingType, Me, RoutineVersion, SetType, WeightUnit, WorkoutDetail } from "./types";
import { volume } from "./volume";

/** Which fields a set has, by logging type. */
export type Fields = { reps: boolean; weight: string | null; duration: boolean; distance: boolean; rpe: boolean };
export const FIELDS: Record<LoggingType, Fields> = {
  weight_reps: { reps: true, weight: "Weight", duration: false, distance: false, rpe: true },
  bodyweight_reps: { reps: true, weight: null, duration: false, distance: false, rpe: true },
  weighted_bodyweight: { reps: true, weight: "Added weight", duration: false, distance: false, rpe: true },
  assisted_bodyweight: { reps: true, weight: "Assistance", duration: false, distance: false, rpe: true },
  duration: { reps: false, weight: null, duration: true, distance: false, rpe: true },
  distance_duration: { reps: false, weight: null, duration: true, distance: true, rpe: false },
};

export const RPE_VALUES = ["6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10"];

/** "1:30" or "1:02:00" to seconds. A plain number is seconds. Undefined if unreadable. */
export function parseDuration(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d+):([0-5]\d)$/.exec(t);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const isNumber = (t: string) => /^\d+(\.\d+)?$/.test(t.trim());

export const DEFAULT_REST = 90;
export const REST_STEP = 15;
export const MAX_REST = 3600;

export type ActiveSet = {
  id: string;
  set_type: SetType;
  weight: string;
  weight_unit: WeightUnit;
  reps: string;
  duration: string;
  distance: string;
  distance_unit: DistanceUnit | "m";
  rpe: string | null;
  done: boolean;
  completed_at: string | null;
  /** "8 to 12" for a rep range target. */
  hint: string | null;
};

export type ActiveExercise = Linked & {
  /** Also the workout exercise's id on the server. */
  key: string;
  exercise_id: string;
  name: string;
  logging_type: LoggingType;
  equipment: Equipment;
  /** The routine's notes for it. */
  notes: string;
  /** Rest after each set, this workout only. For a superset, supersetRest on
   *  its first exercise (if set) is the rest after each round. */
  rest: number;
  sets: ActiveSet[];
};

/** A running rest. The phone alerts at endsAt (alertId) unless the app,
 *  open in front, took it over to play the alert itself. */
export type Rest = { endsAt: number; seconds: number; alertId: number; label: string; key: string; takenOver: boolean };

export type ActiveWorkout = {
  id: string;
  /** The Tailscale login it belongs to. */
  login: string;
  title: string;
  notes: string;
  started_at: string;
  routine_id: string | null;
  routine_version_id: string | null;
  exercises: ActiveExercise[];
  /** The exercise whose card is showing (its unit's card). */
  currentKey: string | null;
  rest: Rest | null;
  nextAlertId: number;
};

export type UploadSet = {
  id: string;
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
  rpe: string | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: DistanceUnit | "m" | null;
  completed_at: string | null;
};

export type UploadBody = {
  title: string;
  notes: string;
  started_at: string;
  ended_at: string;
  routine_version_id: string | null;
  exercises: {
    id: string;
    exercise_id: string;
    superset_group: number | null;
    notes: string;
    rest_seconds: number | null;
    sets: UploadSet[];
  }[];
};

/** A finished workout waiting to upload (the queue store). */
export type Queued = {
  id: string;
  login: string;
  routine_id: string | null;
  queued_at: string;
  body: UploadBody;
  /** Why the last upload was refused, when the server said no (not just offline). */
  error: string | null;
};

/** A past workout as prefill, rest defaults, and the last-session strip use it. */
export type HistWorkout = Omit<PastWorkout, "exercises"> & {
  exercises: { exercise_id: string; rest_seconds: number | null; sets: PastSet[] }[];
};

/** Cached history plus finished workouts still waiting to upload. */
export function history(cached: WorkoutDetail[], queued: Queued[]): HistWorkout[] {
  const have = new Set(cached.map((w) => w.id));
  return [
    ...queued.filter((q) => !have.has(q.id)).map((q): HistWorkout => ({
      id: q.id, routine_id: q.routine_id, started_at: q.body.started_at, ended_at: q.body.ended_at, source: "liftlog",
      exercises: q.body.exercises,
    })),
    ...cached,
  ].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

const finished = (w: HistWorkout) => w.ended_at !== null || w.source === "hevy_import";

/** The rest an exercise used most recently, if any workout recorded one. */
export function lastRest(hist: HistWorkout[], exerciseId: string): number | null {
  for (const w of hist) {
    if (!finished(w)) continue;
    const e = w.exercises.find((x) => x.exercise_id === exerciseId && x.rest_seconds !== null);
    if (e) return e.rest_seconds;
  }
  return null;
}

/** The most recent finished workout with this exercise: when, and its sets. */
export function lastSession(hist: HistWorkout[], exerciseId: string): { started_at: string; sets: PastSet[] } | null {
  for (const w of hist) {
    if (!finished(w)) continue;
    const es = w.exercises.filter((x) => x.exercise_id === exerciseId);
    if (es.length) return { started_at: w.started_at, sets: es.flatMap((e) => e.sets) };
  }
  return null;
}

type Units = Pick<Me, "weight_unit" | "distance_unit">;

function activeSet(p: ReturnType<typeof prefill>[number][number] | null, units: Units, set_type: SetType = "normal"): ActiveSet {
  return {
    id: uuid7(),
    set_type: p?.set_type ?? set_type,
    weight: p?.weight_value ?? "", weight_unit: p?.weight_unit ?? units.weight_unit,
    reps: p?.reps?.toString() ?? "",
    duration: p?.duration_seconds != null ? duration(p.duration_seconds) : "",
    distance: p?.distance_value ?? "", distance_unit: p?.distance_unit ?? units.distance_unit,
    rpe: null, done: false, completed_at: null, hint: p?.reps_hint ?? null,
  };
}

type ExerciseInfo = { id: string; name: string; logging_type: LoggingType; equipment: Equipment };

/** An exercise added during a workout: as many sets as last time, prefilled
 *  from it, or one empty set. */
export function addedExercise(ex: ExerciseInfo, hist: HistWorkout[], routineId: string | null, units: Units): ActiveExercise {
  const past = lastSession(hist, ex.id);
  const targets: TargetSet[] = (past?.sets ?? [{ set_type: "normal" as SetType }]).map((s) => ({
    set_type: s.set_type, reps_min: null, reps_max: null, weight_value: null, weight_unit: null,
    duration_seconds: null, distance_value: null, distance_unit: null,
  }));
  const [sets] = prefill({ routine_id: routineId ?? "", exercises: [{ exercise_id: ex.id, sets: targets }] }, hist);
  return {
    key: uuid7(), exercise_id: ex.id, name: ex.name, logging_type: ex.logging_type, equipment: ex.equipment, notes: "",
    rest: lastRest(hist, ex.id) ?? DEFAULT_REST, linkNext: false, supersetRest: null,
    sets: sets.map((p) => activeSet(p, units)),
  };
}

/** A new workout, empty or from a routine's current version (snapshotted). */
export function startWorkout(opts: {
  login: string; units: Units; hist: HistWorkout[];
  routine?: { id: string; name: string; version: RoutineVersion };
}): ActiveWorkout {
  const { routine, hist, units } = opts;
  let exercises: ActiveExercise[] = [];
  if (routine) {
    const v = routine.version;
    const filled = prefill({ routine_id: routine.id, exercises: v.exercises }, hist);
    exercises = v.exercises.map((e, i) => {
      const linkNext = e.superset_group !== null && v.exercises[i + 1]?.superset_group === e.superset_group;
      const first = e.superset_group !== null && v.exercises[i - 1]?.superset_group !== e.superset_group;
      return {
        key: uuid7(), exercise_id: e.exercise_id, name: e.name, logging_type: e.logging_type, equipment: e.equipment,
        notes: e.notes, rest: e.rest_seconds ?? lastRest(hist, e.exercise_id) ?? DEFAULT_REST,
        linkNext, supersetRest: first && linkNext ? v.superset_rests[String(e.superset_group)] ?? null : null,
        sets: filled[i].map((p) => activeSet(p, units)),
      };
    });
  }
  return {
    id: uuid7(), login: opts.login, title: routine?.name ?? "Workout", notes: "", started_at: new Date().toISOString(),
    routine_id: routine?.id ?? null, routine_version_id: routine?.version.id ?? null,
    exercises, currentKey: exercises[0]?.key ?? null, rest: null, nextAlertId: 1,
  };
}

/** A new set like the last one (type and values), not done. */
export function nextSet(e: ActiveExercise, units: Units): ActiveSet {
  const last = e.sets[e.sets.length - 1];
  if (!last) return activeSet(null, units);
  return { ...last, id: uuid7(), done: false, completed_at: null, rpe: null };
}

/** The rest after each round of the superset at index i (or the exercise's own rest). */
export function restFor(items: ActiveExercise[], i: number): { seconds: number; key: string } {
  const g = groupOf(items, i);
  if (!g) return { seconds: items[i].rest, key: items[i].key };
  const first = items[g[0]];
  return { seconds: first.supersetRest ?? first.rest, key: first.key };
}

/** The rest to start after set k of exercise i was completed, if any. In a
 *  superset, only once every exercise in the group with a set k has done it:
 *  after the last exercise of each round. */
export function restAfter(items: ActiveExercise[], i: number, k: number): { seconds: number; key: string } | null {
  const g = groupOf(items, i);
  if (g) {
    for (let j = g[0]; j <= g[1]; j++) {
      const s = items[j].sets[k];
      if (s && !s.done) return null;
    }
  }
  const r = restFor(items, i);
  return r.seconds > 0 ? r : null;
}

/** The first set not done in a unit, round by round: where "up next" is. */
export function upNext(unit: ActiveExercise[]): { key: string; set: number } | null {
  const rounds = Math.max(0, ...unit.map((e) => e.sets.length));
  for (let k = 0; k < rounds; k++) {
    for (const e of unit) if (e.sets[k] && !e.sets[k].done) return { key: e.key, set: k };
  }
  return null;
}

/** The first problem with a set's values, in plain words, or null. */
export function setProblem(s: ActiveSet, f: Fields): string | null {
  if (f.weight && s.weight.trim() && !isNumber(s.weight)) return `${f.weight} should be a number.`;
  if (f.reps && s.reps.trim() && !/^\d+$/.test(s.reps.trim())) return "Reps should be a whole number.";
  if (f.duration && parseDuration(s.duration) === undefined) return "Write time like 1:30.";
  if (f.distance && s.distance.trim() && !isNumber(s.distance)) return "Distance should be a number.";
  return null;
}

function uploadSet(s: ActiveSet, f: Fields): UploadSet {
  const weight = f.weight && s.weight.trim() ? s.weight.trim() : null;
  const distance = f.distance && s.distance.trim() ? s.distance.trim() : null;
  return {
    id: s.id, set_type: s.set_type,
    weight_value: weight, weight_unit: weight ? s.weight_unit : null,
    reps: f.reps && s.reps.trim() ? Number(s.reps) : null,
    rpe: f.rpe ? s.rpe : null,
    duration_seconds: f.duration ? parseDuration(s.duration) ?? null : null,
    distance_value: distance, distance_unit: distance ? s.distance_unit : null,
    completed_at: s.completed_at,
  };
}

/** What finishing keeps and drops: sets not done, and exercises with no done sets, are dropped. */
export function finishCounts(w: ActiveWorkout): { sets: number; droppedSets: number; droppedExercises: number } {
  const all = w.exercises.flatMap((e) => e.sets);
  return {
    sets: all.filter((s) => s.done).length,
    droppedSets: all.filter((s) => !s.done).length,
    droppedExercises: w.exercises.filter((e) => !e.sets.some((s) => s.done)).length,
  };
}

/** The finished workout as uploaded: done sets only, in order, with the
 *  superset groups and the rest each exercise used. */
export function toUpload(w: ActiveWorkout, endedAt: string): UploadBody {
  const group: (number | null)[] = [];
  let n = 0;
  for (const u of units(w.exercises)) {
    const g = u.length > 1 ? n++ : null;
    for (let i = 0; i < u.length; i++) group.push(g);
  }
  return {
    title: w.title.trim() || "Workout", notes: w.notes.trim(), started_at: w.started_at, ended_at: endedAt,
    routine_version_id: w.routine_version_id,
    exercises: w.exercises.flatMap((e, i) => {
      const done = e.sets.filter((s) => s.done);
      if (!done.length) return [];
      const f = FIELDS[e.logging_type];
      const first = group[i] !== null && group[i - 1] !== group[i];
      return [{
        id: e.key, exercise_id: e.exercise_id, superset_group: group[i], notes: e.notes,
        rest_seconds: first ? e.supersetRest ?? e.rest : e.rest,
        sets: done.map((s) => uploadSet(s, f)),
      }];
    }),
  };
}

export type Summary = { title: string; seconds: number; sets: number; volume: number | null; unit: WeightUnit };

export function summarize(body: UploadBody, logging: Record<string, LoggingType>, unit: WeightUnit): Summary {
  return {
    title: body.title,
    seconds: Math.max(0, Math.round((Date.parse(body.ended_at) - Date.parse(body.started_at)) / 1000)),
    sets: body.exercises.reduce((n, e) => n + e.sets.length, 0),
    volume: volume(body.exercises.map((e) => ({ logging_type: logging[e.exercise_id] ?? "weight_reps", sets: e.sets })), unit),
    unit,
  };
}

/** Groups exercise i with the next one into a superset (on), or splits them
 *  (off). A superset's rest after each round stays on its first exercise. */
export function linkWithNext(items: ActiveExercise[], i: number, on: boolean): ActiveExercise[] {
  const next = items.map((x, j) => (j === i ? { ...x, linkNext: on } : x));
  return units(next).flatMap((u) => u.map((x, j) => ({ ...x, supersetRest: u.length > 1 && j === 0 ? x.supersetRest : null })));
}

/** Can exercise i join the next one's superset? Up to three in a superset. */
export function canLink(items: ActiveExercise[], i: number): boolean {
  if (i >= items.length - 1 || items[i].linkNext) return false;
  const size = (j: number) => { const g = groupOf(items, j); return g ? g[1] - g[0] + 1 : 1; };
  return size(i) + size(i + 1) <= 3;
}
