import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EChart, { palette } from "../components/EChart";
import { Card, ErrorText, Loading, Page, Segmented, btn } from "../components/ui";
import { get } from "../lib/api";
import { EQUIPMENT, LOGGING, duration, longDate, shortDate } from "../lib/format";
import { cached } from "../lib/offline";
import { useMuscleLabels } from "../lib/queries";
import { RECORD_TYPES, fromKg, sessions, type ExerciseRecords, type Session } from "../lib/stats";
import type { DistanceUnit, Exercise, LoggingType, WeightUnit } from "../lib/types";
import { RECORD_NAME, recordText, setText, useStats } from "../lib/useStats";
import { formatVolume } from "../lib/volume";
import { StatusBadge } from "./History";
import { SetRows } from "./RoutineVersions";

type Metric = "e1rm" | "heaviest" | "volume" | "most_reps" | "longest_time" | "longest_distance";

const METRICS: Record<LoggingType, Metric[]> = {
  weight_reps: ["e1rm", "heaviest", "volume"],
  weighted_bodyweight: ["heaviest", "volume"],
  bodyweight_reps: ["most_reps"],
  duration: ["longest_time"],
  distance_duration: ["longest_distance"],
  assisted_bodyweight: [],
};

const METRIC_NAME: Record<Metric, string> = {
  e1rm: "Est. 1RM", heaviest: "Heaviest", volume: "Volume", most_reps: "Most reps", longest_time: "Longest set", longest_distance: "Longest distance",
};

const M_PER: Record<DistanceUnit, number> = { mi: 1609.344, km: 1000 };

/** One exercise: its records, a trend chart, and every session, newest first. */
export default function ExerciseView() {
  const { id = "" } = useParams();
  const { stats, failed } = useStats();
  const ex = useQuery({
    queryKey: ["exercise-basic", id],
    queryFn: cached(() => get<Exercise>(`/api/exercises/${id}`), (c) => c.exercises.find((e) => e.id === id)),
  });
  const e = stats?.exercises.get(id) ?? ex.data;
  const list = useMemo(() => (stats ? sessions(stats.workouts, id) : []), [stats, id]);
  const label = useMuscleLabels();

  return (
    <Page title={e?.name ?? "Exercise"} back="/library"
      action={e && <Link to={`/library/${id}`} className={btn.secondary}><Pencil size={18} aria-hidden /> Edit</Link>}>
      {!e && !ex.error && <Loading />}
      {!e && <ErrorText error={ex.error} />}
      {e && (
        <>
          <p className="-mt-3 mb-4 text-muted">
            {EQUIPMENT[e.equipment]}, {LOGGING[e.logging_type].toLowerCase()}.{" "}
            {e.primary_muscles.length ? e.primary_muscles.map(label).join(", ") : "Muscles unassigned"}
            {e.secondary_muscles.length > 0 && `; also ${e.secondary_muscles.map(label).join(", ")}`}
          </p>
          {!stats && (failed ? <p role="alert" className="font-bold text-over">Can't reach the server, and there's no copy on this device yet.</p> : <Loading />)}
          {stats && list.length === 0 && <p className="text-muted">No sessions yet.</p>}
          {stats && list.length > 0 && (
            <>
              <Records r={stats.records.byExercise.get(id)} logging={e.logging_type} unit={stats.me.weight_unit} />
              <Trend list={list} logging={e.logging_type} unit={stats.me.weight_unit} distance={stats.me.distance_unit} />
              <h2 className="display mb-2 mt-6 text-lg font-bold">Sessions</h2>
              <ol className="space-y-3">
                {list.map((s) => (
                  <li key={s.workout.id} className="rounded-2xl border border-line bg-surface p-4">
                    <Link to={`/workouts/${s.workout.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:underline">
                      <span><span className="block font-bold">{longDate(s.workout.workout_date)}</span><span className="block text-sm text-muted">{s.workout.title}</span></span>
                      <StatusBadge w={s.workout} />
                    </Link>
                    <SetRows sets={s.sets} text={setText} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </Page>
  );
}

function Records({ r, logging, unit }: { r: ExerciseRecords | undefined; logging: LoggingType; unit: WeightUnit }) {
  const types = RECORD_TYPES[logging];
  if (!types.length) return <Card title="Records"><p className="text-muted">No records for assisted exercises yet.</p></Card>;
  if (!r) return null;
  const frontier = r.frontier.slice(0, 8);
  return (
    <Card title="Records">
      <dl className="space-y-3">
        {types.filter((t) => t !== "reps_at_weight").map((t) => {
          const p = r.best[t];
          return (
            <div key={t}>
              <dt className="text-sm text-muted">{RECORD_NAME[t]}</dt>
              <dd className="num font-bold">
                {p ? <>{recordText(p, unit)} <Link to={`/workouts/${p.workout_id}`} className="font-normal text-accent-text underline underline-offset-2">{shortDate(p.workout_date)}</Link></> : "No data"}
              </dd>
            </div>
          );
        })}
        {types.includes("reps_at_weight") && (
          <div>
            <dt className="text-sm text-muted">Most reps at each weight</dt>
            <dd>
              {frontier.length ? (
                <ul className="num">
                  {frontier.map((p) => (
                    <li key={p.set!.id}>
                      <span className="font-bold">{setText(p.set!)}</span>{" "}
                      <Link to={`/workouts/${p.workout_id}`} className="text-accent-text underline underline-offset-2">{shortDate(p.workout_date)}</Link>
                    </li>
                  ))}
                </ul>
              ) : "No data"}
            </dd>
          </div>
        )}
      </dl>
      <p className="mt-3 text-sm text-muted">Records count every set except warm-ups. A 1RM is estimated from sets of 10 reps or fewer.</p>
    </Card>
  );
}

function Trend({ list, logging, unit, distance }: { list: Session[]; logging: LoggingType; unit: WeightUnit; distance: DistanceUnit }) {
  const metrics = METRICS[logging];
  const [picked, setPicked] = useState<Metric | null>(null);
  const metric = picked && metrics.includes(picked) ? picked : metrics[0];

  const option = useMemo(() => {
    if (!metric) return null;
    const p = palette();
    const value = (s: Session): number | null => {
      switch (metric) {
        case "e1rm": return s.e1rm === null ? null : round(fromKg(s.e1rm, unit));
        case "heaviest": return s.heaviest === null ? null : round(fromKg(s.heaviest, unit));
        case "volume": return s.volume === null ? null : Math.round(fromKg(s.volume, unit));
        case "most_reps": return s.most_reps;
        case "longest_time": return s.longest_time;
        case "longest_distance": return s.longest_distance === null ? null : Math.round((s.longest_distance / M_PER[distance]) * 100) / 100;
      }
    };
    const text = (v: number) => (metric === "longest_time" ? duration(v) : metric === "most_reps" ? `${v} reps`
      : metric === "longest_distance" ? `${v} ${distance}` : metric === "volume" ? formatVolume(v, unit) : `${v.toLocaleString()} ${unit}`);
    const points = [...list].reverse().flatMap((s) => {
      const v = value(s);
      if (v === null) return [];
      const imported = s.workout.source === "hevy_import";
      return [{
        value: [Date.parse(`${s.workout.workout_date}T12:00:00Z`), v], date: s.workout.workout_date, imported,
        symbol: imported ? "diamond" : "circle", symbolSize: imported ? 11 : 8,
        itemStyle: imported ? { color: p.surface, borderColor: p.accentText, borderWidth: 2 } : { color: p.accentText },
      }];
    });
    return {
      count: points.length,
      option: {
        grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
        tooltip: {
          trigger: "item", backgroundColor: p.surface, borderColor: p.line,
          textStyle: { color: p.ink },
          formatter: (x: { data: { date: string; imported: boolean; value: [number, number] } }) =>
            `${longDate(x.data.date)}<br/><b>${text(x.data.value[1])}</b>${metric === "e1rm" ? " estimated" : ""}${x.data.imported ? "<br/>Imported" : ""}`,
        },
        xAxis: { type: "time", axisLabel: { color: p.muted, hideOverlap: true }, axisLine: { lineStyle: { color: p.line } }, splitLine: { show: false } },
        yAxis: {
          type: "value", scale: true, splitLine: { lineStyle: { color: p.line } },
          axisLabel: { color: p.muted, formatter: (v: number) => (metric === "longest_time" ? duration(v) : v.toLocaleString()) },
        },
        series: [{ type: "line", data: points, lineStyle: { color: p.accent, width: 2 }, emphasis: { scale: 1.3 } }],
      },
    };
  }, [list, metric, unit, distance]);

  if (!metric || !option) return null;
  const unitText = metric === "e1rm" || metric === "heaviest" ? unit : metric === "volume" ? `${unit}, per session` : metric === "longest_distance" ? distance : "";
  return (
    <Card title="Trend">
      {metrics.length > 1 && (
        <Segmented label="Show" name="trend-metric" value={metric} onChange={setPicked} options={metrics.map((m): [Metric, string] => [m, METRIC_NAME[m]])} />
      )}
      {option.count === 0 ? <p className="text-muted">No data for this yet.</p> : (
        <EChart option={option.option} label={`${METRIC_NAME[metric]} by workout date, ${option.count} sessions`} />
      )}
      <p className="mt-2 text-sm text-muted">
        Best each session{unitText && ` (${unitText})`}.{metric === "e1rm" && " Estimated."} Hollow diamonds are workouts imported from Hevy.
      </p>
    </Card>
  );
}

const round = (v: number) => Math.round(v * 10) / 10;
