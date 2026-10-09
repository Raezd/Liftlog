import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Badge, ErrorText, Loading, Page } from "../components/ui";
import { get } from "../lib/api";
import { SET_TYPE, SET_TYPE_SHORT, clockTime, duration, longDate, minutes } from "../lib/format";
import { useMe } from "../lib/queries";
import type { WorkoutDetail, WorkoutSet } from "../lib/types";

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

  return (
    <Page title={w?.title ?? "Workout"} back="/">
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
        </>
      )}
    </Page>
  );
}
