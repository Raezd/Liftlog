/**
 * History for the stats pages: the copy plus this login's workouts still on
 * the phone (lib/stats.ts runs on it). The copy refreshes on its own in the
 * app and on the web (lib/offline.ts), so the same numbers show either way.
 */
import { useEffect, useMemo } from "react";
import { duration } from "./format";
import { refresh, useOffline } from "./offline";
import { RECORD_TYPES, fromKg, records, statWorkouts, type PR, type RecordType, type StatSet } from "./stats";
import type { Exercise, LoggingType, Me, OfflineCopy, WeightUnit } from "./types";
import { formatVolume } from "./volume";

export type Stats = {
  me: Me;
  copy: OfflineCopy;
  workouts: ReturnType<typeof statWorkouts>;
  exercises: Map<string, Exercise>;
  logging: (id: string) => LoggingType | undefined;
  records: ReturnType<typeof records>;
};

/** null while loading; `failed` when there's no copy and the server can't be reached. */
export function useStats(): { stats: Stats | null; failed: boolean } {
  const off = useOffline();
  // Fresh numbers when a stats page opens (at most every 30 seconds; quiet offline).
  useEffect(() => { void refresh(); }, []);
  const stats = useMemo(() => {
    const c = off.copy;
    if (!c || off.blocked) return null;
    const workouts = statWorkouts(c.workouts, off.queue.filter((q) => q.login === c.me.login), c.me.timezone);
    const exercises = new Map(c.exercises.map((e) => [e.id, e]));
    const logging = (id: string) => exercises.get(id)?.logging_type;
    return { me: c.me, copy: c, workouts, exercises, logging, records: records(workouts, logging) };
  }, [off.copy, off.queue, off.blocked]);
  return { stats, failed: !stats && off.ready && off.refreshed };
}

export const RECORD_NAME: Record<RecordType, string> = {
  heaviest: "Heaviest weight",
  reps_at_weight: "Most reps at a weight",
  e1rm: "Best estimated 1RM",
  set_volume: "Best set volume",
  session_volume: "Best session volume",
  most_reps: "Most reps in a set",
  longest_time: "Longest set",
  longest_distance: "Longest distance",
};

/** Short tag for a set that set a record. */
export const RECORD_TAG: Record<RecordType, string> = {
  heaviest: "Heaviest", reps_at_weight: "Most reps", e1rm: "Est. 1RM", set_volume: "Set volume",
  session_volume: "Session volume", most_reps: "Most reps", longest_time: "Longest", longest_distance: "Longest",
};

export const kgText = (kg: number, unit: WeightUnit) =>
  `${fromKg(kg, unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;

/** A set as entered: "225 lb x 5", "20 reps", "1:30", "3.1 mi". */
export function setText(s: StatSet): string {
  const parts: string[] = [];
  if (s.weight_value !== null) parts.push(`${s.weight_value} ${s.weight_unit}`);
  if (s.reps !== null) parts.push(s.weight_value !== null ? `x ${s.reps}` : `${s.reps} reps`);
  if (s.distance_value !== null) parts.push(`${s.distance_value} ${s.distance_unit}`);
  if (s.duration_seconds !== null) parts.push(duration(s.duration_seconds));
  return parts.join(" ") || "No data";
}

/** A record's value in words, in the user's weight unit where it's computed. */
export function recordText(p: PR, unit: WeightUnit): string {
  const s = p.set;
  switch (p.type) {
    case "heaviest": return s ? setText(s) : kgText(p.value, unit);
    case "reps_at_weight": return s ? setText(s) : `${p.reps} reps`;
    case "e1rm": return `${kgText(p.value, unit)} estimated${s ? `, from ${setText(s)}` : ""}`;
    case "set_volume": return `${formatVolume(fromKg(p.value, unit), unit)}${s ? `, ${setText(s)}` : ""}`;
    case "session_volume": return formatVolume(fromKg(p.value, unit), unit);
    case "most_reps": return `${p.value} reps`;
    case "longest_time": return duration(p.value);
    case "longest_distance": return s ? `${s.distance_value} ${s.distance_unit}` : `${Math.round(p.value)} m`;
  }
}

export const hasRecords = (lt: LoggingType | undefined) => !!lt && RECORD_TYPES[lt].length > 0;
