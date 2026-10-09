import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, History, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Sheet } from "../components/Sheet";
import { ExerciseOrder } from "../components/ExerciseOrder";
import { moved } from "../components/Sortable";
import { Badge, Button, ErrorText, Loading, Page, SelectField, TextField, btn } from "../components/ui";
import { ApiError, get, send } from "../lib/api";
import { LOGGING, SET_TYPE, duration } from "../lib/format";
import { uuid7 } from "../lib/ids";
import { useMe } from "../lib/queries";
import { canStep, describeExercise, describeUnit, moveUnit, removeExercise, stepExercise, supersetLetters, unitIndexAt, units } from "../lib/reorder";
import { FIELDS, isNumber, parseDuration } from "../lib/session";
import type { DistanceUnit, Exercise, LoggingType, RoutineDetail, RoutineVersion, SetType, WeightUnit } from "../lib/types";
import { useRoutineList } from "./Routines";

type ESet = {
  key: string;
  set_type: SetType;
  range: boolean;
  reps_min: string;
  reps_max: string;
  weight: string;
  weight_unit: WeightUnit;
  rpe: string;
  duration: string;
  distance: string;
  distance_unit: DistanceUnit | "m";
};

type EEx = {
  key: string;
  exercise_id: string;
  name: string;
  logging_type: LoggingType;
  notes: string;
  rest: number | null;
  /** Grouped into a superset with the next exercise. */
  linkNext: boolean;
  /** Rest after each round, kept on the first exercise of a superset. */
  supersetRest: number | null;
  sets: ESet[];
};

type Form = { name: string; exercises: EEx[] };

const RPE_OPTIONS: [string, string][] = [["", "None"], ...["6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10"].map((v): [string, string] => [v, v])];
const SET_TYPES = Object.entries(SET_TYPE) as [SetType, string][];

function restOptions(current: number | null): [string, string][] {
  const secs = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 210, 240, 270, 300, 360, 420, 480, 540, 600];
  if (current !== null && !secs.includes(current)) secs.push(current);
  return [["", "Off"], ...secs.sort((a, b) => a - b).map((s): [string, string] => [String(s), duration(s)])];
}

function blankSet(unit: WeightUnit, like?: ESet): ESet {
  return like
    ? { ...like, key: uuid7() }
    : { key: uuid7(), set_type: "normal", range: false, reps_min: "", reps_max: "", weight: "", weight_unit: unit, rpe: "", duration: "", distance: "", distance_unit: "mi" };
}

function fromVersion(name: string, v: RoutineVersion, unit: WeightUnit): Form {
  const ex = v.exercises;
  return {
    name,
    exercises: ex.map((e, i) => ({
      key: e.id, exercise_id: e.exercise_id, name: e.name, logging_type: e.logging_type, notes: e.notes, rest: e.rest_seconds,
      linkNext: e.superset_group !== null && ex[i + 1]?.superset_group === e.superset_group,
      supersetRest: e.superset_group !== null ? v.superset_rests[String(e.superset_group)] ?? null : null,
      sets: e.sets.map((s) => ({
        key: s.id, set_type: s.set_type, range: s.reps_min !== null && s.reps_min !== s.reps_max,
        reps_min: s.reps_min?.toString() ?? "", reps_max: s.reps_max?.toString() ?? "",
        weight: s.weight_value ?? "", weight_unit: s.weight_unit ?? unit, rpe: s.rpe ?? "",
        duration: s.duration_seconds !== null ? duration(s.duration_seconds) : "",
        distance: s.distance_value ?? "", distance_unit: s.distance_unit ?? "mi",
      })),
    })),
  };
}

/** Superset chains: index -> [first index of its chain, chain length], or null. */
function chains(exs: EEx[]): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = exs.map(() => null);
  for (let i = 0; i < exs.length;) {
    let j = i;
    while (exs[j].linkNext && j + 1 < exs.length) j++;
    if (j > i) for (let k = i; k <= j; k++) out[k] = [i, j - i + 1];
    i = j + 1;
  }
  return out;
}

/** The form as the API's version body, or the first problem with it. */
function toBody(form: Form): { body?: object; problem?: string } {
  const ch = chains(form.exercises);
  const groups: Record<number, number> = {};
  const rests: Record<string, number> = {};
  const exercises = [];
  for (const [i, e] of form.exercises.entries()) {
    let group: number | null = null;
    if (ch[i]) {
      const first = ch[i]![0];
      group = groups[first] ??= Object.keys(groups).length;
      const rest = form.exercises[first].supersetRest;
      if (rest !== null) rests[String(group)] = rest;
    }
    const f = FIELDS[e.logging_type];
    const sets = [];
    for (const [k, s] of e.sets.entries()) {
      const where = `${e.name}, set ${k + 1}`;
      const lo = s.reps_min.trim(), hi = (s.range ? s.reps_max : s.reps_min).trim();
      if ((lo && !/^\d+$/.test(lo)) || (hi && !/^\d+$/.test(hi))) return { problem: `${where}: reps should be a whole number.` };
      if (s.range && (!lo || !hi) && (lo || hi)) return { problem: `${where}: give both ends of the rep range.` };
      if (lo && hi && Number(hi) < Number(lo)) return { problem: `${where}: the rep range goes from low to high.` };
      if (s.weight.trim() && !isNumber(s.weight)) return { problem: `${where}: weight should be a number.` };
      if (s.distance.trim() && !isNumber(s.distance)) return { problem: `${where}: distance should be a number.` };
      const dur = parseDuration(s.duration);
      if (dur === undefined) return { problem: `${where}: write time like 1:30.` };
      const weight = f.weight && s.weight.trim() ? s.weight.trim() : null;
      const distance = f.distance && s.distance.trim() ? s.distance.trim() : null;
      sets.push({
        set_type: s.set_type,
        reps_min: f.reps && lo ? Number(lo) : null, reps_max: f.reps && hi ? Number(hi) : null,
        weight_value: weight, weight_unit: weight ? s.weight_unit : null,
        rpe: f.rpe && s.rpe ? s.rpe : null,
        duration_seconds: f.duration ? dur : null,
        distance_value: distance, distance_unit: distance ? s.distance_unit : null,
      });
    }
    exercises.push({ exercise_id: e.exercise_id, superset_group: group, notes: e.notes, rest_seconds: e.rest, sets });
  }
  return { body: { exercises, superset_rests: rests } };
}

/** What counts as a change, for the unsaved changes check. */
const snapshot = (f: Form) => JSON.stringify({ name: f.name, ...toBody(f).body });

/** Make a routine, or edit one. Saving an edit makes a new version. */
export default function RoutineEdit() {
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const me = useMe();
  const unit: WeightUnit = me.data?.weight_unit ?? "lb";
  const qc = useQueryClient();
  const navigate = useNavigate();
  const routine = useQuery({ queryKey: ["routine", id], queryFn: () => get<RoutineDetail>(`/api/routines/${id}`), enabled: !isNew });
  const folders = useRoutineList(false);
  const [form, setForm] = useState<Form | null>(isNew ? { name: "", exercises: [] } : null);
  const [saved, setSaved] = useState<string>(() => (isNew ? snapshot({ name: "", exercises: [] }) : ""));
  const leaving = useRef(false);
  const [folderId, setFolderId] = useState(params.get("folder") ?? "");
  const [reorder, setReorder] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  // Load the routine into the form, once per version.
  const loaded = routine.data;
  useEffect(() => {
    if (!loaded) return;
    const f = fromVersion(loaded.name, loaded.current_version, unit);
    setForm(f);
    setSaved(snapshot(f));
  }, [loaded?.current_version.id]);

  const current = useMemo(() => (form ? snapshot(form) : ""), [form]);
  const dirty = form !== null && current !== saved;

  const save = useMutation({
    mutationFn: (body: object) => isNew
      ? send<RoutineDetail>("POST", "/api/routines", { id: uuid7(), name: form!.name, folder_id: folderId || null, version: body })
      : send<RoutineDetail>("POST", `/api/routines/${id}/versions`, {
        ...body, id: uuid7(), name: form!.name, parent_version_id: loaded!.current_version.id }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      void qc.invalidateQueries({ queryKey: ["versions", r.id] });
      qc.setQueryData(["routine", r.id], r);
      setSaved(current);
      if (isNew) {
        leaving.current = true;
        navigate(`/routines/${r.id}/edit`, { replace: true });
      }
      else setNotice(`Saved as version ${r.current_version.number}.`);
    },
  });
  const conflict = save.error instanceof ApiError && save.error.code === "version_conflict";

  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !leaving.current && !save.isPending && currentLocation.pathname !== nextLocation.pathname);

  if (!isNew && (routine.isPending || !form)) {
    return <Page title="Routine" back={`/routines/${id}`}>{routine.isPending ? <Loading /> : <ErrorText error={routine.error} />}</Page>;
  }
  if (!form) return null;

  const set = (next: Partial<Form>) => { setForm({ ...form, ...next }); setNotice(null); };
  const exs = form.exercises;
  const setEx = (i: number, next: Partial<EEx>) => set({ exercises: exs.map((e, j) => (j === i ? { ...e, ...next } : e)) });
  // Superset move rules live in lib/reorder.ts.
  const stepEx = (i: number, dir: -1 | 1) => {
    const next = stepExercise(exs, i, dir);
    set({ exercises: next });
    setSaid(describeExercise(next, exs[i].key));
  };
  const stepGroup = (i: number, dir: -1 | 1) => {
    const u = unitIndexAt(exs, i);
    const next = moveUnit(exs, u, u + dir);
    set({ exercises: next });
    setSaid(describeUnit(next, exs[i].key));
  };
  const ch = chains(exs);
  const letters = supersetLetters(exs);
  const unitCount = units(exs).length;

  const onSave = () => {
    setNotice(null);
    if (!form.name.trim()) return setProblem("Give the routine a name.");
    const { body, problem } = toBody(form);
    setProblem(problem ?? null);
    if (body) save.mutate(body);
  };

  return (
    <Page title={isNew ? "New routine" : "Edit routine"} back={isNew ? "/" : `/routines/${id}`}
      action={!isNew && <Link to={`/routines/${id}/versions`} className={btn.quiet}><History size={18} aria-hidden /> Versions</Link>}>
      <form onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <TextField label="Name" required maxLength={120} value={form.name} placeholder="Day 1: Squat"
          onChange={(e) => set({ name: e.target.value })} />
        {isNew && folders.data && (
          <SelectField label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}
            options={[["", "No folder"], ...folders.data.folders.map((f): [string, string] => [f.id, f.name])]} />
        )}
        {!isNew && loaded && <p className="-mt-1 mb-3 text-sm text-muted">Version {loaded.current_version.number}{loaded.archived && ", archived"}</p>}

        <div className="mb-3 mt-5 flex items-center justify-between gap-2">
          <h2 className="display text-xl font-bold">Exercises</h2>
          {exs.length > 1 && (
            <Button variant={reorder ? "primary" : "secondary"} aria-pressed={reorder} onClick={() => setReorder(!reorder)}>
              {reorder ? "Done" : "Reorder"}
            </Button>
          )}
        </div>

        {exs.length === 0 && <p className="mb-3 text-muted">No exercises yet.</p>}

        {reorder ? (
          <>
            <p className="mb-3 text-sm text-muted">
              Drag the handles, or use the arrows. Moving an exercise past either end of its superset takes it out. Move a whole superset from its header.
            </p>
            <ExerciseOrder items={exs} onChange={(next) => set({ exercises: next })} />
          </>
        ) : (
          <ol className="space-y-3">
            {exs.map((e, i) => (
              <ExerciseCard key={e.key} e={e} index={i} count={exs.length} unit={unit} chain={ch[i]}
                letter={letters[i]}
                canStepUp={canStep(exs, i, -1)} canStepDown={canStep(exs, i, 1)}
                groupUp={unitIndexAt(exs, i) > 0} groupDown={unitIndexAt(exs, i) < unitCount - 1}
                onStep={(dir) => stepEx(i, dir)} onStepGroup={(dir) => stepGroup(i, dir)}
                canLink={i < exs.length - 1 && (ch[i]?.[1] ?? 1) + (ch[i + 1]?.[1] ?? 1) <= 3}
                onChange={(next) => setEx(i, next)}
                onRemove={() => set({ exercises: removeExercise(exs, i) })} />
            ))}
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
              <p className="font-bold text-over">This routine was changed somewhere else, so your edits weren't saved.</p>
              <Button className="mt-2 w-full" onClick={() => { save.reset(); void routine.refetch(); }}>
                Load the latest and drop my edits
              </Button>
            </div>
          )}
          {notice && !dirty && <p role="status" className="mb-2 font-bold text-accent-text">{notice}</p>}
          <Button variant="primary" type="submit" className="w-full" disabled={save.isPending || (!dirty && !isNew)}>
            {save.isPending ? "Saving..." : dirty || isNew ? "Save" : "Saved"}
          </Button>
        </div>
      </form>

      <p className="sr-only" aria-live="polite">{said}</p>
      <AddExercises open={adding} onClose={() => setAdding(false)} added={exs.map((e) => e.exercise_id)}
        onAdd={(x) => set({
          exercises: [...exs, {
            key: uuid7(), exercise_id: x.id, name: x.name, logging_type: x.logging_type, notes: "", rest: null,
            linkNext: false, supersetRest: null, sets: [blankSet(unit)],
          }],
        })} />

      <Sheet open={blocker.state === "blocked"} title="Leave without saving?" onClose={() => blocker.reset?.()}>
        <p className="mb-4">Your changes to this routine will be lost.</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button variant="primary" onClick={() => blocker.proceed?.()}>Leave</Button>
        </div>
      </Sheet>
    </Page>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-sunken disabled:opacity-30">
      {children}<span className="sr-only">{label}</span>
    </button>
  );
}

function ExerciseCard({ e, index, count, unit, chain, letter, canLink, canStepUp, canStepDown, groupUp, groupDown, onStep, onStepGroup, onChange, onRemove }: {
  e: EEx; index: number; count: number; unit: WeightUnit; chain: [number, number] | null; letter: string | null; canLink: boolean;
  canStepUp: boolean; canStepDown: boolean; groupUp: boolean; groupDown: boolean;
  onStep: (dir: -1 | 1) => void; onStepGroup: (dir: -1 | 1) => void;
  onChange: (next: Partial<EEx>) => void; onRemove: () => void;
}) {
  const f = FIELDS[e.logging_type];
  const setSet = (k: number, next: Partial<ESet>) => onChange({ sets: e.sets.map((s, j) => (j === k ? { ...s, ...next } : s)) });
  const firstInChain = chain !== null && chain[0] === index;
  const id = `ex-${e.key}`;
  return (
    <li aria-labelledby={id} className={`rounded-2xl border bg-surface p-3 ${chain ? "border-l-4 border-accent-strong border-y-line border-r-line" : "border-line"}`}>
      {firstInChain && (
        <div className="-mx-1 -mt-1 mb-2 flex items-center gap-1 rounded-xl bg-sunken pl-3">
          <span className="min-w-0 flex-1 font-bold text-accent-text">Superset {letter}</span>
          <IconButton label={`Move superset ${letter} up`} disabled={!groupUp} onClick={() => onStepGroup(-1)}><ArrowUp size={18} aria-hidden /></IconButton>
          <IconButton label={`Move superset ${letter} down`} disabled={!groupDown} onClick={() => onStepGroup(1)}><ArrowDown size={18} aria-hidden /></IconButton>
        </div>
      )}
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 pt-2">
          <h3 id={id} className="display text-lg font-bold leading-tight">{e.name}</h3>
          <p className="text-sm text-muted">
            {LOGGING[e.logging_type]}{letter && <> <Badge>Superset {letter}</Badge></>}
          </p>
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
      <div className="mt-2 grid grid-cols-2 gap-2">
        <SelectField label="Rest" value={e.rest?.toString() ?? ""} options={restOptions(e.rest)}
          onChange={(x) => onChange({ rest: x.target.value ? Number(x.target.value) : null })} />
        {firstInChain && (
          <SelectField label="Rest after round" value={e.supersetRest?.toString() ?? ""} options={restOptions(e.supersetRest)}
            onChange={(x) => onChange({ supersetRest: x.target.value ? Number(x.target.value) : null })} />
        )}
      </div>
      {index < count - 1 && (
        <label className={`mb-2 flex min-h-11 items-center gap-3 ${!canLink && !e.linkNext ? "opacity-50" : ""}`}>
          <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={e.linkNext}
            disabled={!canLink && !e.linkNext} onChange={(x) => onChange({ linkNext: x.target.checked })} />
          <span>
            Superset with the next exercise
            {!canLink && !e.linkNext && <span className="block text-sm text-muted">A superset can have up to three.</span>}
          </span>
        </label>
      )}

      <h4 className="sr-only">Sets</h4>
      <ol className="space-y-2">
        {e.sets.map((s, k) => (
          <li key={s.key} className="rounded-xl bg-sunken p-2" aria-label={`Set ${k + 1}`}>
            <div className="flex items-center gap-1">
              <span className="num w-12 shrink-0 pl-1 font-bold">Set {k + 1}</span>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Set {k + 1} type</span>
                <select value={s.set_type} onChange={(x) => setSet(k, { set_type: x.target.value as SetType })}
                  className="block min-h-11 w-full rounded-xl border border-line bg-ground px-2">
                  {SET_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <IconButton label={`Move set ${k + 1} up`} disabled={k === 0} onClick={() => onChange({ sets: moved(e.sets, k, k - 1) })}><ArrowUp size={18} aria-hidden /></IconButton>
              <IconButton label={`Move set ${k + 1} down`} disabled={k === e.sets.length - 1} onClick={() => onChange({ sets: moved(e.sets, k, k + 1) })}><ArrowDown size={18} aria-hidden /></IconButton>
              <IconButton label={`Remove set ${k + 1}`} onClick={() => onChange({ sets: e.sets.filter((_, j) => j !== k) })}><Trash2 size={18} aria-hidden /></IconButton>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-2">
              {f.reps && <RepsField s={s} n={k + 1} onChange={(next) => setSet(k, next)} />}
              {f.weight && (
                <SmallField label={f.weight} suffix={s.weight_unit} inputMode="decimal" value={s.weight}
                  onChange={(v) => setSet(k, { weight: v, weight_unit: s.weight ? s.weight_unit : unit })} />
              )}
              {f.distance && (
                <SmallField label="Distance" suffix={s.distance_unit} inputMode="decimal" value={s.distance}
                  onChange={(v) => setSet(k, { distance: v })} />
              )}
              {f.duration && (
                <SmallField label="Time" placeholder="m:ss" inputMode="numeric" value={s.duration}
                  onChange={(v) => setSet(k, { duration: v })} />
              )}
              {f.rpe && (
                <label className="mt-1 block">
                  <span className="text-sm font-bold">RPE</span>
                  <select value={s.rpe} onChange={(x) => setSet(k, { rpe: x.target.value })}
                    className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-ground px-2">
                    {RPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              )}
            </div>
          </li>
        ))}
      </ol>
      <Button variant="quiet" className="mt-1 w-full" onClick={() => onChange({ sets: [...e.sets, blankSet(unit, e.sets[e.sets.length - 1])] })}>
        <Plus size={18} aria-hidden /> Add set<span className="sr-only"> to {e.name}</span>
      </Button>
    </li>
  );
}

function SmallField({ label, suffix, value, onChange, ...rest }: {
  label: string; suffix?: string; value: string; onChange: (v: string) => void; placeholder?: string; inputMode?: "decimal" | "numeric";
}) {
  return (
    <label className="mt-1 block">
      <span className="text-sm font-bold">{label}</span>
      <span className="mt-1 flex items-center rounded-xl border border-line bg-ground pr-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-text">
        <input value={value} onChange={(e) => onChange(e.target.value)} {...rest}
          className="num block min-h-11 w-full min-w-0 rounded-xl bg-transparent px-2 outline-none" />
        {suffix && <span className="text-sm text-muted">{suffix}</span>}
      </span>
    </label>
  );
}

function RepsField({ s, n, onChange }: { s: ESet; n: number; onChange: (next: Partial<ESet>) => void }) {
  const input = "num block min-h-11 w-full min-w-0 rounded-xl border border-line bg-ground px-2";
  return (
    <fieldset className="col-span-2 mt-1">
      <legend className="text-sm font-bold">Reps</legend>
      <div className="flex items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{s.range ? `Set ${n} fewest reps` : `Set ${n} reps`}</span>
          <input inputMode="numeric" value={s.reps_min} onChange={(e) => onChange({ reps_min: e.target.value })} className={input} />
        </label>
        {s.range && (
          <>
            <span aria-hidden>to</span>
            <label className="min-w-0 flex-1">
              <span className="sr-only">Set {n} most reps</span>
              <input inputMode="numeric" value={s.reps_max} onChange={(e) => onChange({ reps_max: e.target.value })} className={input} />
            </label>
          </>
        )}
        <label className="flex min-h-11 shrink-0 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--accent-strong)]" checked={s.range}
            onChange={(e) => onChange({ range: e.target.checked, reps_max: e.target.checked ? s.reps_max || s.reps_min : s.reps_min })} />
          Range
        </label>
      </div>
    </fieldset>
  );
}

/** Pick exercises from your library. Stays open so you can add several. */
function AddExercises({ open, onClose, onAdd, added }: { open: boolean; onClose: () => void; onAdd: (e: Exercise) => void; added: string[] }) {
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["exercises", q, false, false],
    queryFn: () => get<Exercise[]>(`/api/exercises?${new URLSearchParams({ q })}`),
    enabled: open,
    placeholderData: (prev) => prev,
  });
  return (
    <Sheet open={open} title="Add exercises" onClose={onClose}>
      <label className="mb-3 block">
        <span className="sr-only">Search your exercises</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your exercises" autoFocus
          className="block min-h-11 w-full rounded-xl border border-line bg-ground px-3" />
      </label>
      <ErrorText error={list.error} />
      {list.data && list.data.length === 0 && (
        <p className="mb-3 text-muted">{q ? "Nothing matches." : "Your library is empty."} New exercises are added in the Library.</p>
      )}
      <ul className="mb-3 max-h-[50dvh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {list.data?.map((x) => {
          const n = added.filter((a) => a === x.id).length;
          return (
            <li key={x.id}>
              <button type="button" onClick={() => onAdd(x)} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-sunken">
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
