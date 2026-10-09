/**
 * Volume (tonnage): normalized kg times reps over completed normal, drop,
 * and failure sets, shown in the user's unit. Warm-ups never count. Only
 * weight and reps, and weighted bodyweight (the added weight), add tonnage;
 * bodyweight, assisted, duration, and distance exercises add none.
 * Tests: tests/volume.test.ts (`npm test`).
 *
 * Weights are summed exactly as entered, per unit, in millionths, and only
 * the other unit's part is converted at the end. So pounds entered show as
 * exact pounds (3 x 10 at 135 lb is 4,050 lb, not 4,049.99).
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */
import type { LoggingType, SetType, WeightUnit } from "./types";

export type VolumeSet = {
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
};

export type VolumeExercise = { logging_type: LoggingType; sets: VolumeSet[] };

const COUNTED_TYPES: SetType[] = ["normal", "drop", "failure"];
const TONNAGE: LoggingType[] = ["weight_reps", "weighted_bodyweight"];
// Exact by definition (1959): 1 lb = 0.45359237 kg.
const LB_IN_KG = 0.45359237;
const SCALE = 1_000_000n;

/** "137.5" as millionths, or null if it isn't a plain decimal. */
function micros(v: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** Total volume in `unit`, or null when no set counts (no data, not zero). */
export function volume(exercises: VolumeExercise[], unit: WeightUnit): number | null {
  const sum: Record<WeightUnit, bigint> = { lb: 0n, kg: 0n };
  let counted = false;
  for (const e of exercises) {
    if (!TONNAGE.includes(e.logging_type)) continue;
    for (const s of e.sets) {
      if (!COUNTED_TYPES.includes(s.set_type) || s.weight_value === null || s.weight_unit === null || s.reps === null) continue;
      const w = micros(s.weight_value);
      if (w === null) continue;
      sum[s.weight_unit] += w * BigInt(s.reps);
      counted = true;
    }
  }
  if (!counted) return null;
  const lb = Number(sum.lb) / 1e6;
  const kg = Number(sum.kg) / 1e6;
  return unit === "lb" ? lb + kg / LB_IN_KG : kg + lb * LB_IN_KG;
}

export function formatVolume(v: number, unit: WeightUnit): string {
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}
