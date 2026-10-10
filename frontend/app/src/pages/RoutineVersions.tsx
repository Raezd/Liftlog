import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Badge, ErrorText, Loading, Page } from "../components/ui";
import { get } from "../lib/api";
import type { ReactNode } from "react";
import { duration, setLabels, shortDate } from "../lib/format";
import type { RoutineDetail, RoutineSetT, RoutineVersion, SetType, VersionSummary } from "../lib/types";

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
                  <span className="block text-sm text-muted">Saved {when(v.created_at)}</span>
                </span>
                {v.current && <Badge>Current</Badge>}
              </Link>
              {v.workouts.length > 0 && (
                <div className="px-4 pb-3">
                  <p className="text-sm text-muted">Workouts that used it</p>
                  <ul>
                    {v.workouts.map((w) => (
                      <li key={w.id}>
                        <Link to={`/workouts/${w.id}`} className="flex min-h-11 items-center gap-2 text-accent-text underline underline-offset-2">
                          {shortDate(w.workout_date)}, {w.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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

/** Sets as numbered on screen: W for warm-ups, working sets from 1, drop and failure tagged. */
export function SetRows<S extends { id: string; set_type: SetType }>({ sets, text, extra }: {
  sets: S[]; text: (s: S) => string; extra?: (s: S) => ReactNode;
}) {
  const labels = setLabels(sets);
  return (
    <ol className="mt-2">
      {sets.map((s, i) => (
        <li key={s.id} className="num flex flex-wrap items-baseline gap-x-3 border-t border-line py-2">
          <span className="w-6 shrink-0 font-bold text-muted" aria-hidden>{labels[i].label}</span>
          <span className="sr-only">{labels[i].name}{labels[i].tag && `, ${labels[i].tag.toLowerCase()}`}: </span>
          <span className="min-w-0 flex-1">
            {text(s)}
            {labels[i].tag && <span className="ml-2 text-sm font-bold text-accent-text" aria-hidden>{labels[i].tag}</span>}
          </span>
          {extra?.(s)}
        </li>
      ))}
    </ol>
  );
}

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
            <SetRows sets={e.sets} text={targetText} />
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
          <p className="mt-4 text-sm text-muted">W is a warm-up. Working sets count from 1.</p>
        </>
      )}
    </Page>
  );
}
