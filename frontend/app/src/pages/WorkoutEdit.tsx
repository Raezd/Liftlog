import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import { ExerciseOrder } from "../components/ExerciseOrder";
import { NumField, WEIGHT_COL } from "../components/NumField";
import { Sheet } from "../components/Sheet";
import { Badge, Button, ErrorText, Loading, Page, TextField } from "../components/ui";
import { ApiError, get, send } from "../lib/api";
import { addedSet, durationMinutes, editBody, editForm, formProblem, type EditExercise, type EditForm } from "../lib/edit";
import { LOGGING, SET_TYPE, longDate, plural, setLabels } from "../lib/format";
import { uuid7 } from "../lib/ids";
import { refresh, savedWorkout, useOffline } from "../lib/offline";
import { useMe } from "../lib/queries";
import { canStep, describeExercise, describeUnit, moveUnit, removeExercise, stepExercise, supersetLetters, unitIndexAt, units } from "../lib/reorder";
import {
  FIELDS, INPUT, RPE_VALUES, canLink, heaviest, heavySets, history, linkWithNext, tooHeavy, type ActiveSet, type Heaviest, type HistWorkout,
} from "../lib/session";
import type { SetType, WorkoutDetail } from "../lib/types";
import { useOnline } from "../lib/useOnline";
import { AddExercises, IconButton } from "./RoutineEdit";

const SET_TYPES = Object.entries(SET_TYPE) as [SetType, string][];
const NEEDS_CONNECTION = "Editing a workout needs a connection.";

/** "17:30" as the device shows times, like 5:30 PM. */
const clock = (hhmm: string) =>
  new Date(`1970-01-01T${hhmm}:00Z`).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/**
 * Fix a workout the server has: its title, notes, time, exercises, and sets.
 * Laid out like the routine editor; no rest timer, no plate math. Saving
 * sends the whole workout with the revision it started from; if it changed
 * somewhere else meanwhile, nothing is saved and the latest can be loaded.
 */
export default function WorkoutEdit() {
  const { id } = useParams();
  const me = useMe();
  const off = useOffline();
  const online = useOnline();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const u = {
    weight_unit: me.data?.weight_unit ?? off.copy?.me.weight_unit ?? "lb",
    distance_unit: me.data?.distance_unit ?? off.copy?.me.distance_unit ?? "mi",
  };
  const tz = me.data?.timezone ?? off.copy?.me.timezone ?? "America/Los_Angeles";
  // Always the server's current version: the save names its revision.
  const q = useQuery({
    queryKey: ["workout-edit", id], queryFn: () => get<WorkoutDetail>(`/api/workouts/${id}`),
    staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [form, setForm] = useState<EditForm | null>(null);
  const [saved, setSaved] = useState("");
  const [reorder, setReorder] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const leaving = useRef(false);

  useEffect(() => { void refresh(true); }, []);

  // Load the workout into the form, again after "Load the latest".
  const ready = !!q.data && off.ready && !!me.data;
  useEffect(() => {
    if (!ready) return;
    const info = new Map(off.copy?.exercises.map((e) => [e.id, e]));
    const f = editForm(q.data!, info, tz, u);
    setForm(f);
    setSaved(JSON.stringify(editBody(f, 0)));
    setProblem(null);
  }, [ready, q.dataUpdatedAt]);

  // The heavy weight warning compares against everything else: this workout as it was doesn't count.
  const hist = useMemo<HistWorkout[]>(() => {
    const c = off.copy;
    if (!c) return [];
    return history(c.workouts.filter((w) => w.id !== id), off.queue.filter((x) => x.login === c.me.login));
  }, [off.copy, off.queue, id]);

  const current = useMemo(() => (form ? JSON.stringify(editBody(form, 0)) : ""), [form]);
  const dirty = form !== null && current !== saved;

  const save = useMutation({
    mutationFn: () => send<WorkoutDetail>("POST", `/api/workouts/${id}/edit`, editBody(form!, q.data!.edit_revision ?? 0)),
    onSuccess: async (w) => {
      setConfirming(false);
      leaving.current = true;
      qc.setQueryData(["workout", id], w);
      void qc.invalidateQueries({ queryKey: ["workouts"] });
      await savedWorkout(w);
      navigate(`/workouts/${id}`, { replace: true });
    },
    onError: () => setConfirming(false),
  });
  const conflict = save.error instanceof ApiError && save.error.code === "edit_conflict";

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !leaving.current && !save.isPending && currentLocation.pathname !== nextLocation.pathname);

  if (!form) {
    return (
      <Page title="Edit workout" back={`/workouts/${id}`}>
        {!online && !q.data ? <p role="alert" className="font-bold text-over">{NEEDS_CONNECTION}</p>
          : q.error ? <ErrorText error={q.error} /> : <Loading />}
      </Page>
    );
  }

  const set = (next: Partial<EditForm>) => { setForm({ ...form, ...next }); setProblem(null); };
  const exs = form.exercises;
  const setEx = (i: number, next: Partial<EditExercise>) => set({ exercises: exs.map((e, j) => (j === i ? { ...e, ...next } : e)) });
  // Superset move rules live in lib/reorder.ts.
  const stepEx = (i: number, dir: -1 | 1) => {
    const next = stepExercise(exs, i, dir);
    set({ exercises: next });
    setSaid(describeExercise(next, exs[i].key));
  };
  const stepGroup = (i: number, dir: -1 | 1) => {
    const at = unitIndexAt(exs, i);
    const next = moveUnit(exs, at, at + dir);
    set({ exercises: next });
    setSaid(describeUnit(next, exs[i].key));
  };
  const letters = supersetLetters(exs);
  const unitCount = units(exs).length;
  const heavy = heavySets(form, hist);
  const minutesTotal = durationMinutes(form);

  const onSave = () => {
    save.reset();
    const why = formProblem(form);
    setProblem(why);
    if (!why) setConfirming(true);
  };
  const jumpTo = (setId: string) => {
    setConfirming(false);
    setReorder(false);
    requestAnimationFrame(() => document.getElementById(`weight-${setId}`)?.focus());
  };

  return (
    <Page title="Edit workout" back={`/workouts/${id}`}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        {!online && <p role="status" className="mb-3 rounded-2xl bg-sunken p-3 font-bold">{NEEDS_CONNECTION} Your changes stay here until you save.</p>}
        <TextField label="Title" required maxLength={120} value={form.title} onChange={(e) => set({ title: e.target.value })} />
        <label className="mb-3 block">
          <span className="font-bold">Notes</span>
          <textarea value={form.notes} maxLength={5000} rows={form.notes ? 3 : 2} onChange={(e) => set({ notes: e.target.value })}
            className="mt-1 block w-full rounded-xl border border-line bg-ground px-3 py-2" />
        </label>
        <fieldset className="mb-3">
          <legend className="font-bold">When</legend>
          <div className="grid grid-cols-2 gap-2">
            <TextField label="Start date" type="date" required value={form.start_date} onChange={(e) => set({ start_date: e.target.value })} />
            <TextField label="Start time" type="time" required value={form.start_time} onChange={(e) => set({ start_time: e.target.value })} />
            <TextField label="Hours" inputMode="numeric" value={form.hours}
              onChange={(e) => { if (/^\d{0,6}$/.test(e.target.value)) set({ hours: e.target.value }); }} />
            <TextField label="Minutes" inputMode="numeric" value={form.minutes}
              onChange={(e) => { if (/^\d{0,6}$/.test(e.target.value)) set({ minutes: e.target.value }); }} />
          </div>
          <p className="-mt-1 text-sm text-muted">Times are in {tz.replace(/_/g, " ")}. It ends when the duration is up.</p>
        </fieldset>

        <div className="mb-3 mt-5 flex items-center justify-between gap-2">
          <h2 className="display text-xl font-bold">Exercises</h2>
          {exs.length > 1 && (
            <Button variant={reorder ? "primary" : "secondary"} aria-pressed={reorder} onClick={() => setReorder(!reorder)}>
              {reorder ? "Done" : "Reorder"}
            </Button>
          )}
        </div>
        {exs.length === 0 && <p className="mb-3 text-muted">No exercises. Add one, or delete the workout from its page.</p>}

        {reorder ? (
          <>
            <p className="mb-3 text-sm text-muted">
              Drag the handles, or use the arrows. Moving an exercise past either end of its superset takes it out. Move a whole superset from its header.
            </p>
            <ExerciseOrder items={exs} onChange={(next) => set({ exercises: next })} />
          </>
        ) : (
          <ol className="space-y-3">
            {exs.map((e, i) => {
              const at = unitIndexAt(exs, i);
              const firstInGroup = letters[i] !== null && (i === 0 || letters[i - 1] !== letters[i]);
              return (
                <ExerciseCard key={e.key} e={e} letter={letters[i]} firstInGroup={firstInGroup} last={i === exs.length - 1}
                  top={FIELDS[e.logging_type].weight ? heaviest(hist, e.exercise_id) : null}
                  canStepUp={canStep(exs, i, -1)} canStepDown={canStep(exs, i, 1)}
                  groupUp={at > 0} groupDown={at < unitCount - 1}
                  canLink={canLink(exs, i)}
                  onStep={(dir) => stepEx(i, dir)} onStepGroup={(dir) => stepGroup(i, dir)}
                  onLink={(on) => set({ exercises: linkWithNext(exs, i, on) })}
                  onChange={(next) => setEx(i, next)}
                  onAddSet={() => setEx(i, { sets: [...e.sets, addedSet(e, u, uuid7())] })}
                  onRemove={() => set({ exercises: removeExercise(exs, i) })} />
              );
            })}
          </ol>
        )}
        {!reorder && (
          <Button className="mt-3 w-full" onClick={() => setAdding(true)}><Plus size={20} aria-hidden /> Add exercises</Button>
        )}

        <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 mt-6 rounded-2xl border border-line bg-surface p-3 shadow-lg">
          {problem && <p role="alert" className="mb-2 font-bold text-over">{problem}</p>}
          {save.error && !conflict && <ErrorText error={save.error} />}
          {conflict && (
            <div role="alert" className="mb-2">
              <p className="font-bold text-over">This workout was changed somewhere else, so your edits weren't saved.</p>
              <Button className="mt-2 w-full" onClick={() => { save.reset(); void q.refetch(); }}>
                Load the latest and drop my edits
              </Button>
            </div>
          )}
          {!online && <p className="mb-2 text-sm text-muted">{NEEDS_CONNECTION}</p>}
          <Button variant="primary" type="submit" className="w-full" disabled={!online || save.isPending || !dirty || conflict}>
            {save.isPending ? "Saving..." : dirty ? "Save" : "No changes"}
          </Button>
        </div>
      </form>

      <p className="sr-only" aria-live="polite">{said}</p>
      <AddExercises open={adding} onClose={() => setAdding(false)} added={exs.map((e) => e.exercise_id)}
        onAdd={(x) => {
          const e: EditExercise = {
            key: uuid7(), exercise_id: x.id, name: x.name, logging_type: x.logging_type, notes: "", rest: null,
            linkNext: false, supersetRest: null, sets: [],
          };
          set({ exercises: [...exs, { ...e, sets: [addedSet(e, u, uuid7())] }] });
        }} />

      <Sheet open={confirming} title="Save changes?" onClose={() => setConfirming(false)}>
        <p className="mb-2">
          {longDate(form.start_date)}, starting {clock(form.start_time)}
          {minutesTotal !== null && `, ${minutesTotal >= 60 ? `${Math.floor(minutesTotal / 60)} h ` : ""}${minutesTotal % 60} min`}.
        </p>
        <p className="mb-3 text-sm text-muted">
          {plural(exs.length, "exercise")}, {plural(exs.reduce((n, e) => n + e.sets.length, 0), "set")}.
          The change is kept on record, and records and stats update to match.
        </p>
        {heavy.length > 0 && (
          <div role="alert" className="mb-3 rounded-2xl border border-over p-3">
            <p className="flex items-center gap-2 font-bold text-over"><AlertTriangle size={20} aria-hidden className="shrink-0" />Check {heavy.length === 1 ? "this weight" : "these weights"}</p>
            <p className="mt-1 text-sm">More than 1.5 times your heaviest for the exercise. Tap one to fix it, or save if it's right.</p>
            <ul className="mt-2 divide-y divide-line">
              {heavy.map((h) => (
                <li key={h.set.id}>
                  <button type="button" onClick={() => jumpTo(h.set.id)} className="flex min-h-11 w-full items-center justify-between gap-2 py-1 text-left">
                    <span>{h.name}, {h.label.toLowerCase()}</span>
                    <span className="num shrink-0 font-bold">{h.set.weight} {h.set.weight_unit}<span className="sr-only">, heaviest is {h.top.value} {h.top.unit}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorText error={save.error && !conflict ? save.error : null} />
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setConfirming(false)}>Keep editing</Button>
          <Button variant="primary" disabled={!online || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </Sheet>

      <Sheet open={blocker.state === "blocked"} title="Leave without saving?" onClose={() => blocker.reset?.()}>
        <p className="mb-4">Your changes to this workout will be lost.</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button variant="primary" onClick={() => blocker.proceed?.()}>Leave</Button>
        </div>
      </Sheet>
    </Page>
  );
}

function ExerciseCard({ e, letter, firstInGroup, last, top, canLink, canStepUp, canStepDown, groupUp, groupDown, onStep, onStepGroup, onLink, onChange, onAddSet, onRemove }: {
  e: EditExercise; letter: string | null; firstInGroup: boolean; last: boolean; top: Heaviest | null; canLink: boolean;
  canStepUp: boolean; canStepDown: boolean; groupUp: boolean; groupDown: boolean;
  onStep: (dir: -1 | 1) => void; onStepGroup: (dir: -1 | 1) => void; onLink: (on: boolean) => void;
  onChange: (next: Partial<EditExercise>) => void; onAddSet: () => void; onRemove: () => void;
}) {
  const f = FIELDS[e.logging_type];
  const labels = setLabels(e.sets);
  const setSet = (k: number, next: Partial<ActiveSet>) => onChange({ sets: e.sets.map((s, j) => (j === k ? { ...s, ...next } : s)) });
  const moveSet = (k: number, to: number) => {
    const sets = e.sets.slice();
    const [s] = sets.splice(k, 1);
    sets.splice(to, 0, s);
    onChange({ sets });
  };
  const id = `ex-${e.key}`;
  const select = "block min-h-11 w-full rounded-xl border border-line bg-ground px-2";
  return (
    <li aria-labelledby={id} className={`rounded-2xl border bg-surface p-3 ${letter ? "border-l-4 border-accent-strong border-y-line border-r-line" : "border-line"}`}>
      {firstInGroup && (
        <div className="-mx-1 -mt-1 mb-2 flex items-center gap-1 rounded-xl bg-sunken pl-3">
          <span className="min-w-0 flex-1 font-bold text-accent-text">Superset {letter}</span>
          <IconButton label={`Move superset ${letter} up`} disabled={!groupUp} onClick={() => onStepGroup(-1)}><ArrowUp size={18} aria-hidden /></IconButton>
          <IconButton label={`Move superset ${letter} down`} disabled={!groupDown} onClick={() => onStepGroup(1)}><ArrowDown size={18} aria-hidden /></IconButton>
        </div>
      )}
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 pt-2">
          <h3 id={id} className="display text-lg font-bold leading-tight">{e.name}</h3>
          <p className="text-sm text-muted">{LOGGING[e.logging_type]}{letter && <> <Badge>Superset {letter}</Badge></>}</p>
        </div>
        <IconButton label={`Move ${e.name} up`} disabled={!canStepUp} onClick={() => onStep(-1)}><ArrowUp size={18} aria-hidden /></IconButton>
        <IconButton label={`Move ${e.name} down`} disabled={!canStepDown} onClick={() => onStep(1)}><ArrowDown size={18} aria-hidden /></IconButton>
        <IconButton label={`Remove ${e.name}`} onClick={onRemove}><Trash2 size={18} aria-hidden /></IconButton>
      </div>

      <label className="mt-2 block">
        <span className="text-sm font-bold">Notes</span>
        <textarea value={e.notes} maxLength={2000} rows={e.notes ? 2 : 1} onChange={(x) => onChange({ notes: x.target.value })}
          className="mt-1 block w-full rounded-xl border border-line bg-ground px-3 py-2" />
      </label>
      {!last && (
        <label className={`mb-2 flex min-h-11 items-center gap-3 ${!canLink && !e.linkNext ? "opacity-50" : ""}`}>
          <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={e.linkNext}
            disabled={!canLink && !e.linkNext} onChange={(x) => onLink(x.target.checked)} />
          <span>
            Superset with the next exercise
            {!canLink && !e.linkNext && <span className="block text-sm text-muted">A superset can have up to three.</span>}
          </span>
        </label>
      )}

      <h4 className="sr-only">Sets</h4>
      {e.sets.length > 0 && (
        <div aria-hidden className="mt-2 flex gap-1 px-1 text-center text-xs font-bold text-muted">
          <span className="w-11 shrink-0" />
          {f.weight && <span className={`min-w-0 ${WEIGHT_COL}`}>{f.weight}</span>}
          {f.reps && <span className="min-w-0 flex-1">Reps</span>}
          {f.distance && <span className="min-w-0 flex-1">Distance</span>}
          {f.duration && <span className="min-w-0 flex-1">Time</span>}
        </div>
      )}
      <ol className="space-y-2">
        {e.sets.map((s, k) => {
          const l = labels[k];
          const name = `${e.name} ${l.name.toLowerCase()}`;
          const short = l.name.toLowerCase();
          return (
            <li key={s.id} aria-label={l.name} className="rounded-xl bg-sunken p-1">
              <div className="flex items-center gap-1">
                <span className="num inline-flex min-h-12 w-11 shrink-0 flex-col items-center justify-center font-bold text-accent-text" aria-hidden>
                  <span className="leading-none">{l.label}</span>
                  {l.tag && <span className="mt-0.5 text-[0.625rem] uppercase leading-none">{l.tag}</span>}
                </span>
                {f.weight && (
                  <NumField id={`weight-${s.id}`} label={`${name} ${f.weight.toLowerCase()}, ${s.weight_unit}`} mode="decimal" pattern={INPUT.weight}
                    className={WEIGHT_COL} value={s.weight} onChange={(v) => setSet(k, { weight: v })} />
                )}
                {f.reps && <NumField label={`${name} reps`} mode="numeric" pattern={INPUT.reps} value={s.reps} onChange={(v) => setSet(k, { reps: v })} />}
                {f.distance && <NumField label={`${name} distance, ${s.distance_unit}`} mode="decimal" pattern={INPUT.distance} value={s.distance} onChange={(v) => setSet(k, { distance: v })} />}
                {f.duration && <NumField label={`${name} time`} mode="text" pattern={INPUT.duration} placeholder="m:ss" value={s.duration} onChange={(v) => setSet(k, { duration: v })} />}
              </div>
              {tooHeavy(s, top) && (
                <p className="flex items-start gap-1 pl-12 text-sm font-bold text-over">
                  <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
                  <span>Check this weight. Your heaviest is {top!.value} {top!.unit}.</span>
                </p>
              )}
              <div className="mt-1 flex items-center gap-1 pl-12">
                <label className="min-w-0 flex-1">
                  <span className="sr-only">{name} type</span>
                  <select value={s.set_type} onChange={(x) => setSet(k, { set_type: x.target.value as SetType })} className={select}>
                    {SET_TYPES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                  </select>
                </label>
                {f.rpe && (
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">{name} RPE</span>
                    <select value={s.rpe ?? ""} onChange={(x) => setSet(k, { rpe: x.target.value || null })} className={select}>
                      <option value="">No RPE</option>
                      {RPE_VALUES.map((v) => <option key={v} value={v}>RPE {v}</option>)}
                    </select>
                  </label>
                )}
                <IconButton label={`Move ${short} up`} disabled={k === 0} onClick={() => moveSet(k, k - 1)}><ArrowUp size={18} aria-hidden /></IconButton>
                <IconButton label={`Move ${short} down`} disabled={k === e.sets.length - 1} onClick={() => moveSet(k, k + 1)}><ArrowDown size={18} aria-hidden /></IconButton>
                <IconButton label={`Remove ${short}`} onClick={() => onChange({ sets: e.sets.filter((_, j) => j !== k) })}><Trash2 size={18} aria-hidden /></IconButton>
              </div>
            </li>
          );
        })}
      </ol>
      <Button variant="quiet" className="mt-1 w-full" onClick={onAddSet}>
        <Plus size={18} aria-hidden /> Add set<span className="sr-only"> to {e.name}</span>
      </Button>
    </li>
  );
}
