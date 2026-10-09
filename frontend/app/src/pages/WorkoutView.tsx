import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Sheet } from "../components/Sheet";
import { Badge, Button, ErrorText, Loading, Page, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { uuid7 } from "../lib/ids";
import { SET_TYPE, SET_TYPE_SHORT, clockTime, duration, longDate, minutes } from "../lib/format";
import { useMe } from "../lib/queries";
import type { RoutineDetail, WorkoutDetail, WorkoutSet } from "../lib/types";
import { useRoutineList } from "./Routines";

function setText(s: WorkoutSet): string {
  const parts: string[] = [];
  if (s.weight_value !== null) parts.push(`${s.weight_value} ${s.weight_unit}`);
  if (s.reps !== null) parts.push(s.weight_value !== null ? `x ${s.reps}` : `${s.reps} reps`);
  if (s.distance_value !== null) parts.push(`${s.distance_value} ${s.distance_unit}`);
  if (s.duration_seconds !== null) parts.push(duration(s.duration_seconds));
  return parts.join(" ") || "No data";
}

const SUPERSET = "ABCDEFGHIJ";

/** One workout, read-only. */
export default function WorkoutView() {
  const { id } = useParams();
  const me = useMe();
  const q = useQuery({ queryKey: ["workout", id], queryFn: () => get<WorkoutDetail>(`/api/workouts/${id}`) });
  const w = q.data;
  const tz = me.data?.timezone;
  const [saving, setSaving] = useState(false);

  return (
    <Page title={w?.title ?? "Workout"} back="/history">
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {w && (
        <>
          <p className="-mt-3 mb-4 text-muted">
            {longDate(w.workout_date)}, {clockTime(w.started_at, tz)}
            {minutes(w.started_at, w.ended_at) && `, ${minutes(w.started_at, w.ended_at)}`}
            {w.source === "hevy_import" && <> <Badge tone="muted">Imported from Hevy</Badge></>}
          </p>
          {w.notes && <p className="mb-4 whitespace-pre-line rounded-2xl bg-sunken p-3">{w.notes}</p>}
          <ol className="space-y-3">
            {w.exercises.map((e) => (
              <li key={e.id} className="rounded-2xl border border-line bg-surface p-4">
                <h2 className="display text-lg font-bold">{e.name}</h2>
                {e.superset_group !== null && (
                  <p className="text-sm font-bold text-accent-text">Superset {SUPERSET[e.superset_group] ?? e.superset_group + 1}</p>
                )}
                {e.logged_name !== e.name && <p className="text-sm text-muted">Logged as {e.logged_name}</p>}
                {e.notes && <p className="mt-1 whitespace-pre-line text-sm">{e.notes}</p>}
                <table className="mt-2 w-full text-left">
                  <thead className="sr-only">
                    <tr><th>Set</th><th>Type</th><th>Result</th><th>RPE</th></tr>
                  </thead>
                  <tbody>
                    {e.sets.map((s, i) => (
                      <tr key={s.id} className="border-t border-line">
                        <td className="num w-8 py-2 text-muted">{i + 1}</td>
                        <td className="w-8 py-2 font-bold text-accent-text">
                          <span aria-hidden>{SET_TYPE_SHORT[s.set_type]}</span>
                          <span className="sr-only">{SET_TYPE[s.set_type]}</span>
                        </td>
                        <td className="num py-2">{setText(s)}</td>
                        <td className="num py-2 text-right text-muted">{s.rpe !== null && `RPE ${s.rpe}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-muted">W is a warm-up, D a drop set, F a set to failure.</p>
          <Button className="mt-4 w-full" onClick={() => setSaving(true)}><ListPlus size={20} aria-hidden /> Save as routine</Button>
          <Sheet open={saving} title="Save as routine" onClose={() => setSaving(false)}>
            {saving && <SaveAsRoutine workout={w} />}
          </Sheet>
        </>
      )}
    </Page>
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
      navigate(`/routines/${r.id}`);
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
