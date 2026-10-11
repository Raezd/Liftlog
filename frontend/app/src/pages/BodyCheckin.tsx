import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, Card, ErrorText, Loading, Page, SelectField } from "../components/ui";
import { FAT_INPUT, METHODS, VALUE_INPUT, fatProblem, valueProblem } from "../lib/body";
import { longDate } from "../lib/format";
import { useBody, useBodyChange, useMe } from "../lib/queries";
import { workoutDate } from "../lib/stats";
import type { Body, BodyCheckin, BodyFatMethod, BodySite, LengthUnit, Side } from "../lib/types";
import { useOnline } from "../lib/useOnline";
import { NEEDS_CONNECTION, SIDE_NAME, sidesOf } from "./Body";

type Form = {
  date: string;
  /** site id + side -> the typed value, and the unit it's in. */
  values: Record<string, string>;
  units: Record<string, LengthUnit>;
  fat: string;
  method: BodyFatMethod | "";
  notes: string;
};

const keyOf = (siteId: string, side: Side | null) => `${siteId}:${side ?? ""}`;

function fromCheckin(c: BodyCheckin): Form {
  const values: Record<string, string> = {}, units: Record<string, LengthUnit> = {};
  for (const v of c.values) {
    values[keyOf(v.site_id, v.side)] = v.value;
    units[keyOf(v.site_id, v.side)] = v.unit;
  }
  return { date: c.date, values, units, fat: c.body_fat_pct ?? "", method: c.body_fat_method ?? "", notes: c.notes };
}

/** Adding a check-in (/body/checkins/new) or changing one. One per date: picking a date that has one opens it. */
export default function BodyCheckinPage() {
  const { id = "new" } = useParams();
  const body = useBody();
  const me = useMe();
  const b = body.data;
  const existing = b?.checkins.find((c) => c.id === id);
  const ready = b && me.data && (id === "new" || existing);
  const today = me.data ? workoutDate(new Date().toISOString(), me.data.timezone) : "";
  // Adding when today already has a check-in opens that one.
  const todays = id === "new" ? b?.checkins.find((c) => c.date === today) : undefined;
  return (
    <Page title={id === "new" && !todays ? "Add a check-in" : "Check-in"} back="/body">
      {(body.isPending || me.isPending) && <Loading />}
      <ErrorText error={body.error ?? me.error} />
      {b && id !== "new" && !existing && <p className="text-muted">This check-in isn't here anymore.</p>}
      {ready && <Editor key={id} body={b} start={existing ?? todays ?? null} opened={!!todays} today={today} />}
    </Page>
  );
}

function Editor({ body, start, opened: openedAtStart, today }: { body: Body; start: BodyCheckin | null; opened: boolean; today: string }) {
  const online = useOnline();
  const navigate = useNavigate();
  const change = useBodyChange();
  const unit = body.length_unit;
  const [editing, setEditing] = useState<BodyCheckin | null>(start);
  const [form, setForm] = useState<Form>(() => (start ? fromCheckin(start) : { date: today, values: {}, units: {}, fat: "", method: "", notes: "" }));
  const [opened, setOpened] = useState(openedAtStart);
  const [confirming, setConfirming] = useState(false);
  const set = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  const onDate = (date: string) => {
    const there = body.checkins.find((c) => c.date === date);
    if (!editing && there) {
      // Adding on a date that has a check-in opens it. Anything typed here goes on top, like entering a site again.
      const f = fromCheckin(there);
      for (const [k, v] of Object.entries(form.values)) if (v.trim()) { f.values[k] = v; f.units[k] = form.units[k] ?? unit; }
      if (form.fat.trim()) { f.fat = form.fat; f.method = form.method; }
      if (form.notes.trim()) f.notes = form.notes;
      setEditing(there);
      setForm(f);
      setOpened(true);
      return;
    }
    setOpened(false);
    set({ date });
  };

  const unitOf = (k: string) => form.units[k] ?? unit;
  const setValue = (k: string, v: string) => {
    if (!VALUE_INPUT.test(v.trim())) return;
    // A cleared field goes back to the display unit.
    setForm((f) => ({ ...f, values: { ...f.values, [k]: v.trim() }, units: { ...f.units, [k]: v.trim() ? f.units[k] ?? unit : unit } }));
  };

  // Active sites, plus archived ones this check-in already has values for.
  const inForm = new Set(Object.entries(form.values).filter(([, v]) => v).map(([k]) => k.split(":")[0]));
  const sites = body.sites.filter((s) => !s.archived || inForm.has(s.id));
  const label = (s: BodySite, side: Side | null) => (side ? `${s.name}, ${side}` : s.name);

  const problems = [
    ...sites.flatMap((s) => sidesOf(s).map((side) => valueProblem(label(s, side), form.values[keyOf(s.id, side)] ?? "", unitOf(keyOf(s.id, side))))),
    fatProblem(form.fat, form.method),
    form.date > today ? "A check-in can't be in the future." : null,
    !form.date ? "Pick a date." : null,
    body.checkins.some((c) => c.date === form.date && c.id !== editing?.id) ? "There's already a check-in on that date. Open it from the Body tab to add to it." : null,
  ].filter((p): p is string => p !== null);
  const values = sites.flatMap((s) => sidesOf(s).flatMap((side) => {
    const k = keyOf(s.id, side), v = (form.values[k] ?? "").trim();
    return v ? [{ site_id: s.id, side, value: v, unit: unitOf(k) }] : [];
  }));
  const empty = values.length === 0 && !form.fat.trim();

  const save = () => {
    const payload = { date: form.date, values, body_fat_pct: form.fat.trim() || null, body_fat_method: form.method || null, notes: form.notes };
    void change.mutateAsync(editing ? { method: "PUT", path: `/checkins/${editing.id}`, body: payload } : { method: "POST", path: "/checkins", body: payload })
      .then(() => navigate("/body"), () => {});
  };
  const remove = () => {
    if (editing) void change.mutateAsync({ method: "DELETE", path: `/checkins/${editing.id}` }).then(() => navigate("/body"), () => {});
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (online && !problems.length && !empty) save(); }}>
      {!online && <p role="status" className="mb-3 rounded-2xl bg-sunken p-3 font-bold">{NEEDS_CONNECTION}</p>}
      <label className="mb-3 block">
        <span className="font-bold">Date</span>
        <input type="date" required max={today} value={form.date} onChange={(e) => onDate(e.target.value)}
          className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-ground px-3 text-ink" />
      </label>
      {opened && <p role="status" className="-mt-1 mb-3 text-sm font-bold text-accent-text">You already had a check-in on {longDate(form.date)}, so it's open here.</p>}

      <Card title="Measurements">
        <p className="-mt-2 mb-3 text-sm text-muted">Fill in what you measured. Leave the rest empty.</p>
        {sites.map((s) => (
          <fieldset key={s.id} className="mb-3">
            <legend className="font-bold">{s.name}{s.archived && <span className="font-normal text-muted"> (archived)</span>}</legend>
            <div className={`mt-1 grid gap-2 ${s.paired ? "grid-cols-2" : "grid-cols-1"}`}>
              {sidesOf(s).map((side) => {
                const k = keyOf(s.id, side);
                return (
                  <label key={k} className="flex min-w-0 items-center gap-2">
                    {side && <span className="w-10 shrink-0 text-sm text-muted">{SIDE_NAME[side]}</span>}
                    <span className="sr-only">{label(s, side)} in {unitOf(k) === "in" ? "inches" : "centimeters"}</span>
                    <input inputMode="decimal" value={form.values[k] ?? ""} onChange={(e) => setValue(k, e.target.value)}
                      className="num block min-h-11 w-full min-w-0 rounded-xl border border-line bg-ground px-3 text-lg" />
                    <span className="shrink-0 text-muted" aria-hidden>{unitOf(k)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </Card>

      <Card title="Body fat">
        <label className="mb-3 block">
          <span className="font-bold">Body fat (%)</span>
          <span className="block text-sm text-muted">Optional. 1 to 75.</span>
          <input inputMode="decimal" value={form.fat} onChange={(e) => { if (FAT_INPUT.test(e.target.value.trim())) set({ fat: e.target.value.trim() }); }}
            className="num mt-1 block min-h-11 w-full rounded-xl border border-line bg-ground px-3 text-lg" />
        </label>
        <SelectField label="Method" value={form.method} onChange={(e) => set({ method: e.target.value as BodyFatMethod | "" })}
          options={[["", form.fat.trim() ? "Pick a method" : "None"], ...Object.entries(METHODS) as [string, string][]]} />
      </Card>

      <label className="mb-3 block">
        <span className="font-bold">Notes</span>
        <textarea value={form.notes} maxLength={2000} rows={form.notes ? 3 : 2} onChange={(e) => set({ notes: e.target.value })}
          className="mt-1 block w-full rounded-xl border border-line bg-ground px-3 py-2" />
      </label>

      {problems.length > 0 && (
        <ul role="alert" className="mb-3 space-y-1 font-bold text-over">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      <ErrorText error={change.error} />
      <Button variant="primary" type="submit" className="w-full" disabled={!online || change.isPending || problems.length > 0 || empty}>Save</Button>
      {empty && !problems.length && <p className="mt-1 text-sm text-muted">Enter at least one measurement or body fat to save.</p>}
      {editing && (
        <Button className="mt-2 w-full text-over" disabled={!online || change.isPending} onClick={() => (confirming ? remove() : setConfirming(true))}>
          {confirming ? "Tap again to delete" : "Delete this check-in"}
        </Button>
      )}
    </form>
  );
}
