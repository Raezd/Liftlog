import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Badge, ErrorText, Loading, Page } from "../components/ui";
import { get } from "../lib/api";
import { SET_TYPE, SET_TYPE_SHORT, duration } from "../lib/format";
import type { RoutineDetail, RoutineSetT, RoutineVersion, VersionSummary } from "../lib/types";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Every saved version of a routine, newest first. */
export function RoutineVersions() {
  const { id } = useParams();
  const routine = useQuery({ queryKey: ["routine", id], queryFn: () => get<RoutineDetail>(`/api/routines/${id}`) });
  const list = useQuery({ queryKey: ["versions", id], queryFn: () => get<VersionSummary[]>(`/api/routines/${id}/versions`) });
  return (
    <Page title="Versions" back={`/routines/${id}`}>
      {routine.data && <p className="-mt-3 mb-4 font-bold">{routine.data.name}</p>}
      <p className="mb-4 text-sm text-muted">Kept: the current version, and any version a workout used. Each version never changes once saved.</p>
      {list.isPending && <Loading />}
      <ErrorText error={list.error} />
      {list.data && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {list.data.map((v) => (
            <li key={v.id}>
              <Link to={`/routines/${id}/versions/${v.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-sunken focus-visible:bg-sunken">
                <span>
                  <span className="block font-bold">Version {v.number}</span>
                  <span className="block text-sm text-muted">{when(v.created_at)}</span>
                </span>
                {v.current && <Badge>Current</Badge>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function targetText(s: RoutineSetT): string {
  const parts: string[] = [];
  if (s.reps_min !== null) parts.push(s.reps_min === s.reps_max ? `${s.reps_min} reps` : `${s.reps_min} to ${s.reps_max} reps`);
  if (s.weight_value !== null) parts.push(`${s.weight_value} ${s.weight_unit}`);
  if (s.distance_value !== null) parts.push(`${s.distance_value} ${s.distance_unit}`);
  if (s.duration_seconds !== null) parts.push(duration(s.duration_seconds));
  if (s.rpe !== null) parts.push(`RPE ${s.rpe}`);
  return parts.join(", ") || "No target";
}

const SUPERSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A routine version, read-only. */
export function VersionView({ v }: { v: RoutineVersion }) {
  return (
    <ol className="space-y-3">
      {v.exercises.map((e) => {
        const rest = e.superset_group !== null ? v.superset_rests[String(e.superset_group)] : undefined;
        return (
          <li key={e.id} className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="display text-lg font-bold">{e.name}</h2>
            {e.superset_group !== null && (
              <p className="text-sm font-bold text-accent-text">
                Superset {SUPERSET[e.superset_group] ?? e.superset_group + 1}{rest !== undefined && `, ${duration(rest)} rest after each round`}
              </p>
            )}
            {e.rest_seconds !== null && <p className="text-sm text-muted">Rest {duration(e.rest_seconds)}</p>}
            {e.notes && <p className="mt-1 whitespace-pre-line text-sm">{e.notes}</p>}
            <ol className="mt-2">
              {e.sets.map((s, i) => (
                <li key={s.id} className="num flex gap-3 border-t border-line py-2">
                  <span className="w-6 text-muted">{i + 1}</span>
                  <span className="w-6 font-bold text-accent-text">
                    <span aria-hidden>{SET_TYPE_SHORT[s.set_type]}</span><span className="sr-only">{SET_TYPE[s.set_type]}</span>
                  </span>
                  <span>{targetText(s)}</span>
                </li>
              ))}
            </ol>
          </li>
        );
      })}
      {v.exercises.length === 0 && <p className="text-muted">No exercises.</p>}
    </ol>
  );
}

export function RoutineVersionPage() {
  const { id, vid } = useParams();
  const q = useQuery({ queryKey: ["version", vid], queryFn: () => get<RoutineVersion>(`/api/routines/${id}/versions/${vid}`) });
  return (
    <Page title={q.data ? `Version ${q.data.number}` : "Version"} back={`/routines/${id}/versions`}>
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {q.data && (
        <>
          <p className="-mt-3 mb-4 text-muted">Saved {when(q.data.created_at)}</p>
          <VersionView v={q.data} />
          <p className="mt-4 text-sm text-muted">W is a warm-up, D a drop set, F a set to failure.</p>
        </>
      )}
    </Page>
  );
}
