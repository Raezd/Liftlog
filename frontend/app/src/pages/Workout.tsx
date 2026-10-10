import { Capacitor } from "@capacitor/core";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Disc, Minus, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ExerciseOrder } from "../components/ExerciseOrder";
import { PlateSheet } from "../components/PlateSheet";
import { Sheet } from "../components/Sheet";
import { Badge, Button, ErrorText, Loading, Page, btn } from "../components/ui";
import { currentActive, discard, update, useActive } from "../lib/active";
import { get } from "../lib/api";
import { LOGGING, SET_TYPE, SET_TYPE_SHORT, duration, plural } from "../lib/format";
import { cached, useOffline } from "../lib/offline";
import { gearFor } from "../lib/plates";
import type { PastSet } from "../lib/prefill";
import { groupOf, removeExercise, supersetLetters, units } from "../lib/reorder";
import {
  FIELDS, MAX_REST, REST_STEP, RPE_VALUES, addedExercise, canLink, history, lastSession, linkWithNext, nextSet,
  restAfter, restFor, setProblem, upNext, type ActiveExercise, type ActiveSet, type ActiveWorkout, type HistWorkout,
} from "../lib/session";
import type { Exercise, LoggingType, Me, SetType, WeightUnit } from "../lib/types";
import { formatVolume, volume } from "../lib/volume";
import { rememberAlertSetting } from "../timer/alertSetting";
import { ensureNotificationPermission, RestAlarm, type NativeStatus } from "../timer/restAlarm";
import { afterChange, shiftRest, stopRest, useRestAlarm, withRest } from "../timer/useRest";

export const isNative = () => Capacitor.isNativePlatform();

type Units = Pick<Me, "weight_unit" | "distance_unit">;
const DEFAULT_UNITS: Units = { weight_unit: "lb", distance_unit: "mi" };

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Shown on the web build and when nothing is in progress. */
export function NoWorkout({ web }: { web?: boolean }) {
  return (
    <div className="mx-auto max-w-md px-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <Page title="Workout" back="/">
        <p className="mb-4">{web ? "Workouts run in the Android app." : "No workout in progress."}</p>
        <Link to="/" className={btn.primary}>Go to routines</Link>
      </Page>
    </div>
  );
}

/** The live workout: one card per exercise (a superset is one card), with Overview for the full list. */
export default function Workout() {
  const { loaded, workout: w, problem } = useActive();
  const off = useOffline();
  const [overview, setOverview] = useState(false);
  const now = useNow();
  useRestAlarm(w?.rest ?? null);
  useEffect(() => {
    if (off.copy) rememberAlertSetting(off.copy.me.play_through_silent);
  }, [off.copy]);
  const hist = useMemo(() => history(off.copy?.workouts ?? [], off.queue), [off.copy, off.queue]);
  const unitsOf = off.copy?.me ?? DEFAULT_UNITS;

  if (!isNative()) return <NoWorkout web />;
  if (!loaded) return <div className="p-4"><Loading /></div>;
  if (!w) return <NoWorkout />;

  const us = units(w.exercises);
  let at = us.findIndex((u) => u.some((e) => e.key === w.currentKey));
  if (at < 0) at = 0;
  const go = (u: number) => void update((x) => ({ ...x, currentKey: units(x.exercises)[u]?.[0].key ?? null }));
  const elapsed = duration(Math.max(0, Math.floor((now - Date.parse(w.started_at)) / 1000)));

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <header className="flex items-center gap-2 pb-2">
        <div className="min-w-0 flex-1">
          <h1 className="display truncate text-xl font-bold text-accent-text">{w.title}</h1>
          <p className="num text-sm text-muted"><span className="sr-only">Time so far </span>{elapsed}</p>
        </div>
        <Button aria-pressed={overview} variant={overview ? "primary" : "secondary"} onClick={() => setOverview(!overview)}>
          {overview ? "Back" : "Overview"}
        </Button>
        <Link to="/workout/finish" className={btn.primary}>Finish</Link>
      </header>
      <Permissions />
      {problem && <p role="alert" className="mb-2 font-bold text-over">{problem}</p>}

      <main className="min-h-0 flex-1 overflow-y-auto pb-3">
        {overview ? (
          <Overview w={w} hist={hist} units={unitsOf} onJump={(key) => { void update((x) => ({ ...x, currentKey: key })); setOverview(false); }} />
        ) : us.length === 0 ? (
          <EmptyCard hist={hist} units={unitsOf} w={w} />
        ) : (
          <UnitCard key={us[at][0].key} w={w} unit={us[at]} hist={hist} units={unitsOf} letter={supersetLetters(w.exercises)[w.exercises.indexOf(us[at][0])]} />
        )}
      </main>

      {w.rest && <RestBar w={w} now={now} />}
      {!overview && us.length > 0 && (
        <nav aria-label="Exercises" className="flex items-center gap-2 border-t border-line py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <Button disabled={at === 0} onClick={() => go(at - 1)} className="flex-1">
            <ChevronLeft size={20} aria-hidden /> Previous
          </Button>
          <span className="num shrink-0 text-sm text-muted">{at + 1} of {us.length}</span>
          <Button variant="primary" disabled={at >= us.length - 1} onClick={() => go(at + 1)} className="flex-1">
            Next exercise <ChevronRight size={20} aria-hidden />
          </Button>
        </nav>
      )}
    </div>
  );
}

function EmptyCard({ w, hist, units: u }: { w: ActiveWorkout; hist: HistWorkout[]; units: Units }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <p className="mb-3">No exercises yet.</p>
      <Button variant="primary" className="w-full" onClick={() => setAdding(true)}><Plus size={20} aria-hidden /> Add exercises</Button>
      <AddExercises open={adding} onClose={() => setAdding(false)} w={w} hist={hist} units={u} />
    </section>
  );
}

// ---------- the card ----------

const idx = (w: ActiveWorkout, key: string) => w.exercises.findIndex((e) => e.key === key);

function setSet(key: string, setId: string, patch: Partial<ActiveSet>, instant = false) {
  return update((x) => ({
    ...x,
    exercises: x.exercises.map((e) => (e.key !== key ? e : { ...e, sets: e.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) })),
  }), { instant });
}

/** Leaves a plate out of plate math for the rest of this workout, or puts it back. */
function excludePlate(plateId: string, out: boolean) {
  return update((x) => {
    const rest = (x.excluded_plates ?? []).filter((id) => id !== plateId);
    return { ...x, excluded_plates: out ? [...rest, plateId] : rest };
  });
}

function setSets(key: string, fn: (sets: ActiveSet[]) => ActiveSet[]) {
  return update((x) => ({ ...x, exercises: x.exercises.map((e) => (e.key === key ? { ...e, sets: fn(e.sets) } : e)) }));
}

/** Completes or un-completes a set. Completing starts the rest when it's due; un-completing ends any rest. */
async function toggleDone(key: string, setId: string): Promise<string | null> {
  const w = currentActive();
  if (!w) return null;
  const i = idx(w, key);
  const e = w.exercises[i];
  const k = e.sets.findIndex((s) => s.id === setId);
  const s = e.sets[k];
  const before = w.rest;
  if (!s.done) {
    const problem = setProblem(s, FIELDS[e.logging_type]);
    if (problem) return problem;
  }
  let next: ActiveWorkout = {
    ...w,
    exercises: w.exercises.map((x, j) => (j !== i ? x : {
      ...x, sets: x.sets.map((y) => (y.id !== setId ? y : { ...y, done: !s.done, completed_at: s.done ? null : new Date().toISOString() })),
    })),
  };
  if (s.done) next = { ...next, rest: null };
  else {
    const r = restAfter(next.exercises, i, k);
    if (r) {
      const g = groupOf(next.exercises, i);
      const label = g ? `Next round: ${next.exercises.slice(g[0], g[1] + 1).map((x) => x.name).join(", ")}` : `Next: ${e.name}`;
      next = withRest(next, r.seconds, r.key, label);
    }
  }
  await update(() => next);
  await afterChange(before, currentActive()?.rest ?? null);
  return null;
}

/** Plus or minus 15 seconds on an exercise's rest (a superset's rest after each round), this workout only. */
async function adjustRest(key: string, delta: number) {
  const w = currentActive();
  if (!w) return;
  const r = restFor(w.exercises, idx(w, key));
  const clamp = (v: number) => Math.max(0, Math.min(MAX_REST, v + delta));
  await update((x) => {
    const i = idx(x, r.key);
    const g = groupOf(x.exercises, i);
    return {
      ...x,
      exercises: x.exercises.map((e, j) => (j !== i ? e : g ? { ...e, supersetRest: clamp(e.supersetRest ?? e.rest) } : { ...e, rest: clamp(e.rest) })),
    };
  });
  if (w.rest?.key === r.key) await shiftRest(delta);
}

function UnitCard({ w, unit, hist, units: u, letter }: { w: ActiveWorkout; unit: ActiveExercise[]; hist: HistWorkout[]; units: Units; letter: string | null }) {
  const next = upNext(unit);
  const nextId = next ? unit.find((e) => e.key === next.key)!.sets[next.set].id : null;
  // In a superset, completing a set moves "up next" to the next exercise in the group.
  useEffect(() => {
    if (nextId) document.getElementById(`set-${nextId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [nextId]);
  const group = unit.length > 1;
  return (
    <section aria-label={group ? `Superset ${letter}` : unit[0].name} className={`rounded-2xl border bg-surface p-3 ${group ? "border-l-4 border-accent-strong border-y-line border-r-line" : "border-line"}`}>
      {group && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="display text-lg font-bold text-accent-text">Superset {letter}</h2>
          <RestControl label="Rest after each round" seconds={restFor(w.exercises, idx(w, unit[0].key)).seconds} onAdjust={(d) => void adjustRest(unit[0].key, d)} />
        </div>
      )}
      <div className={group ? "space-y-4 divide-y divide-line" : ""}>
        {unit.map((e) => (
          <ExerciseBlock key={e.key} e={e} hist={hist} units={u} compact={group} nextId={nextId}
            rest={group ? null : <RestControl label="Rest" seconds={e.rest} onAdjust={(d) => void adjustRest(e.key, d)} />} />
        ))}
      </div>
    </section>
  );
}

function RestControl({ label, seconds, onAdjust }: { label: string; seconds: number; onAdjust: (delta: number) => void }) {
  const b = "inline-flex size-11 items-center justify-center rounded-xl border border-line bg-sunken disabled:opacity-40";
  return (
    <div className="flex items-center gap-1">
      <span className="text-sm text-muted">{label} <span className="num font-bold text-ink">{seconds ? duration(seconds) : "off"}</span></span>
      <button type="button" className={b} disabled={seconds <= 0} onClick={() => onAdjust(-REST_STEP)}>
        <Minus size={18} aria-hidden /><span className="sr-only">15 seconds less rest</span>
      </button>
      <button type="button" className={b} disabled={seconds >= MAX_REST} onClick={() => onAdjust(REST_STEP)}>
        <Plus size={18} aria-hidden /><span className="sr-only">15 seconds more rest</span>
      </button>
    </div>
  );
}

/** "185 x 5", or with the unit, "185 lb x 5". Warm-ups, drops, and failures get their letter. */
function pastText(s: PastSet, unit = false): string {
  const parts: string[] = [];
  if (s.weight_value !== null) parts.push(unit ? `${s.weight_value} ${s.weight_unit}` : s.weight_value);
  if (s.reps !== null) parts.push(s.weight_value !== null ? `x ${s.reps}` : `${s.reps} reps`);
  if (s.distance_value !== null) parts.push(`${s.distance_value} ${s.distance_unit}`);
  if (s.duration_seconds !== null) parts.push(duration(s.duration_seconds));
  const letter = SET_TYPE_SHORT[s.set_type];
  return `${letter ? `${letter} ` : ""}${parts.join(" ") || "no data"}`;
}

const KG_PER_LB = 0.45359237;
const kg = (s: PastSet) => (s.weight_value === null ? -1 : Number(s.weight_value) * (s.weight_unit === "lb" ? KG_PER_LB : 1));

/** Last session's sets for this exercise, its top set, and its volume. */
function LastSession({ hist, exerciseId, logging, unit }: { hist: HistWorkout[]; exerciseId: string; logging: LoggingType; unit: WeightUnit }) {
  const last = useMemo(() => lastSession(hist, exerciseId), [hist, exerciseId]);
  if (!last) return <p className="mt-1 text-sm text-muted">No earlier sessions.</p>;
  const work = last.sets.filter((s) => s.set_type !== "warmup");
  const top = work.slice().sort((a, b) => kg(b) - kg(a) || (b.reps ?? 0) - (a.reps ?? 0) || (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0))[0];
  const vol = volume([{ logging_type: logging, sets: last.sets }], unit);
  const when = new Date(last.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="mt-1 rounded-xl bg-sunken px-3 py-2 text-sm">
      <p className="num"><span className="font-bold">Last time, {when}:</span> {last.sets.map((s) => pastText(s)).join(", ")}</p>
      {(top || vol !== null) && (
        <p className="num text-muted">
          {[top && `Top set ${pastText(top, true)}`, vol !== null && `volume ${formatVolume(vol, unit)}`].filter(Boolean).join(", ")}
        </p>
      )}
    </div>
  );
}

function ExerciseBlock({ e, hist, units: u, compact, nextId, rest }: {
  e: ActiveExercise; hist: HistWorkout[]; units: Units; compact: boolean; nextId: string | null; rest: ReactNode;
}) {
  const f = FIELDS[e.logging_type];
  const [menu, setMenu] = useState<string | null>(null);
  const [rpeOpen, setRpeOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const [platesFor, setPlatesFor] = useState<string | null>(null);
  const menuSet = e.sets.find((s) => s.id === menu);
  const { copy } = useOffline();
  const excluded = useActive().workout?.excluded_plates ?? [];
  // The exercise's current plate math settings, from the copy on this phone.
  const info = copy?.exercises.find((x) => x.id === e.exercise_id);
  const plateMath = !!f.weight && (info ? info.plate_math : e.equipment === "barbell");
  const gear = copy?.gear ? gearFor(copy.gear, info ?? { bar_id: null, plate_set_id: null }) : null;
  const plateSet = e.sets.find((s) => s.id === platesFor);
  const cols = [f.weight, f.reps && "Reps", f.distance && "Distance", f.duration && "Time"].filter(Boolean) as string[];

  return (
    <div className={compact ? "pt-3 first:pt-0" : ""}>
      <h2 className={`display font-bold leading-tight ${compact ? "text-lg" : "text-2xl"}`}>{e.name}</h2>
      <p className="text-sm text-muted">{LOGGING[e.logging_type]}</p>
      {e.notes && <p className="mt-1 whitespace-pre-line text-sm">{e.notes}</p>}
      <LastSession hist={hist} exerciseId={e.exercise_id} logging={e.logging_type} unit={u.weight_unit} />

      <div aria-hidden className="mt-3 flex gap-1 px-1 text-xs font-bold uppercase text-muted">
        <span className="w-11 shrink-0 text-center">Set</span>
        {cols.map((c) => <span key={c} className="min-w-0 flex-1 text-center">{c === f.weight ? `${c} (${u.weight_unit})` : c}</span>)}
        {f.rpe && <span className="w-12 shrink-0 text-center">RPE</span>}
        <span className="w-12 shrink-0 text-center">Done</span>
      </div>
      <ol className="mt-1 space-y-1">
        {e.sets.map((s, k) => (
          <SetRow key={s.id} e={e} s={s} n={k + 1} up={s.id === nextId}
            rpeOpen={rpeOpen === s.id} onRpe={() => setRpeOpen(rpeOpen === s.id ? null : s.id)}
            onMenu={() => setMenu(s.id)} problem={problem?.id === s.id ? problem.text : null}
            onPlates={plateMath ? () => setPlatesFor(s.id) : undefined}
            onDone={async () => {
              const p = await toggleDone(e.key, s.id);
              setProblem(p ? { id: s.id, text: p } : null);
            }} />
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Button variant="quiet" onClick={() => void setSets(e.key, (sets) => [...sets, nextSet(e, u)])}>
          <Plus size={18} aria-hidden /> Add set<span className="sr-only"> to {e.name}</span>
        </Button>
        {rest}
      </div>

      <PlateSheet open={plateSet !== undefined} onClose={() => setPlatesFor(null)}
        value={plateSet?.weight ?? ""} unit={plateSet?.weight_unit ?? u.weight_unit}
        bar={gear?.bar} plateSet={gear?.plateSet} excluded={excluded}
        onExclude={(id, out) => void excludePlate(id, out)}
        onUse={(total) => plateSet && void setSet(e.key, plateSet.id, { weight: total })} />

      <Sheet open={menuSet !== undefined} title={menuSet ? `Set ${e.sets.indexOf(menuSet) + 1}` : ""} onClose={() => setMenu(null)}>
        {menuSet && (
          <>
            <fieldset className="mb-4">
              <legend className="mb-1 font-bold">Set type</legend>
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(SET_TYPE) as [SetType, string][]).map(([v, l]) => (
                  <label key={v} className="flex">
                    <input type="radio" name="set-type" className="peer sr-only" checked={menuSet.set_type === v}
                      onChange={() => { void setSet(e.key, menuSet.id, { set_type: v }); setMenu(null); }} />
                    <span className="flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl border border-line bg-sunken px-3 peer-checked:border-accent-strong peer-checked:bg-accent-strong peer-checked:font-bold peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-text">{l}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-sm text-muted">Warm-ups never count toward volume.</p>
            </fieldset>
            <Button className="w-full text-over" onClick={async () => {
              const id = menuSet.id;
              setMenu(null);
              if (menuSet.done && currentActive()?.rest) await stopRest();
              await setSets(e.key, (sets) => sets.filter((x) => x.id !== id));
            }}>
              <Trash2 size={18} aria-hidden /> Remove set
            </Button>
          </>
        )}
      </Sheet>
    </div>
  );
}

function NumField({ label, value, onChange, mode, placeholder, disabled }: {
  label: string; value: string; onChange: (v: string) => void; mode: "decimal" | "numeric" | "text"; placeholder?: string; disabled?: boolean;
}) {
  return (
    <label className="min-w-0 flex-1">
      <span className="sr-only">{label}</span>
      <input inputMode={mode} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        className="num block min-h-12 w-full min-w-0 rounded-xl border border-line bg-ground px-2 text-center text-lg disabled:opacity-70" />
    </label>
  );
}

function SetRow({ e, s, n, up, rpeOpen, onRpe, onMenu, onDone, onPlates, problem }: {
  e: ActiveExercise; s: ActiveSet; n: number; up: boolean; rpeOpen: boolean;
  onRpe: () => void; onMenu: () => void; onDone: () => void; onPlates?: () => void; problem: string | null;
}) {
  const f = FIELDS[e.logging_type];
  const field = (patch: Partial<ActiveSet>) => void setSet(e.key, s.id, patch, true);
  const name = `${e.name} set ${n}`;
  return (
    <li id={`set-${s.id}`} aria-label={`Set ${n}${s.done ? ", done" : ""}`}
      className={`rounded-xl border-2 p-1 ${up ? "border-accent-text" : "border-transparent"} ${s.done ? "bg-sunken" : ""}`}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={onMenu} className="num inline-flex min-h-12 w-11 shrink-0 items-center justify-center rounded-xl font-bold text-accent-text hover:bg-sunken">
          <span aria-hidden>{SET_TYPE_SHORT[s.set_type] || n}</span>
          <span className="sr-only">Set {n}, {SET_TYPE[s.set_type]}. Change type or remove</span>
        </button>
        {f.weight && (onPlates ? (
          <div className="flex min-w-0 flex-1 gap-1">
            <NumField label={`${name} ${f.weight.toLowerCase()}, ${s.weight_unit}`} mode="decimal" value={s.weight} onChange={(v) => field({ weight: v })} />
            <button type="button" onClick={onPlates}
              className="inline-flex min-h-12 w-11 shrink-0 items-center justify-center rounded-xl border border-line bg-sunken text-accent-text">
              <Disc size={20} aria-hidden /><span className="sr-only">Plates for {name}</span>
            </button>
          </div>
        ) : (
          <NumField label={`${name} ${f.weight.toLowerCase()}, ${s.weight_unit}`} mode="decimal" value={s.weight} onChange={(v) => field({ weight: v })} />
        ))}
        {f.reps && <NumField label={`${name} reps`} mode="numeric" value={s.reps} placeholder={s.hint ?? undefined} onChange={(v) => field({ reps: v })} />}
        {f.distance && <NumField label={`${name} distance, ${s.distance_unit}`} mode="decimal" value={s.distance} onChange={(v) => field({ distance: v })} />}
        {f.duration && <NumField label={`${name} time`} mode="text" placeholder="m:ss" value={s.duration} onChange={(v) => field({ duration: v })} />}
        {f.rpe && (
          <button type="button" aria-expanded={rpeOpen} onClick={onRpe}
            className={`num inline-flex min-h-12 w-12 shrink-0 items-center justify-center rounded-xl text-sm ${s.rpe ? "font-bold" : "text-muted"} hover:bg-sunken`}>
            {s.rpe ?? "RPE"}<span className="sr-only"> for {name}</span>
          </button>
        )}
        <button type="button" aria-pressed={s.done} onClick={onDone}
          className={`inline-flex min-h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${s.done ? "border-accent-strong bg-accent-strong text-white" : "border-line bg-ground text-muted"}`}>
          <Check size={22} aria-hidden /><span className="sr-only">{s.done ? `Mark ${name} not done` : `Complete ${name}`}</span>
        </button>
      </div>
      {s.hint && f.reps && <p className="pl-12 text-xs text-muted">Target {s.hint} reps</p>}
      {rpeOpen && (
        <div role="group" aria-label={`RPE for ${name}`} className="mt-1 flex flex-wrap gap-1 pl-12">
          {RPE_VALUES.map((v) => (
            <button key={v} type="button" aria-pressed={s.rpe === v} onClick={() => { void setSet(e.key, s.id, { rpe: s.rpe === v ? null : v }); onRpe(); }}
              className={`num min-h-11 min-w-11 rounded-xl border px-2 ${s.rpe === v ? "border-accent-strong bg-accent-strong font-bold text-white" : "border-line bg-sunken"}`}>
              {v}
            </button>
          ))}
        </div>
      )}
      {problem && <p role="alert" className="pl-12 text-sm font-bold text-over">{problem}</p>}
    </li>
  );
}

function RestBar({ w, now }: { w: ActiveWorkout; now: number }) {
  const r = w.rest!;
  const left = Math.max(0, Math.ceil((r.endsAt - now) / 1000));
  return (
    <section aria-label="Rest timer" className="mb-1 flex items-center gap-2 rounded-2xl border border-accent-strong bg-surface p-2">
      <div className="min-w-0 flex-1 pl-1">
        <p className="num display text-3xl font-extrabold" aria-live="off">{duration(left)}</p>
        <p className="truncate text-sm text-muted">{r.label}</p>
      </div>
      <button type="button" onClick={() => void shiftRest(-REST_STEP)} className="inline-flex size-12 items-center justify-center rounded-xl border border-line bg-sunken font-bold">
        <span aria-hidden>-15</span><span className="sr-only">15 seconds less</span>
      </button>
      <button type="button" onClick={() => void shiftRest(REST_STEP)} className="inline-flex size-12 items-center justify-center rounded-xl border border-line bg-sunken font-bold">
        <span aria-hidden>+15</span><span className="sr-only">15 seconds more</span>
      </button>
      <Button onClick={() => void stopRest()}>Skip</Button>
    </section>
  );
}

// ---------- overview ----------

function Overview({ w, hist, units: u, onJump }: { w: ActiveWorkout; hist: HistWorkout[]; units: Units; onJump: (key: string) => void }) {
  const navigate = useNavigate();
  const [reorder, setReorder] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ActiveExercise | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const exs = w.exercises;
  const letters = supersetLetters(exs);

  const remove = (key: string) => update((x) => {
    const i = idx(x, key);
    const next = removeExercise(x.exercises, i);
    let currentKey = x.currentKey;
    if (currentKey === key) currentKey = next[Math.min(i, next.length - 1)]?.key ?? null;
    return { ...x, exercises: next, currentKey };
  });

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="display text-xl font-bold">Overview</h2>
        {exs.length > 1 && (
          <Button aria-pressed={reorder} variant={reorder ? "primary" : "secondary"} onClick={() => setReorder(!reorder)}>
            {reorder ? "Done" : "Reorder"}
          </Button>
        )}
      </div>
      {exs.length === 0 && <p className="mb-3 text-muted">No exercises yet.</p>}
      {reorder ? (
        <>
          <p className="mb-3 text-sm text-muted">Drag the handles, or use the arrows. Moving an exercise past either end of its superset takes it out.</p>
          <ExerciseOrder items={exs} onChange={(next) => void update((x) => ({ ...x, exercises: next }))} />
        </>
      ) : (
        <ol className="space-y-2">
          {exs.map((e, i) => {
            const done = e.sets.filter((s) => s.done).length;
            const g = groupOf(exs, i);
            return (
              <li key={e.key} className={`rounded-2xl border bg-surface ${g ? "border-l-4 border-accent-strong border-y-line border-r-line" : "border-line"}`}>
                <div className="flex items-center gap-1 pr-1">
                  <button type="button" onClick={() => onJump(e.key)} className="min-w-0 flex-1 rounded-l-2xl px-3 py-2 text-left hover:bg-sunken">
                    <span className="block font-bold">{e.name}</span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      {done} of {plural(e.sets.length, "set")} done
                      {letters[i] && <Badge>Superset {letters[i]}</Badge>}
                    </span>
                  </button>
                  <button type="button" onClick={() => (done ? setRemoving(e) : void remove(e.key))}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-sunken">
                    <Trash2 size={18} aria-hidden /><span className="sr-only">Remove {e.name}</span>
                  </button>
                </div>
                {i < exs.length - 1 && (e.linkNext || canLink(exs, i)) && (
                  <label className="flex min-h-11 items-center gap-3 border-t border-line px-3">
                    <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={e.linkNext}
                      onChange={(x) => void update((y) => ({ ...y, exercises: linkWithNext(y.exercises, idx(y, e.key), x.target.checked) }))} />
                    <span className="text-sm">Superset with the next exercise</span>
                  </label>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!reorder && (
        <>
          <Button className="mt-3 w-full" onClick={() => setAdding(true)}><Plus size={20} aria-hidden /> Add exercises</Button>
          <Button className="mt-6 w-full text-over" onClick={() => setDiscarding(true)}>Discard workout</Button>
        </>
      )}
      <AddExercises open={adding} onClose={() => setAdding(false)} w={w} hist={hist} units={u} />

      <Sheet open={removing !== null} title={removing ? `Remove ${removing.name}?` : ""} onClose={() => setRemoving(null)}>
        {removing && (
          <>
            <p className="mb-4">Its {plural(removing.sets.filter((s) => s.done).length, "done set")} won't be saved.</p>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setRemoving(null)}>Keep</Button>
              <Button variant="primary" onClick={() => { void remove(removing.key); setRemoving(null); }}>Remove</Button>
            </div>
          </>
        )}
      </Sheet>
      <DiscardSheet open={discarding} onClose={() => setDiscarding(false)} onDiscarded={() => navigate("/", { replace: true })} />
    </>
  );
}

export function DiscardSheet({ open, onClose, onDiscarded }: { open: boolean; onClose: () => void; onDiscarded: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} title="Discard this workout?" onClose={onClose}>
      <p className="mb-4">Nothing from it will be saved. This can't be undone.</p>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onClose}>Keep going</Button>
        <Button variant="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          await stopRest();
          await discard();
          onDiscarded();
        }}>Discard</Button>
      </div>
    </Sheet>
  );
}

/** Add from your library (the copy on this phone). Stays open so you can add several. */
function AddExercises({ open, onClose, w, hist, units: u }: { open: boolean; onClose: () => void; w: ActiveWorkout; hist: HistWorkout[]; units: Units }) {
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["exercises", "", false, false],
    queryFn: cached(() => get<Exercise[]>("/api/exercises"), (c) => c.exercises.filter((e) => !e.archived)),
    enabled: open,
  });
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (list.data ?? []).filter((x) => words.every((wd) => x.name.toLowerCase().includes(wd)));
  const add = (x: Exercise) => update((y) => {
    const e = addedExercise(x, hist, y.routine_id, u);
    return { ...y, exercises: [...y.exercises, e], currentKey: y.currentKey ?? e.key };
  });
  return (
    <Sheet open={open} title="Add exercises" onClose={onClose}>
      <label className="mb-3 block">
        <span className="sr-only">Search your exercises</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your exercises"
          className="block min-h-11 w-full rounded-xl border border-line bg-ground px-3" />
      </label>
      {list.isPending && <Loading />}
      <ErrorText error={list.error} />
      {list.data && shown.length === 0 && <p className="mb-3 text-muted">{q ? "Nothing matches." : "Your library is empty."} New exercises are added in the Library.</p>}
      <ul className="mb-3 max-h-[50dvh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {shown.map((x) => {
          const n = w.exercises.filter((e) => e.exercise_id === x.id).length;
          return (
            <li key={x.id}>
              <button type="button" onClick={() => void add(x)} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-sunken">
                <span>
                  <span className="block font-bold">{x.name}</span>
                  <span className="block text-sm text-muted">{LOGGING[x.logging_type]}</span>
                </span>
                {n > 0 && <span className="flex items-center gap-1 text-sm font-bold text-accent-text"><Check size={16} aria-hidden />Added{n > 1 && ` ${n}x`}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <Button variant="primary" className="w-full" onClick={onClose}>Done</Button>
    </Sheet>
  );
}

/** Says so, in plain words, when the phone can't alert at the end of a rest. */
function Permissions() {
  const [status, setStatus] = useState<NativeStatus | null>(null);
  useEffect(() => {
    const check = () => RestAlarm.status().then(setStatus).catch(() => setStatus(null));
    ensureNotificationPermission().catch(() => {}).finally(check);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  if (!status) return null;
  let text: string | null = null;
  let kind: "notifications" | "exactAlarms" = "notifications";
  if (!status.notifications) text = "Notifications are off, so rest alerts can't reach you. Turn on Notifications for Liftlog.";
  else if (!status.channelOn || !status.alarmChannelOn) text = "A rest timer alert is turned off. Turn on both Rest timer alerts.";
  else if (!status.exactAlarms) {
    text = "Liftlog isn't allowed to set alarms, so rest alerts could be late. Turn on Alarms and reminders.";
    kind = "exactAlarms";
  }
  if (!text) return null;
  return (
    <section role="alert" className="mb-2 rounded-2xl border-2 border-over bg-surface p-3">
      <p className="text-sm">{text}</p>
      <Button variant="primary" className="mt-2" onClick={() => void RestAlarm.openSettings({ kind })}>Open settings</Button>
    </section>
  );
}
