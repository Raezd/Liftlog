/**
 * Plate math: which plates go on each side of the bar for a target weight.
 * Pure and on the phone, so it works offline. Tests: tests/plates.test.ts.
 *
 * - The search is exact, never greedy: it finds every load the plates can
 *   make, respecting each plate's pair count, its on or off state, and the
 *   plates left out for this workout.
 * - Ties (several loadings hit the target): fewest plates, then fewest
 *   distinct sizes, then heaviest plates first. So 90 lb per side is 45 and
 *   45, not 55 and 35.
 * - A target the plates can't make gives the nearest load below and above.
 *   A target under the bar says so and shows the empty bar.
 * - Units: when the bar, every plate in use, and the target share a unit,
 *   the math runs in whole hundredths of it (finer if a value needs it), so
 *   137.5 lb stays 137.5. Mixed units run in whole grams and show rounded
 *   to 0.1 in the target's unit.
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */
import type { WeightUnit } from "./types";

export type GearWeight = { weight_value: string; weight_unit: WeightUnit };
export type PlateIn = GearWeight & { id: string; enabled: boolean; pair_count: number | null };

/** Plates on one side, heaviest first, each size once with how many. */
export type PerSide = GearWeight & { count: number };
/** A loading: the total (bar plus plates) in the target's unit, and the plates per side. */
export type Loading = { total: string; perSide: PerSide[] };

export type PlateResult =
  | { kind: "below_bar"; unit: WeightUnit }
  | { kind: "exact"; unit: WeightUnit; load: Loading }
  | { kind: "nearest"; unit: WeightUnit; below: Loading | null; above: Loading | null };

const GRAMS: Record<WeightUnit, number> = { kg: 1000, lb: 453.59237 };
const NUMBER = /^\d+(\.\d+)?$/;
// Stops a pathological plate set from hanging the screen. Real sets need far fewer.
const MAX_STEPS = 2_000_000;

const decimals = (s: string) => (s.split(".")[1] ?? "").length;

/** "137.5" at 2 decimals is 13750, exactly. */
function scaled(s: string, d: number): number {
  const [i, f = ""] = s.split(".");
  return Number(i) * 10 ** d + Number((f + "0".repeat(d)).slice(0, d) || "0");
}

function unscaled(n: number, d: number): string {
  const i = Math.floor(n / 10 ** d);
  const f = String(n % 10 ** d).padStart(d, "0").replace(/0+$/, "");
  return f ? `${i}.${f}` : String(i);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Plates per side for `target` on `bar`. Null when the target isn't a number. */
export function plateMath(target: { value: string; unit: WeightUnit }, bar: GearWeight, plates: PlateIn[], excluded: readonly string[] = []): PlateResult | null {
  const value = target.value.trim();
  if (!NUMBER.test(value) || !NUMBER.test(bar.weight_value)) return null;
  const unit = target.unit;
  const usable = plates.filter((p) => p.enabled && !excluded.includes(p.id) && p.pair_count !== 0 && NUMBER.test(p.weight_value));

  // Integer units: hundredths (or finer) of a shared unit, else grams.
  const same = bar.weight_unit === unit && usable.every((p) => p.weight_unit === unit);
  const d = same ? Math.max(2, decimals(value), decimals(bar.weight_value), ...usable.map((p) => decimals(p.weight_value))) : 0;
  const toInt = (s: string, u: WeightUnit) => (same ? scaled(s, d) : Math.round(Number(s) * GRAMS[u]));
  const show = (n: number) => (same ? unscaled(n, d) : String(Math.round((n / GRAMS[unit]) * 10) / 10));

  const t = toInt(value, unit);
  const b = toInt(bar.weight_value, bar.weight_unit);
  if (t < b) return { kind: "below_bar", unit };
  const diff = t - b;

  // One entry per plate size, heaviest first. Two entries of the same weight share their pairs.
  const sizes: { w: number; plate: PlateIn; cap: number }[] = [];
  for (const p of usable) {
    const w = toInt(p.weight_value, p.weight_unit);
    if (w <= 0) continue;
    const cap = p.pair_count ?? Infinity;
    const dup = sizes.find((s) => s.w === w);
    if (dup) dup.cap += cap;
    else sizes.push({ w, plate: p, cap });
  }
  sizes.sort((x, y) => y.w - x.w);

  const load = (sum: number, counts: number[]): Loading => ({
    total: show(b + sum),
    perSide: sizes.flatMap((s, i) => (counts[i] ? [{ weight_value: s.plate.weight_value, weight_unit: s.plate.weight_unit, count: counts[i] }] : [])),
  });
  if (sizes.length === 0) {
    return diff === 0 ? { kind: "exact", unit, load: load(0, []) } : { kind: "nearest", unit, below: load(0, []), above: null };
  }

  // Work in steps of the largest unit every pair is a multiple of.
  const g = sizes.reduce((a, s) => gcd(a, 2 * s.w), 0);
  const pair = sizes.map((s) => (2 * s.w) / g);
  const lo = Math.floor(diff / g);
  const hi = Math.ceil(diff / g);
  const top = hi + pair[0];
  const n = sizes.length;
  const caps = sizes.map((s, i) => Math.min(s.cap, Math.floor(top / pair[i])));

  // reach[i][s]: the plates from size i down can make exactly s.
  const reach: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(top + 1));
  reach[n][0] = 1;
  const used = new Int32Array(top + 1);
  for (let i = n - 1; i >= 0; i--) {
    const r = reach[i], next = reach[i + 1], p = pair[i];
    for (let s = 0; s <= top; s++) {
      if (next[s]) { r[s] = 1; used[s] = 0; }
      else if (s >= p && r[s - p] && used[s - p] < caps[i]) { r[s] = 1; used[s] = used[s - p] + 1; }
    }
  }

  /** The best loading for exactly s steps, by the tie rule. */
  function best(s: number): Loading {
    let bestCounts: number[] | null = null;
    let bestPlates = Infinity, bestDistinct = Infinity;
    const counts = new Array<number>(n).fill(0);
    let steps = 0;
    const better = (plates: number, distinct: number) => {
      if (plates !== bestPlates) return plates < bestPlates;
      if (distinct !== bestDistinct) return distinct < bestDistinct;
      for (let i = 0; i < n; i++) if (counts[i] !== bestCounts![i]) return counts[i] > bestCounts![i];
      return false;
    };
    const search = (i: number, rem: number, plates: number, distinct: number) => {
      if (++steps > MAX_STEPS) return;
      if (rem === 0) {
        if (better(plates, distinct)) { bestCounts = counts.slice(); bestPlates = plates; bestDistinct = distinct; }
        return;
      }
      if (i === n || plates + Math.ceil(rem / pair[i]) > bestPlates) return;
      for (let k = Math.min(caps[i], Math.floor(rem / pair[i])); k >= 0; k--) {
        if (!reach[i + 1][rem - k * pair[i]]) continue;
        counts[i] = k;
        search(i + 1, rem - k * pair[i], plates + k, distinct + (k > 0 ? 1 : 0));
      }
      counts[i] = 0;
    };
    search(0, s, 0, 0);
    return load(s * g, bestCounts ?? counts);
  }

  if (diff % g === 0 && reach[0][lo]) return { kind: "exact", unit, load: best(lo) };
  let below = lo;
  while (!reach[0][below]) below--;
  let above = hi;
  while (above <= top && !reach[0][above]) above++;
  return { kind: "nearest", unit, below: best(below), above: above <= top ? best(above) : null };
}

/** "45 lb" */
export const weightText = (w: GearWeight) => `${w.weight_value} ${w.weight_unit}`;

type GearLike<B, S> = { default_bar_id: string | null; default_plate_set_id: string | null; bars: B[]; plate_sets: S[] };

/** An exercise's bar and plate set: its own, else the user's defaults. */
export function gearFor<B extends { id: string }, S extends { id: string }>(
  gear: GearLike<B, S>, ex: { bar_id: string | null; plate_set_id: string | null },
): { bar: B | undefined; plateSet: S | undefined } {
  const pick = <T extends { id: string }>(list: T[], own: string | null, fallback: string | null) =>
    list.find((x) => x.id === own) ?? list.find((x) => x.id === fallback) ?? list[0];
  return { bar: pick(gear.bars, ex.bar_id, gear.default_bar_id), plateSet: pick(gear.plate_sets, ex.plate_set_id, gear.default_plate_set_id) };
}
