// The plate math rules (src/lib/plates.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plateMath, type PlateIn, type PlateResult } from "../src/lib/plates.ts";
import type { WeightUnit } from "../src/lib/types";

const plate = (w: string, unit: WeightUnit = "lb", more: Partial<PlateIn> = {}): PlateIn =>
  ({ id: `${w}${unit}`, weight_value: w, weight_unit: unit, enabled: true, pair_count: null, ...more });
const OLYMPIC_LB = ["55", "45", "35", "25", "10", "5", "2.5", "1.25"].map((w) => plate(w));
const OLYMPIC_KG = ["25", "20", "15", "10", "5", "2.5", "2", "1.5", "1.25", "1", "0.5"].map((w) => plate(w, "kg"));
const BAR = { weight_value: "45", weight_unit: "lb" as const };

const lb = (value: string, plates = OLYMPIC_LB, excluded: string[] = [], bar = BAR) => plateMath({ value, unit: "lb" }, bar, plates, excluded);

/** "45x2 2.5" style, heaviest first, for short assertions. */
function side(r: PlateResult | null): string {
  assert.equal(r?.kind, "exact");
  if (r?.kind !== "exact") return "";
  return r.load.perSide.map((p) => (p.count > 1 ? `${p.weight_value}x${p.count}` : p.weight_value)).join(" ");
}

test("exact hits", () => {
  assert.equal(side(lb("225")), "45x2");
  assert.equal(side(lb("135")), "45");
  assert.equal(side(lb("45")), "");
  const r = lb("315");
  assert.equal(r?.kind === "exact" && r.load.total, "315");
});

test("ties: fewest plates, then fewest sizes, then heaviest first", () => {
  // 90 per side: 45 and 45, not 55 and 35.
  assert.equal(side(lb("225")), "45x2");
  // 80 per side: 55 + 25 and 45 + 35 tie on plates and sizes; the heavier plate wins.
  assert.equal(side(lb("205")), "55 25");
  // 25 per side: one 25, not 10 + 10 + 5.
  assert.equal(side(lb("95")), "25");
});

test("plates per side are listed heaviest to lightest", () => {
  for (const t of ["152.5", "232.5", "347.5", "407.5"]) {
    const r = lb(t);
    assert.equal(r?.kind, "exact", t);
    if (r?.kind !== "exact") continue;
    const ws = r.load.perSide.map((p) => Number(p.weight_value));
    assert.deepEqual(ws, ws.slice().sort((a, b) => b - a), t);
    assert.equal(new Set(ws).size, ws.length, `${t} lists each size once`);
  }
  assert.equal(side(lb("232.5")), "45x2 2.5 1.25");
});

test("unreachable targets give the nearest load below and above", () => {
  const r = lb("137");
  assert.equal(r?.kind, "nearest");
  if (r?.kind !== "nearest") return;
  assert.equal(r.below?.total, "135");
  assert.deepEqual(r.below?.perSide.map((p) => p.weight_value), ["45"]);
  assert.equal(r.above?.total, "137.5");
  assert.deepEqual(r.above?.perSide.map((p) => [p.weight_value, p.count]), [["45", 1], ["1.25", 1]]);
});

test("pair counts limit how many of a plate go on", () => {
  const one45 = OLYMPIC_LB.map((p) => (p.weight_value === "45" ? { ...p, pair_count: 1 } : p));
  assert.equal(side(lb("225", one45)), "55 35");
  // Only two pairs of 45s and nothing else: 405 can't be made, and nothing goes above 225.
  const r = lb("405", [plate("45", "lb", { pair_count: 2 })]);
  assert.equal(r?.kind === "nearest" && r.below?.total, "225");
  assert.equal(r?.kind === "nearest" && r.above, null);
});

test("plates turned off are left out", () => {
  const no45 = OLYMPIC_LB.map((p) => (p.weight_value === "45" ? { ...p, enabled: false } : p));
  assert.equal(side(lb("225", no45)), "55 35");
});

test("plates left out for this workout are left out", () => {
  assert.equal(side(lb("140")), "45 2.5");
  assert.equal(side(lb("140", OLYMPIC_LB, ["2.5lb"])), "45 1.25x2");
  const r = lb("140", OLYMPIC_LB, ["2.5lb", "1.25lb"]);
  assert.equal(r?.kind, "nearest");
  assert.deepEqual(r?.kind === "nearest" && [r.below?.total, r.above?.total], ["135", "145"]);
});

test("a target below the bar says so", () => {
  assert.deepEqual(lb("30"), { kind: "below_bar", unit: "lb" });
  assert.equal(lb("44.99")?.kind, "below_bar");
});

test("137.5 lb stays exact", () => {
  const r = lb("137.5");
  assert.equal(side(r), "45 1.25");
  assert.equal(r?.kind === "exact" && r.load.total, "137.5");
  // Whole hundredths, never floating point.
  assert.equal(side(lb("45.5", [plate("0.25")])), "0.25");
  assert.equal(side(lb("45.02", [plate("0.01")])), "0.01");
});

test("mixed units run in grams and show to 0.1", () => {
  // 135 lb (61.23 kg) on a 20 kg bar with kg plates: 61 kg or 61.5 kg.
  const r = plateMath({ value: "135", unit: "lb" }, { weight_value: "20", weight_unit: "kg" }, OLYMPIC_KG);
  assert.equal(r?.kind, "nearest");
  if (r?.kind !== "nearest") return;
  assert.equal(r.below?.total, "134.5"); // 61 kg
  assert.deepEqual(r.below?.perSide.map((p) => [p.weight_value, p.weight_unit]), [["20", "kg"], ["0.5", "kg"]]);
  assert.equal(r.above?.total, "135.6"); // 61.5 kg
  // 100 kg on a 45 lb bar with lb plates is 220.5 lb.
  const m = plateMath({ value: "100", unit: "kg" }, BAR, OLYMPIC_LB);
  assert.equal(m?.kind, "nearest");
  assert.deepEqual(m?.kind === "nearest" && [m.below?.total, m.above?.total], ["99.8", "100.9"]);
});

test("mixed units: a load that shows as the target is an exact hit", () => {
  const KG_BAR = { weight_value: "20", weight_unit: "kg" as const };
  // 60 kg is 132.28 lb: typing 132.3 lb on kg plates is 20 kg a side.
  const r = plateMath({ value: "132.3", unit: "lb" }, KG_BAR, OLYMPIC_KG);
  assert.equal(r?.kind, "exact");
  assert.deepEqual(r?.kind === "exact" && r.load.perSide.map((p) => [p.weight_value, p.weight_unit, p.count]), [["20", "kg", 1]]);
  assert.equal(r?.kind === "exact" && r.load.total, "132.3");
  // Tapping a nearest load (134.5, which is 61 kg) gives an exact hit, not the same two choices again.
  const n = plateMath({ value: "134.5", unit: "lb" }, KG_BAR, OLYMPIC_KG);
  assert.equal(n?.kind === "exact" && n.load.total, "134.5");
  assert.deepEqual(n?.kind === "exact" && n.load.perSide.map((p) => p.weight_value), ["20", "0.5"]);
  // 0.2 lb off isn't a hit.
  assert.equal(plateMath({ value: "132.5", unit: "lb" }, KG_BAR, OLYMPIC_KG)?.kind, "nearest");
});

test("a target heavier than anything the plates can make shows the heaviest load and nothing above", () => {
  // Every plate left out: only the empty bar.
  const all = OLYMPIC_LB.map((p) => p.id);
  const r = lb("225", OLYMPIC_LB, all);
  assert.equal(r?.kind, "nearest");
  if (r?.kind !== "nearest") return;
  assert.deepEqual(r.below, { total: "45", perSide: [] });
  assert.equal(r.above, null);
});

test("a weight that isn't a number gives nothing", () => {
  assert.equal(lb(""), null);
  assert.equal(lb("abc"), null);
});
