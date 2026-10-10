/**
 * Records (PRs), estimated 1RM, per-session numbers, and hard sets per muscle,
 * all computed on read from history, never stored. The phone runs these on its
 * copy plus queued workouts; the web build runs them on the history it fetches.
 * Tests: tests/stats.test.ts (`npm test`).
 *
 * Which sets count: every completed set except warm-ups, imported and queued
 * workouts included (stored and queued workouts only hold completed sets).
 * Workouts are judged in order of started_at. An exercise's first session sets
 * the baseline and earns nothing; after that a value is a record only if it
 * beats everything before that workout, ties excluded. Within one workout only
 * the best set for each record type can be a record. Weights compare in kg,
 * and values within 0.05 kg are equal (225 lb and 102.06 kg are the same).
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */
import type { DistanceUnit, LoggingType, SetType, WeightUnit, WorkoutDetail } from "./types";
import type { Queued } from "./session";

// ---------- the workouts the math runs on ----------

export type StatSet = {
  id: string;
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: DistanceUnit | "m" | null;
};

/** uploaded: on the server. waiting: queued on this phone. attention: the server refused it. */
export type StatStatus = "uploaded" | "waiting" | "attention";

export type StatWorkout = {
  id: string;
  title: string;
  started_at: string;
  workout_date: string;
  source: "liftlog" | "hevy_import";
  status: StatStatus;
  exercises: { exercise_id: string; sets: StatSet[] }[];
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The workout date a moment belongs to: the user's timezone, days rolling
 *  over at 4 AM (the server's app/dates.py, for workouts not uploaded yet). */
export function workoutDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const day = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  if (get("hour") < 4) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Uploaded history plus workouts still on the phone, oldest first. */
export function statWorkouts(cached: WorkoutDetail[], queued: Queued[], timeZone: string): StatWorkout[] {
  const have = new Set(cached.map((w) => w.id));
  const all: StatWorkout[] = [
    ...cached.map((w): StatWorkout => ({
      id: w.id, title: w.title, started_at: w.started_at, workout_date: w.workout_date, source: w.source, status: "uploaded",
      exercises: w.exercises,
    })),
    ...queued.filter((q) => !have.has(q.id)).map((q): StatWorkout => ({
      id: q.id, title: q.body.title, started_at: q.body.started_at, workout_date: workoutDate(q.body.started_at, timeZone),
      source: "liftlog", status: q.error === null ? "waiting" : "attention", exercises: q.body.exercises,
    })),
  ];
  return all.sort(byStart);
}

const byStart = (a: { started_at: string; id: string }, b: { started_at: string; id: string }) =>
  Date.parse(a.started_at) - Date.parse(b.started_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------- units ----------

// Exact by definition (1959): 1 lb = 0.45359237 kg.
const KG_PER: Record<WeightUnit, number> = { kg: 1, lb: 0.45359237 };
const M_PER: Record<DistanceUnit | "m", number> = { m: 1, km: 1000, mi: 1609.344 };
/** Weights within this many kg are the same weight. */
export const SAME_KG = 0.05;

const num = (v: string | null) => (v !== null && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);

export function kg(s: Pick<StatSet, "weight_value" | "weight_unit">): number | null {
  const v = num(s.weight_value);
  return v === null || s.weight_unit === null ? null : v * KG_PER[s.weight_unit];
}

export function meters(s: Pick<StatSet, "distance_value" | "distance_unit">): number | null {
  const v = num(s.distance_value);
  return v === null || s.distance_unit === null ? null : v * M_PER[s.distance_unit];
}

export const fromKg = (value: number, unit: WeightUnit) => value / KG_PER[unit];

/** Estimated 1RM by Epley: weight times (1 + reps / 30). A single is its own
 *  weight. Over 10 reps (or none) gives no estimate. */
export function e1rm(weightKg: number, reps: number): number | null {
  if (!Number.isInteger(reps) || reps < 1 || reps > 10) return null;
  return reps === 1 ? weightKg : (weightKg * (30 + reps)) / 30;
}

// ---------- records ----------

export type RecordType =
  | "heaviest" | "reps_at_weight" | "e1rm" | "set_volume" | "session_volume"
  | "most_reps" | "longest_time" | "longest_distance";

/** Which records each logging type keeps. Weighted bodyweight uses the added
 *  weight, so it has no estimated 1RM. Assisted has none in v1. */
export const RECORD_TYPES: Record<LoggingType, RecordType[]> = {
  weight_reps: ["heaviest", "reps_at_weight", "e1rm", "set_volume", "session_volume"],
  weighted_bodyweight: ["heaviest", "reps_at_weight", "set_volume", "session_volume"],
  bodyweight_reps: ["most_reps"],
  duration: ["longest_time"],
  distance_duration: ["longest_distance"],
  assisted_bodyweight: [],
};

export type PR = {
  type: RecordType;
  exercise_id: string;
  workout_id: string;
  started_at: string;
  workout_date: string;
  /** The set, or null for session volume. */
  set: StatSet | null;
  /** kg, estimated kg, kg x reps, reps, seconds, or meters by type. */
  value: number;
  /** For reps at a weight: the weight in kg and the reps. */
  kg?: number;
  reps?: number;
};

type Candidate = { set: StatSet | null; value: number; tol: number; kg?: number; reps?: number };

const counted = (sets: StatSet[]) => sets.filter((s) => s.set_type !== "warmup");

/** The set with the highest value, the first one on a tie. */
function top(sets: StatSet[], value: (s: StatSet) => number | null, tol: (s: StatSet) => number = () => 0): Candidate | null {
  let best: Candidate | null = null;
  for (const s of sets) {
    const v = value(s);
    if (v === null) continue;
    if (!best || v > best.value + Math.max(best.tol, tol(s))) best = { set: s, value: v, tol: tol(s) };
  }
  return best;
}

const weighted = (s: StatSet) => kg(s) !== null && s.reps !== null && s.reps >= 1;
const setVolume = (s: StatSet) => (weighted(s) ? kg(s)! * s.reps! : null);

type Point = { kg: number; reps: number };
/** Some earlier set had at least as many reps at the same weight or heavier. */
const dominated = (p: Point, by: Point[]) => by.some((q) => q.reps >= p.reps && q.kg >= p.kg - SAME_KG);

type ExerciseState = {
  sessions: number;
  best: Partial<Record<RecordType, Candidate & { pr: PR }>>;
  points: Point[];
  frontier: PR[];
};

export type ExerciseRecords = {
  /** The current best of each type, from the session that first reached it
   *  (the baseline session included). */
  best: Partial<Record<RecordType, PR>>;
  /** Best reps at each weight: every set no other set beats on both. Heaviest first. */
  frontier: PR[];
};

export type Records = {
  /** The records each workout earned, judged against everything before it. */
  byWorkout: Map<string, PR[]>;
  byExercise: Map<string, ExerciseRecords>;
};

export function records(workouts: StatWorkout[], logging: (exerciseId: string) => LoggingType | undefined): Records {
  const byWorkout = new Map<string, PR[]>();
  const state = new Map<string, ExerciseState>();

  for (const w of [...workouts].sort(byStart)) {
    const sets = new Map<string, StatSet[]>();
    for (const e of w.exercises) sets.set(e.exercise_id, [...(sets.get(e.exercise_id) ?? []), ...counted(e.sets)]);
    const earned: PR[] = [];

    for (const [exerciseId, list] of sets) {
      const lt = logging(exerciseId);
      if (!lt || list.length === 0) continue;
      const types = RECORD_TYPES[lt];
      const st = state.get(exerciseId) ?? { sessions: 0, best: {}, points: [], frontier: [] };
      state.set(exerciseId, st);
      const pr = (type: RecordType, c: Candidate): PR => ({
        type, exercise_id: exerciseId, workout_id: w.id, started_at: w.started_at, workout_date: w.workout_date,
        set: c.set, value: c.value, ...(c.kg !== undefined ? { kg: c.kg, reps: c.reps } : {}),
      });

      for (const type of types) {
        if (type === "reps_at_weight") continue;
        const c = candidate(type, list);
        if (!c) continue;
        const prev = st.best[type];
        if (!prev || c.value > prev.value + Math.max(prev.tol, c.tol)) {
          const p = pr(type, c);
          if (prev && st.sessions > 0) earned.push(p);
          st.best[type] = { ...c, pr: p };
        }
      }

      if (types.includes("reps_at_weight")) {
        const here = list.filter(weighted).map((s) => ({ s, kg: kg(s)!, reps: s.reps! }));
        let pick: (typeof here)[number] | null = null;
        for (const h of here) {
          if (dominated(h, st.points)) continue;
          if (!pick || h.kg > pick.kg + SAME_KG || (Math.abs(h.kg - pick.kg) <= SAME_KG && h.reps > pick.reps)) pick = h;
        }
        if (pick && st.sessions > 0 && st.points.length > 0) {
          earned.push(pr("reps_at_weight", { set: pick.s, value: pick.reps, tol: 0, kg: pick.kg, reps: pick.reps }));
        }
        // The frontier keeps every set that nothing before it (or beside it) beat.
        for (const h of here) {
          if (dominated(h, st.points)) continue;
          if (here.some((o) => o !== h && o.reps >= h.reps && o.kg >= h.kg - SAME_KG && (o.reps > h.reps || o.kg > h.kg + SAME_KG || here.indexOf(o) < here.indexOf(h)))) continue;
          st.frontier.push(pr("reps_at_weight", { set: h.s, value: h.reps, tol: 0, kg: h.kg, reps: h.reps }));
        }
        st.points.push(...here.map(({ kg, reps }) => ({ kg, reps })));
      }
      st.sessions += 1;
    }
    if (earned.length) byWorkout.set(w.id, earned);
  }

  const byExercise = new Map<string, ExerciseRecords>();
  for (const [id, st] of state) {
    const best: Partial<Record<RecordType, PR>> = {};
    for (const [t, c] of Object.entries(st.best)) best[t as RecordType] = c!.pr;
    const frontier = st.frontier.filter((a) => !st.frontier.some((b) => b !== a && b.reps! >= a.reps! && b.kg! >= a.kg! - SAME_KG
      && (b.reps! > a.reps! || b.kg! > a.kg! + SAME_KG)));
    byExercise.set(id, { best, frontier: frontier.sort((a, b) => b.kg! - a.kg!) });
  }
  return { byWorkout, byExercise };
}

function candidate(type: RecordType, sets: StatSet[]): Candidate | null {
  switch (type) {
    case "heaviest": return top(sets, (s) => (weighted(s) ? kg(s) : null), () => SAME_KG);
    case "e1rm": return top(sets, (s) => (weighted(s) ? e1rm(kg(s)!, s.reps!) : null), () => SAME_KG);
    case "set_volume": return top(sets, setVolume, (s) => SAME_KG * (s.reps ?? 0));
    case "session_volume": {
      const vs = sets.filter(weighted);
      if (!vs.length) return null;
      const reps = vs.reduce((n, s) => n + s.reps!, 0);
      return { set: null, value: vs.reduce((n, s) => n + setVolume(s)!, 0), tol: SAME_KG * reps };
    }
    case "most_reps": return top(sets, (s) => s.reps);
    case "longest_time": return top(sets, (s) => s.duration_seconds);
    case "longest_distance": return top(sets, meters, () => 0.0005);
    default: return null;
  }
}

/** The records one workout earned, judged only against workouts that started
 *  before it (never against itself). For the finish summary. */
export function recordsFor(workouts: StatWorkout[], workoutId: string, logging: (exerciseId: string) => LoggingType | undefined): PR[] {
  const w = workouts.find((x) => x.id === workoutId);
  if (!w) return [];
  const before = workouts.filter((x) => x.id !== workoutId && byStart(x, w) < 0);
  return records([...before, w], logging).byWorkout.get(workoutId) ?? [];
}

// ---------- sessions, for the exercise page and its chart ----------

export type Session = {
  workout: StatWorkout;
  /** Every set of the exercise in that workout, warm-ups included, in order. */
  sets: StatSet[];
  /** Best estimated 1RM, heaviest weight, and volume in kg; null when no set has one. */
  e1rm: number | null;
  heaviest: number | null;
  volume: number | null;
  most_reps: number | null;
  longest_time: number | null;
  longest_distance: number | null;
};

/** Every session of one exercise, newest first. */
export function sessions(workouts: StatWorkout[], exerciseId: string): Session[] {
  const out: Session[] = [];
  for (const w of workouts) {
    const all = w.exercises.filter((e) => e.exercise_id === exerciseId).flatMap((e) => e.sets);
    if (!all.length) continue;
    const list = counted(all);
    const vol = candidate("session_volume", list);
    out.push({
      workout: w, sets: all,
      e1rm: candidate("e1rm", list)?.value ?? null,
      heaviest: candidate("heaviest", list)?.value ?? null,
      volume: vol?.value ?? null,
      most_reps: candidate("most_reps", list)?.value ?? null,
      longest_time: candidate("longest_time", list)?.value ?? null,
      longest_distance: candidate("longest_distance", list)?.value ?? null,
    });
  }
  return out.sort((a, b) => byStart(b.workout, a.workout));
}

// ---------- hard sets per muscle per week ----------

export const UNASSIGNED = "unassigned";

/** The Monday that starts the week of a workout date (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export type MuscleMapFor = (exerciseId: string) => { primary: string[]; secondary: string[] } | undefined;

/**
 * Hard sets per muscle, per week (Monday start, by workout date). Every
 * completed set except warm-ups counts, whatever its logging type: 1 for each
 * primary muscle, 0.5 for each secondary (Pelland et al. 2024). Sets on an
 * exercise with no muscles count under "unassigned". Uses the current maps.
 * Week -> muscle -> sets.
 */
export function muscleSets(workouts: StatWorkout[], muscles: MuscleMapFor): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const w of workouts) {
    const week = weekStart(w.workout_date);
    const m = out.get(week) ?? new Map<string, number>();
    out.set(week, m);
    const add = (k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
    for (const e of w.exercises) {
      const n = counted(e.sets).length;
      if (!n) continue;
      const map = muscles(e.exercise_id);
      if (!map || (!map.primary.length && !map.secondary.length)) { add(UNASSIGNED, n); continue; }
      for (const p of map.primary) add(p, n);
      for (const s of map.secondary) add(s, n * 0.5);
    }
  }
  return out;
}
