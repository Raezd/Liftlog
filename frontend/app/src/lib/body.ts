/**
 * Body measurements on screen: values in the chosen unit, and changes over
 * time. Pure, run on the server's answer or the phone's copy alike. Tests in
 * tests/body.test.ts. Keep the file free of runtime imports.
 *
 * - A value shows exactly as entered when its unit is the display unit, so
 *   switching units and back never drifts. Otherwise it's converted from the
 *   stored cm and rounded to 0.1.
 * - A site's change since previous compares its latest value with the
 *   previous check-in that included that site (and side), skipping check-ins
 *   that didn't; since first compares with its first. Same unit: exact, in
 *   hundredths. Mixed: from cm, to 0.1.
 * - Body fat changes only between readings with the same method; across
 *   methods there's no change to show.
 */
import type { BodyCheckin, BodyFatMethod, BodyValue, LengthUnit, Side } from "./types";

export const CM_PER: Record<LengthUnit, number> = { cm: 1, in: 2.54 };

export const METHODS: Record<BodyFatMethod, string> = {
  calipers: "Calipers", smart_scale: "Smart scale", dexa: "DEXA", navy_tape: "Tape (Navy)", visual: "Visual estimate", other: "Other",
};
/** Mid-sentence: "by smart scale". */
export const METHODS_IN_TEXT: Record<BodyFatMethod, string> = {
  calipers: "calipers", smart_scale: "smart scale", dexa: "DEXA", navy_tape: "tape (Navy)", visual: "visual estimate", other: "another method",
};

/** Limits per unit: 1 to 300 cm, at most two decimals (the server's and the database's too). */
export const RANGE: Record<LengthUnit, [number, number]> = { cm: [1, 300], in: [0.4, 118.11] };
export const VALUE_INPUT = /^\d{0,3}(\.\d{0,2})?$/;
export const FAT_INPUT = /^\d{0,2}(\.\d{0,2})?$/;

const hundredths = (s: string) => Math.round(Number(s) * 100);
const tenth = (n: number) => Math.round(n * 10) / 10;

/** A value in the display unit, as a number. */
export function inUnit(v: Pick<BodyValue, "value" | "unit" | "value_cm">, unit: LengthUnit): number {
  return v.unit === unit ? Number(v.value) : tenth(Number(v.value_cm) / CM_PER[unit]);
}

export const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** "32.25 in": as entered when the units match. */
export function valueText(v: Pick<BodyValue, "value" | "unit" | "value_cm">, unit: LengthUnit): string {
  return `${v.unit === unit ? v.value : fmt(inUnit(v, unit))} ${unit}`;
}

/** b minus a, in the display unit. */
export function difference(a: BodyValue, b: BodyValue, unit: LengthUnit): number {
  if (a.unit === unit && b.unit === unit) return (hundredths(b.value) - hundredths(a.value)) / 100;
  return tenth((Number(b.value_cm) - Number(a.value_cm)) / CM_PER[unit]);
}

/** "+0.5 in", "-1.25 in", "No change". */
export function changeText(n: number, unit: string): string {
  if (n === 0) return "No change";
  return `${n > 0 ? "+" : "-"}${fmt(Math.abs(n))} ${unit}`;
}

export type Reading = { date: string; checkin_id: string; value: BodyValue };

/** A site's values (one side of a paired site), oldest first. */
export function readings(checkins: BodyCheckin[], siteId: string, side: Side | null): Reading[] {
  const out: Reading[] = [];
  for (const c of checkins) {
    const v = c.values.find((x) => x.site_id === siteId && x.side === side);
    if (v) out.push({ date: c.date, checkin_id: c.id, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export type Trend<R> = {
  latest: R;
  /** Null when the latest is the only one. */
  previous: R | null;
  first: R | null;
  /** Null when there's nothing to compare (or, for body fat, the methods differ). */
  sincePrevious: number | null;
  sinceFirst: number | null;
};

export function siteTrend(checkins: BodyCheckin[], siteId: string, side: Side | null, unit: LengthUnit): Trend<Reading> | null {
  const r = readings(checkins, siteId, side);
  if (!r.length) return null;
  const latest = r[r.length - 1];
  if (r.length === 1) return { latest, previous: null, first: null, sincePrevious: null, sinceFirst: null };
  const previous = r[r.length - 2], first = r[0];
  return {
    latest, previous, first,
    sincePrevious: difference(previous.value, latest.value, unit),
    sinceFirst: difference(first.value, latest.value, unit),
  };
}

export type FatReading = { date: string; checkin_id: string; pct: string; method: BodyFatMethod };

export function fatReadings(checkins: BodyCheckin[]): FatReading[] {
  return checkins
    .flatMap((c) => (c.body_fat_pct !== null && c.body_fat_method !== null
      ? [{ date: c.date, checkin_id: c.id, pct: c.body_fat_pct, method: c.body_fat_method }] : []))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function fatTrend(checkins: BodyCheckin[]): Trend<FatReading> | null {
  const r = fatReadings(checkins);
  if (!r.length) return null;
  const latest = r[r.length - 1];
  if (r.length === 1) return { latest, previous: null, first: null, sincePrevious: null, sinceFirst: null };
  const previous = r[r.length - 2], first = r[0];
  const change = (a: FatReading) => (a.method === latest.method ? (hundredths(latest.pct) - hundredths(a.pct)) / 100 : null);
  return { latest, previous, first, sincePrevious: change(previous), sinceFirst: change(first) };
}

/** What's wrong with a typed value, in plain words, or null. Empty is fine (not measured). */
export function valueProblem(label: string, text: string, unit: LengthUnit): string | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t) && !/^\.\d{1,2}$/.test(t)) return `${label}: enter a number with at most two decimal places.`;
  const [low, high] = RANGE[unit];
  const n = Number(t);
  if (n < low || n > high) return `${label}: enter ${fmt(low)} to ${fmt(high)} ${unit}.`;
  return null;
}

export function fatProblem(text: string, method: string): string | null {
  const t = text.trim();
  if (!t) return method ? "Enter a body fat percentage, or clear the method." : null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return "Body fat: enter a number with at most two decimal places.";
  const n = Number(t);
  if (n < 1 || n > 75) return "Body fat should be 1 to 75 percent.";
  if (!method) return "Pick how body fat was measured.";
  return null;
}
