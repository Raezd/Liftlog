/**
 * Editing a finished workout that the server has: the editor's form, built
 * from the workout as the server returned it, and the save body
 * (POST /api/workouts/{id}/edit). The page is pages/WorkoutEdit.tsx.
 *
 * Sets reuse the workout screen's ActiveSet (and so its inputs, limits, and
 * setProblem). Rest isn't editable here: each exercise carries the rest it
 * used, kept on a superset's first exercise like the workout screen does.
 * Values a set holds that its logging type doesn't show are kept as they
 * are, never dropped, so changing an exercise's logging type later never
 * erases history through an edit.
 *
 * Runtime imports name their .ts files, so Node's test runner can load this
 * file; keep everything it imports free of other runtime imports.
 */
import { duration, setLabels } from "./format.ts";
import { units, type Linked } from "./reorder.ts";
import { FIELDS, parseDuration, setProblem, type ActiveSet } from "./session.ts";
import type { DistanceUnit, LoggingType, SetType, WeightUnit, WorkoutDetail } from "./types";

export type EditExercise = Linked & {
  /** Also the workout exercise's id on the server. */
  key: string;
  exercise_id: string;
  name: string;
  logging_type: LoggingType;
  notes: string;
  /** The rest it used. Null for imports. */
  rest: number | null;
  sets: ActiveSet[];
};

export type EditForm = {
  title: string;
  notes: string;
  /** In the user's timezone: YYYY-MM-DD and HH:MM. */
  start_date: string;
  start_time: string;
  hours: string;
  minutes: string;
  exercises: EditExercise[];
};

type Units = { weight_unit: WeightUnit; distance_unit: DistanceUnit };
type Info = { name: string; logging_type: LoggingType };

/** A moment as the user's own date and time (24-hour) in their timezone. */
export function localParts(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** The form for a workout, with the exercises' current names and logging types. */
export function editForm(w: WorkoutDetail, info: Map<string, Info>, timeZone: string, u: Units): EditForm {
  const { date, time } = localParts(w.started_at, timeZone);
  const total = w.ended_at ? Math.max(0, Math.floor((Date.parse(w.ended_at) - Date.parse(w.started_at)) / 60_000)) : 0;
  const exs = w.exercises;
  return {
    title: w.title, notes: w.notes, start_date: date, start_time: time,
    hours: String(Math.floor(total / 60)), minutes: String(total % 60),
    exercises: exs.map((e, i): EditExercise => {
      const linkNext = e.superset_group !== null && exs[i + 1]?.superset_group === e.superset_group;
      const first = linkNext && exs[i - 1]?.superset_group !== e.superset_group;
      const x = info.get(e.exercise_id);
      return {
        key: e.id, exercise_id: e.exercise_id, name: x?.name ?? e.name, logging_type: x?.logging_type ?? "weight_reps",
        notes: e.notes, rest: e.rest_seconds, linkNext, supersetRest: first ? e.rest_seconds : null,
        sets: e.sets.map((s): ActiveSet => ({
          id: s.id, set_type: s.set_type,
          weight: s.weight_value ?? "", weight_unit: s.weight_unit ?? u.weight_unit,
          reps: s.reps?.toString() ?? "",
          duration: s.duration_seconds != null ? duration(s.duration_seconds) : "",
          distance: s.distance_value ?? "", distance_unit: s.distance_unit ?? u.distance_unit,
          rpe: s.rpe, done: true, completed_at: s.completed_at, hint: null,
        })),
      };
    }),
  };
}

/** A set added in the editor: like the one before it (type and values), or empty. */
export function addedSet(e: EditExercise, u: Units, id: string): ActiveSet {
  const last = e.sets[e.sets.length - 1];
  if (last) return { ...last, id, completed_at: null, rpe: null };
  return {
    id, set_type: "normal" as SetType, weight: "", weight_unit: u.weight_unit, reps: "", duration: "", distance: "",
    distance_unit: u.distance_unit, rpe: null, done: true, completed_at: null, hint: null,
  };
}

/** Total minutes, or null if the hours and minutes aren't whole numbers. */
export function durationMinutes(f: Pick<EditForm, "hours" | "minutes">): number | null {
  const h = f.hours.trim() || "0", m = f.minutes.trim() || "0";
  if (!/^\d{1,6}$/.test(h) || !/^\d{1,6}$/.test(m)) return null;
  return Number(h) * 60 + Number(m);
}

/** The first thing the server would refuse that can be checked here, in plain words, or null. */
export function formProblem(f: EditForm): string | null {
  if (!f.title.trim()) return "Give the workout a name.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.start_date) || !/^\d{2}:\d{2}$/.test(f.start_time)) return "Pick a start date and time.";
  const total = durationMinutes(f);
  if (total === null) return "Write the duration in whole hours and minutes.";
  if (total <= 0) return "The workout needs to last at least a minute.";
  if (!f.exercises.length) return "A workout needs at least one exercise. To remove it all, delete the workout.";
  for (const e of f.exercises) {
    if (!e.sets.length) return `${e.name} has no sets. Add a set or remove the exercise.`;
    const labels = setLabels(e.sets);
    for (const [k, s] of e.sets.entries()) {
      const why = setProblem(s, FIELDS[e.logging_type]);
      if (why) return `${e.name}, ${labels[k].name.toLowerCase()}: ${why}`;
    }
  }
  return null;
}

/** Every value the set holds, shown or not. */
function setBody(s: ActiveSet) {
  const weight = s.weight.trim() || null;
  const distance = s.distance.trim() || null;
  return {
    id: s.id, set_type: s.set_type,
    weight_value: weight, weight_unit: weight ? s.weight_unit : null,
    reps: s.reps.trim() ? Number(s.reps) : null,
    rpe: s.rpe,
    duration_seconds: parseDuration(s.duration) ?? null,
    distance_value: distance, distance_unit: distance ? s.distance_unit : null,
  };
}

/** The save: the whole edited workout and the revision it started from. Check formProblem first. */
export function editBody(f: EditForm, baseRevision: number) {
  const group: (number | null)[] = [];
  let n = 0;
  for (const u of units(f.exercises)) {
    const g = u.length > 1 ? n++ : null;
    for (let i = 0; i < u.length; i++) group.push(g);
  }
  return {
    base_revision: baseRevision, title: f.title.trim(), notes: f.notes.trim(),
    start_date: f.start_date, start_time: f.start_time, duration_minutes: durationMinutes(f) ?? 0,
    exercises: f.exercises.map((e, i) => {
      const first = group[i] !== null && group[i - 1] !== group[i];
      return {
        id: e.key, exercise_id: e.exercise_id, superset_group: group[i], notes: e.notes.trim(),
        rest_seconds: first ? e.supersetRest ?? e.rest : e.rest,
        sets: e.sets.map(setBody),
      };
    }),
  };
}
