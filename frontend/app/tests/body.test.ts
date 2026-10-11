// Body measurement changes and display (src/lib/body.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changeText, fatTrend, inUnit, siteTrend, valueText } from "../src/lib/body.ts";
import type { BodyCheckin, BodyFatMethod, BodyValue, LengthUnit, Side } from "../src/lib/types.ts";

const CM: Record<LengthUnit, number> = { cm: 1, in: 2.54 };
let n = 0;
const v = (site: string, value: string, unit: LengthUnit = "in", side: Side | null = null): BodyValue => ({
  id: `v${++n}`, site_id: site, side, value, unit, value_cm: String(Math.round(Number(value) * CM[unit] * 10000) / 10000),
});
const checkin = (date: string, values: BodyValue[], fat?: [string, BodyFatMethod]): BodyCheckin => ({
  id: `c${++n}`, date, body_fat_pct: fat?.[0] ?? null, body_fat_method: fat?.[1] ?? null, notes: "", created_at: `${date}T12:00:00Z`, values,
});

test("change since previous skips a check-in without the site; since first goes back to the start", () => {
  // Newest first, like the API.
  const list = [
    checkin("2026-10-20", [v("waist", "33.25"), v("arms", "15", "in", "left")]),
    checkin("2026-10-10", [v("arms", "14.75", "in", "left")]), // waist skipped
    checkin("2026-10-01", [v("waist", "34"), v("arms", "14.5", "in", "left")]),
  ];
  const waist = siteTrend(list, "waist", null, "in")!;
  assert.equal(waist.latest.date, "2026-10-20");
  assert.equal(waist.previous!.date, "2026-10-01");
  assert.equal(waist.sincePrevious, -0.75);
  assert.equal(waist.sinceFirst, -0.75);
  const arm = siteTrend(list, "arms", "left", "in")!;
  assert.equal(arm.previous!.date, "2026-10-10");
  assert.equal(arm.sincePrevious, 0.25);
  assert.equal(arm.sinceFirst, 0.5);
  assert.equal(siteTrend(list, "arms", "right", "in"), null);
  // The latest check-in that skipped waist leaves waist's latest where it was.
  const skipped = [checkin("2026-10-25", [v("arms", "15.25", "in", "left")]), ...list];
  assert.equal(siteTrend(skipped, "waist", null, "in")!.latest.date, "2026-10-20");
  // One value: nothing to compare.
  const one = siteTrend([checkin("2026-10-01", [v("neck", "15")])], "neck", null, "in")!;
  assert.equal(one.sincePrevious, null);
  assert.equal(one.sinceFirst, null);
});

test("changes are exact in the entered unit and converted otherwise", () => {
  const list = [checkin("2026-10-02", [v("waist", "33.33")]), checkin("2026-10-01", [v("waist", "33.1")])];
  assert.equal(siteTrend(list, "waist", null, "in")!.sincePrevious, 0.23);
  assert.equal(siteTrend(list, "waist", null, "cm")!.sincePrevious, 0.6); // 0.5842 cm
  assert.equal(changeText(0.23, "in"), "+0.23 in");
  assert.equal(changeText(-1.5, "cm"), "-1.5 cm");
  assert.equal(changeText(0, "in"), "No change");
});

test("a value shows exactly as entered in its own unit, and switching back never drifts", () => {
  const x = v("waist", "32.25");
  assert.equal(x.value_cm, "81.915");
  assert.equal(valueText(x, "cm"), "81.9 cm");
  assert.equal(valueText(x, "in"), "32.25 in");
  assert.equal(inUnit(x, "in"), 32.25);
  assert.equal(valueText(v("neck", "38.1", "cm"), "in"), "15 in");
});

test("body fat changes only between the same method", () => {
  const smart = [checkin("2026-10-10", [], ["19.5", "smart_scale"]), checkin("2026-10-01", [], ["20.25", "smart_scale"])];
  const t = fatTrend(smart)!;
  assert.equal(t.sincePrevious, -0.75);
  assert.equal(t.sinceFirst, -0.75);
  // Calipers after smart scale: no change figure, either way.
  const mixed = fatTrend([checkin("2026-10-20", [], ["15", "calipers"]), ...smart])!;
  assert.equal(mixed.latest.method, "calipers");
  assert.equal(mixed.sincePrevious, null);
  assert.equal(mixed.sinceFirst, null);
  // Back on the scale: compares with the last reading only when it's the same method.
  const back = fatTrend([checkin("2026-10-30", [], ["19", "smart_scale"]), checkin("2026-10-20", [v("waist", "33")], ["15", "calipers"]), ...smart])!;
  assert.equal(back.sincePrevious, null);
  assert.equal(back.sinceFirst, -1.25);
  // Check-ins without body fat don't count.
  assert.equal(fatTrend([checkin("2026-10-01", [v("waist", "33")])]), null);
});
