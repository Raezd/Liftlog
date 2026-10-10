import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus, Star } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ExportLinks } from "../components/ExportLinks";
import { Sheet } from "../components/Sheet";
import { Badge, Button, ErrorText, Loading, Page, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { uuid7 } from "../lib/ids";
import { clockTime, longDate, minutes } from "../lib/format";
import { cached, useOffline } from "../lib/offline";
import { useMe } from "../lib/queries";
import type { Queued } from "../lib/session";
import { workoutDate, type RecordType } from "../lib/stats";
import type { OfflineCopy, RoutineDetail, WorkoutDetail } from "../lib/types";
import { RECORD_TAG, setText, useStats } from "../lib/useStats";
import { useRoutineList } from "./Routines";
import { SetRows } from "./RoutineVersions";
import type { SavedState } from "./RoutineView";

const SUPERSET = "ABCDEFGHIJ";

const savedOn = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** A workout still on this phone, shaped like one from the server. */
function fromQueue(q: Queued, copy: OfflineCopy | null, timeZone: string): WorkoutDetail {
  const names = new Map(copy?.exercises.map((e) => [e.id, e.name]));
  const routines = copy ? [...copy.routines.routines, ...copy.routines.folders.flatMap((f) => f.routines)] : [];
  const v = q.body.routine_version;
  return {
    id: q.id, title: q.body.title, notes: q.body.notes, started_at: q.body.started_at, ended_at: q.body.ended_at,
    workout_date: workoutDate(q.body.started_at, timeZone), source: "liftlog",
    routine_version_id: q.body.routine_version_id, routine_id: q.routine_id,
    routine_name: routines.find((r) => r.id === q.routine_id)?.name ?? null,
    routine_version_number: v?.number ?? null, routine_version_created_at: v?.created_at ?? null,
    exercises: q.body.exercises.map((e, i) => {
      const name = names.get(e.exercise_id) ?? v?.exercises.find((x) => x.exercise_id === e.exercise_id)?.name ?? "Exercise";
      return {
        id: e.id, exercise_id: e.exercise_id, name, logged_name: name, position: i, superset_group: e.superset_group,
        notes: e.notes, rest_seconds: e.rest_seconds, sets: e.sets.map((x, k) => ({ ...x, position: k })),
      };
    }),
  };
}

/** One workout, read-only. A workout still on this phone can't be saved as a routine or exported until it uploads. */
export default function WorkoutView() {
  const { id } = useParams();
  const me = useMe();
  const off = useOffline();
  const { stats } = useStats();
  const tz = me.data?.timezone ?? off.copy?.me.timezone ?? "America/Los_Angeles";
  const queued = off.queue.find((x) => x.id === id && (!off.copy || x.login === off.copy.me.login)) ?? null;
  const uploaded = stats?.copy.workouts.some((x) => x.id === id) ?? false;
  const q = useQuery({
    queryKey: ["workout", id],
    queryFn: cached(() => get<WorkoutDetail>(`/api/workouts/${id}`), (c) => c.workouts.find((x) => x.id === id)),
    enabled: off.ready && (!queued || uploaded),
  });
  const w = queued && !uploaded ? fromQueue(queued, off.copy, tz) : q.data;
  const onPhone = !!queued && !uploaded;
  const [saving, setSaving] = useState(false);

  // Records this workout set when it was logged: set id -> types, and session volume per exercise.
  const prs = (stats?.records.byWorkout.get(id ?? "") ?? []);
  const bySet = new Map<string, RecordType[]>();
  for (const p of prs) if (p.set) bySet.set(p.set.id, [...(bySet.get(p.set.id) ?? []), p.type]);
  const sessionPR = new Set(prs.filter((p) => p.type === "session_volume").map((p) => p.exercise_id));
  const routineName = w?.routine_name ?? (w?.routine_id ? stats?.copy.routines.routines.concat(stats.copy.routines.folders.flatMap((f) => f.routines)).find((r) => r.id === w.routine_id)?.name : null);

  return (
    <Page title={w?.title ?? "Workout"} back="/history">
      {!w && (q.isPending || !off.ready) && !q.error && <Loading />}
      {!w && <ErrorText error={q.error} />}
      {w && (
        <>
          <p className="-mt-3 mb-2 text-muted">
            {longDate(w.workout_date)}, {clockTime(w.started_at, tz)}
            {minutes(w.started_at, w.ended_at) && `, ${minutes(w.started_at, w.ended_at)}`}
            {w.source === "hevy_import" && <> <Badge tone="muted">Imported from Hevy</Badge></>}
          </p>
          {queued && !uploaded && (
            <p className="mb-2"><Badge>{queued.error === null ? "Waiting to upload" : "Needs attention"}</Badge></p>
          )}
          {w.routine_version_id && w.routine_id && (
            <p className="mb-4">
              <Link to={`/routines/${w.routine_id}/versions`} className="font-bold text-accent-text underline underline-offset-2">
                {routineName ?? "Routine"}{w.routine_version_created_at && `, version saved ${savedOn(w.routine_version_created_at)}`}
              </Link>
            </p>
          )}
          {w.notes && <p className="mb-4 whitespace-pre-line rounded-2xl bg-sunken p-3">{w.notes}</p>}
          <ol className="space-y-3">
            {w.exercises.map((e) => (
              <li key={e.id} className="rounded-2xl border border-line bg-surface p-4">
                <h2 className="display text-lg font-bold">
                  <Link to={`/exercises/${e.exercise_id}`} className="underline decoration-line underline-offset-4 hover:decoration-accent-text">{e.name}</Link>
                </h2>
                {e.superset_group !== null && (
                  <p className="text-sm font-bold text-accent-text">Superset {SUPERSET[e.superset_group] ?? e.superset_group + 1}</p>
                )}
                {e.logged_name !== e.name && <p className="text-sm text-muted">Logged as {e.logged_name}</p>}
                {e.notes && <p className="mt-1 whitespace-pre-line text-sm">{e.notes}</p>}
                {sessionPR.has(e.exercise_id) && <p className="mt-1"><RecordBadge text="Session volume record" /></p>}
                <SetRows sets={e.sets} text={(s) => setText(s)} extra={(s) => (
                  <>
                    {s.rpe !== null && <span className="text-sm text-muted">RPE {s.rpe}</span>}
                    {bySet.has(s.id) && (
                      <span className="flex basis-full flex-wrap gap-1 pl-9">{bySet.get(s.id)!.map((t) => <RecordBadge key={t} text={RECORD_TAG[t]} />)}</span>
                    )}
                  </>
                )} />
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-muted">W is a warm-up. Working sets count from 1. A star marks a record set when it was logged.</p>
          {onPhone ? (
            <p className="mt-4 rounded-2xl bg-sunken p-3">Save as routine and export work once this workout uploads.</p>
          ) : (
            <>
              <Button className="mt-4 w-full" onClick={() => setSaving(true)}><ListPlus size={20} aria-hidden /> Save as routine</Button>
              <section aria-label="Export this workout" className="mt-6">
                <h2 className="display mb-2 text-lg font-bold">Export this workout</h2>
                <ExportLinks path={`/api/workouts/${w.id}/export`} page={`/workouts/${w.id}`} what="this workout" />
              </section>
              <Sheet open={saving} title="Save as routine" onClose={() => setSaving(false)}>
                {saving && <SaveAsRoutine workout={w} />}
              </Sheet>
            </>
          )}
        </>
      )}
    </Page>
  );
}

export function RecordBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-strong px-2 py-0.5 text-xs font-bold text-white">
      <Star size={12} aria-hidden fill="currentColor" /><span className="sr-only">Record: </span>{text}
    </span>
  );
}

const NEW = "new";

/** A new routine from this workout: its exercises, order, supersets, notes,
 *  set types, and each set's weight and reps as targets. RPE isn't copied. */
function SaveAsRoutine({ workout }: { workout: WorkoutDetail }) {
  const folders = useRoutineList(false);
  const [name, setName] = useState(workout.title);
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: () => send<RoutineDetail>("POST", "/api/routines/from-workout", {
      id: uuid7(), workout_id: workout.id, name,
      folder_id: folder && folder !== NEW ? folder : null,
      new_folder_name: folder === NEW ? newFolder : null,
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      qc.setQueryData(["routine", r.id], r);
      const folderName = folder === NEW ? newFolder.trim() : folders.data?.folders.find((f) => f.id === folder)?.name ?? null;
      navigate(`/routines/${r.id}`, { state: { saved: { folder: folderName } } satisfies SavedState });
    },
  });
  const options: [string, string][] = [["", "No folder"], ...(folders.data?.folders ?? []).map((f): [string, string] => [f.id, f.name]), [NEW, "New folder..."]];
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <p className="mb-3 text-sm text-muted">Each set's weight and reps become the targets. You can edit them after.</p>
      <TextField label="Routine name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      <SelectField label="Folder" value={folder} options={options} onChange={(e) => setFolder(e.target.value)} />
      {folder === NEW && (
        <TextField label="New folder name" required maxLength={120} value={newFolder} placeholder="Upper/Lower"
          onChange={(e) => setNewFolder(e.target.value)} />
      )}
      <ErrorText error={save.error ?? folders.error} />
      <Button variant="primary" type="submit" className="w-full"
        disabled={save.isPending || !name.trim() || (folder === NEW && !newFolder.trim())}>
        {save.isPending ? "Saving..." : "Save routine"}
      </Button>
    </form>
  );
}
