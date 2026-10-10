import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import EChart, { palette } from "../components/EChart";
import { Button, Card, Loading, Page, SelectField } from "../components/ui";
import { shortDate } from "../lib/format";
import { useMuscleLabels } from "../lib/queries";
import { UNASSIGNED, addDays, muscleSets, weekStart, workoutDate } from "../lib/stats";
import { useStats } from "../lib/useStats";

const WEEKS = 8;
const sets = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

/** Hard sets per muscle per week, from current muscle maps. No targets. */
export default function MuscleVolume() {
  const { stats, failed } = useStats();
  const known = useMuscleLabels();
  const label = (id: string) => {
    if (id === UNASSIGNED) return "Unassigned";
    const l = known(id);
    return l === id ? id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : l;
  };
  const thisWeek = stats ? weekStart(workoutDate(new Date().toISOString(), stats.me.timezone)) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const week = picked ?? thisWeek;
  const [muscle, setMuscle] = useState<string | null>(null);

  const weeks = useMemo(() => {
    if (!stats) return null;
    return muscleSets(stats.workouts, (id) => {
      const e = stats.exercises.get(id);
      return e && { primary: e.primary_muscles, secondary: e.secondary_muscles };
    });
  }, [stats]);

  if (!stats || !weeks || !week) {
    return <Page title="Muscles" back="/history">{failed ? <p role="alert" className="font-bold text-over">Can't reach the server, and there's no copy on this device yet.</p> : <Loading />}</Page>;
  }

  const rows = [...(weeks.get(week) ?? new Map<string, number>())].sort((a, b) =>
    (a[0] === UNASSIGNED ? 1 : 0) - (b[0] === UNASSIGNED ? 1 : 0) || b[1] - a[1] || label(a[0]).localeCompare(label(b[0])));
  const span = Array.from({ length: WEEKS }, (_, i) => addDays(week, (i - WEEKS + 1) * 7));
  const inSpan = new Set(span.flatMap((w) => [...(weeks.get(w)?.keys() ?? [])]));
  const choices = [...inSpan].sort((a, b) => (a === UNASSIGNED ? 1 : 0) - (b === UNASSIGNED ? 1 : 0) || label(a).localeCompare(label(b)));
  const shown = muscle && inSpan.has(muscle) ? muscle : choices.includes("chest") ? "chest" : choices[0] ?? null;

  return (
    <Page title="Muscles" back="/history">
      <p className="-mt-3 mb-4 text-muted">Hard sets per week: every set except warm-ups. A primary muscle counts 1, a secondary 0.5.</p>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Button onClick={() => setPicked(addDays(week, -7))}><ChevronLeft size={20} aria-hidden /><span className="sr-only">Previous week</span></Button>
        <h2 className="display text-center text-lg font-bold" aria-live="polite">
          {week === thisWeek ? "This week" : `Week of ${shortDate(week)}`}
          <span className="block text-sm font-normal text-muted">{shortDate(week)} to {shortDate(addDays(week, 6))}</span>
        </h2>
        <Button disabled={week === thisWeek} onClick={() => setPicked(addDays(week, 7))}><ChevronRight size={20} aria-hidden /><span className="sr-only">Next week</span></Button>
      </div>
      <Card title="Hard sets">
        {rows.length === 0 ? <p className="text-muted">No workouts this week.</p> : (
          <table className="w-full text-left">
            <thead><tr className="text-sm text-muted"><th className="py-1 font-normal">Muscle</th><th className="py-1 text-right font-normal">Sets</th></tr></thead>
            <tbody>
              {rows.map(([m, n]) => (
                <tr key={m} className="border-t border-line">
                  <td className="py-2">{label(m)}</td>
                  <td className="num py-2 text-right font-bold">{sets(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={`Last ${WEEKS} weeks`}>
        {shown === null ? <p className="text-muted">No workouts in these weeks.</p> : (
          <>
            <SelectField label="Muscle" value={shown} onChange={(e) => setMuscle(e.target.value)} options={choices.map((m): [string, string] => [m, label(m)])} />
            <WeeksChart span={span} values={span.map((w) => (weeks.has(w) ? weeks.get(w)!.get(shown) ?? 0 : null))} name={label(shown)} />
            <p className="mt-2 text-sm text-muted">Weeks start on Monday. A week with no workouts shows no bar.</p>
          </>
        )}
      </Card>
    </Page>
  );
}

function WeeksChart({ span, values, name }: { span: string[]; values: (number | null)[]; name: string }) {
  const option = useMemo(() => {
    const p = palette();
    const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    return {
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", backgroundColor: p.surface, borderColor: p.line, textStyle: { color: p.ink },
        formatter: (xs: { dataIndex: number }[]) => {
          const i = xs[0].dataIndex;
          return `Week of ${day(span[i])}<br/><b>${values[i] === null ? "No workouts" : `${sets(values[i]!)} sets`}</b>`;
        },
      },
      xAxis: { type: "category", data: span.map(day), axisLabel: { color: p.muted, hideOverlap: true }, axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false } },
      yAxis: { type: "value", minInterval: 1, splitLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.muted } },
      series: [{ type: "bar", data: values, itemStyle: { color: p.accent, borderRadius: [4, 4, 0, 0] } }],
    };
  }, [span, values]);
  const said = span.map((w, i) => `${w}: ${values[i] === null ? "no workouts" : sets(values[i]!)}`).join(", ");
  return <EChart option={option} label={`${name}, hard sets per week. ${said}`} height={220} />;
}
