import type { Equipment, LoggingType, SetType } from "./types";

export const EQUIPMENT: Record<Equipment, string> = {
  barbell: "Barbell", dumbbell: "Dumbbell", machine: "Machine", cable: "Cable", bodyweight: "Bodyweight", other: "Other",
};

export const LOGGING: Record<LoggingType, string> = {
  weight_reps: "Weight and reps",
  bodyweight_reps: "Bodyweight reps",
  weighted_bodyweight: "Weighted bodyweight",
  assisted_bodyweight: "Assisted bodyweight",
  duration: "Duration",
  distance_duration: "Distance and duration",
};

export const SET_TYPE: Record<SetType, string> = { normal: "Normal", warmup: "Warm-up", drop: "Drop", failure: "Failure" };
export const SET_TYPE_SHORT: Record<SetType, string> = { normal: "", warmup: "W", drop: "D", failure: "F" };

/** A workout date (YYYY-MM-DD) as words, without timezone shifts. */
export const longDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const shortDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A clock time in the user's own timezone. */
export const clockTime = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone });

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function minutes(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const m = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
