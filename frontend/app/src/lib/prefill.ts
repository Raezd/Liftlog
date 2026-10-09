/**
 * What to prefill in each set when a routine starts (used by the workout
 * screen in Spec 5). Pure and synchronous, so it runs offline on cached
 * history. Tests: tests/prefill.test.ts (`npm test`).
 *
 * The rule, per exercise in the routine:
 * 1. Find the most recent finished workout that started from this same
 *    routine (any version) and included the exercise. If there is none, the
 *    most recent finished workout with the exercise from anywhere. Imported
 *    workouts count, and count as finished.
 * 2. Match sets by position within the same set type: the second warm-up
 *    matches the second warm-up, the first normal set the first normal set.
 * 3. Use the matched set's weight and reps (and duration and distance). A
 *    field the past set left empty falls back to the target.
 * 4. No matching past set: use the routine's target. A rep range prefills
 *    its low end. No target either: leave the field empty.
 * 5. A rep range always shows as a hint ("8 to 12"), whatever was prefilled.
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */
import type { DistanceUnit, SetType, WeightUnit } from "./types";

type Distance = DistanceUnit | "m";

export type TargetSet = {
  set_type: SetType;
  reps_min: number | null;
  reps_max: number | null;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: Distance | null;
};

export type RoutinePlan = {
  /** The routine (not version) id: any version of the same routine counts as the same routine. */
  routine_id: string;
  exercises: { exercise_id: string; sets: TargetSet[] }[];
};

export type PastSet = {
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: Distance | null;
};

export type PastWorkout = {
  id: string;
  /** The routine it started from, or null (imported, or started empty). */
  routine_id: string | null;
  started_at: string;
  ended_at: string | null;
  source: "liftlog" | "hevy_import";
  exercises: { exercise_id: string; sets: PastSet[] }[];
};

export type PrefillSource = "same_routine" | "history" | "target" | "empty";

export type PrefilledSet = {
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: Distance | null;
  /** Where the values came from. */
  source: PrefillSource;
  /** The past workout the values came from, if any. */
  workout_id: string | null;
  /** "8 to 12" for a rep range, shown beside the reps field. */
  reps_hint: string | null;
};

export const isFinished = (w: PastWorkout) => w.ended_at !== null || w.source === "hevy_import";

export function repsHint(t: Pick<TargetSet, "reps_min" | "reps_max">): string | null {
  return t.reps_min !== null && t.reps_max !== null && t.reps_min !== t.reps_max ? `${t.reps_min} to ${t.reps_max}` : null;
}

/** The nth set of each type, so sets match by position within their type. */
function byType<T extends { set_type: SetType }>(sets: T[]): (T & { nth: number })[] {
  const seen: Partial<Record<SetType, number>> = {};
  return sets.map((s) => {
    const nth = seen[s.set_type] ?? 0;
    seen[s.set_type] = nth + 1;
    return { ...s, nth };
  });
}

export function prefill(plan: RoutinePlan, history: PastWorkout[]): PrefilledSet[][] {
  const finished = history.filter(isFinished).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  // Which occurrence of an exercise this is, for a routine that has it twice.
  const occurrence: Record<string, number> = {};

  return plan.exercises.map((ex) => {
    const k = occurrence[ex.exercise_id] ?? 0;
    occurrence[ex.exercise_id] = k + 1;
    const has = (w: PastWorkout) => w.exercises.some((e) => e.exercise_id === ex.exercise_id);
    const same = finished.find((w) => w.routine_id === plan.routine_id && has(w));
    const past = same ?? finished.find(has);
    const source: PrefillSource = same ? "same_routine" : "history";
    let pastSets: (PastSet & { nth: number })[] = [];
    if (past) {
      const entries = past.exercises.filter((e) => e.exercise_id === ex.exercise_id);
      pastSets = byType((entries[k] ?? entries[0]).sets);
    }

    return byType(ex.sets).map((t): PrefilledSet => {
      const hint = repsHint(t);
      const target = {
        weight_value: t.weight_value, weight_unit: t.weight_value !== null ? t.weight_unit : null,
        reps: t.reps_min, duration_seconds: t.duration_seconds,
        distance_value: t.distance_value, distance_unit: t.distance_value !== null ? t.distance_unit : null,
      };
      const match = pastSets.find((p) => p.set_type === t.set_type && p.nth === t.nth);
      if (match) {
        const weight = match.weight_value !== null;
        const distance = match.distance_value !== null;
        return {
          set_type: t.set_type,
          weight_value: weight ? match.weight_value : target.weight_value,
          weight_unit: weight ? match.weight_unit : target.weight_unit,
          reps: match.reps ?? target.reps,
          duration_seconds: match.duration_seconds ?? target.duration_seconds,
          distance_value: distance ? match.distance_value : target.distance_value,
          distance_unit: distance ? match.distance_unit : target.distance_unit,
          source, workout_id: past!.id, reps_hint: hint,
        };
      }
      const any = Object.values(target).some((v) => v !== null);
      return { set_type: t.set_type, ...target, source: any ? "target" : "empty", workout_id: null, reps_hint: hint };
    });
  });
}
