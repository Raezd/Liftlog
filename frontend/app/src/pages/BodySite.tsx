import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import EChart, { dateAxis, palette } from "../components/EChart";
import { Badge, Card, ErrorText, Loading, Page } from "../components/ui";
import { inUnit, readings, valueText, type Reading } from "../lib/body";
import { longDate, shortDate } from "../lib/format";
import { useBody } from "../lib/queries";
import type { BodyCheckin, BodySite, LengthUnit, Side } from "../lib/types";
import { SIDE_NAME, sidesOf } from "./Body";

/** One site: a trend line on a date axis (left and right together for a paired site), and every value, newest first. */
export default function BodySitePage() {
  const { id = "" } = useParams();
  const q = useBody();
  const b = q.data;
  const site = b?.sites.find((s) => s.id === id);

  return (
    <Page title={site?.name ?? "Site"} back="/body">
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {b && !site && <p className="text-muted">Not found.</p>}
      {b && site && (
        <>
          {site.archived && <p className="-mt-3 mb-4"><Badge tone="muted">Archived</Badge></p>}
          <SiteTrend site={site} checkins={b.checkins} unit={b.length_unit} />
          <Values site={site} checkins={b.checkins} unit={b.length_unit} />
        </>
      )}
    </Page>
  );
}

function SiteTrend({ site, checkins, unit }: { site: BodySite; checkins: BodyCheckin[]; unit: LengthUnit }) {
  const chart = useMemo(() => {
    const p = palette();
    const sides = sidesOf(site);
    // Left in the accent, right in the second chart color with a dashed line and hollow diamonds, so color isn't the only cue.
    const style = (side: Side | null) => side === "right"
      ? { color: p.chart2, dashed: true, symbol: "diamond", fill: p.surface }
      : { color: p.accentText, dashed: false, symbol: "circle", fill: p.accentText };
    const series = sides.map((side) => {
      const s = style(side);
      const data = readings(checkins, site.id, side).map((r) => ({
        value: [Date.parse(`${r.date}T12:00:00Z`), inUnit(r.value, unit)], date: r.date, text: valueText(r.value, unit),
      }));
      return {
        name: side ? SIDE_NAME[side] : site.name, type: "line", data, symbol: s.symbol, symbolSize: 9,
        itemStyle: { color: s.fill, borderColor: s.color, borderWidth: 2 },
        lineStyle: { color: s.color, width: 2, type: s.dashed ? "dashed" : "solid" }, emphasis: { scale: 1.3 },
      };
    });
    const count = Math.max(...series.map((s) => s.data.length));
    return {
      count,
      option: {
        grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
        tooltip: {
          trigger: "item", backgroundColor: p.surface, borderColor: p.line, textStyle: { color: p.ink },
          formatter: (x: { seriesName: string; data: { date: string; text: string } }) =>
            `${longDate(x.data.date)}<br/>${site.paired ? `${x.seriesName}: ` : ""}<b>${x.data.text}</b>`,
        },
        xAxis: dateAxis(p),
        yAxis: { type: "value", scale: true, splitLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.muted, formatter: (v: number) => v.toLocaleString() } },
        series,
      },
    };
  }, [site, checkins, unit]);

  return (
    <Card title="Trend">
      {chart.count === 0 ? <p className="text-muted">No data yet.</p> : (
        <>
          {site.paired && (
            <ul className="mb-2 flex gap-4 text-sm" aria-hidden>
              <li className="flex items-center gap-2"><svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="var(--accent-text)" strokeWidth="2" /><circle cx="12" cy="5" r="4" fill="var(--accent-text)" /></svg>Left</li>
              <li className="flex items-center gap-2"><svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="4 3" /><path d="M12 1 L16 5 L12 9 L8 5 Z" fill="var(--surface)" stroke="var(--chart-2)" strokeWidth="2" /></svg>Right</li>
            </ul>
          )}
          <EChart option={chart.option} label={`${site.name} in ${unit} by date${site.paired ? ", left and right" : ""}. Every value is listed below.`} />
        </>
      )}
      <p className="mt-2 text-sm text-muted">In {unit === "in" ? "inches" : "centimeters"}, one point per check-in.</p>
    </Card>
  );
}

/** Every value, newest first; a paired site shows left and right side by side. */
function Values({ site, checkins, unit }: { site: BodySite; checkins: BodyCheckin[]; unit: LengthUnit }) {
  const bySide = sidesOf(site).map((side) => new Map(readings(checkins, site.id, side).map((r): [string, Reading] => [r.checkin_id, r])));
  const rows = checkins.filter((c) => bySide.some((m) => m.has(c.id)));
  if (!rows.length) return null;
  return (
    <section aria-label="Values">
      <h2 className="display mb-2 mt-6 text-lg font-bold">Values</h2>
      <table className="w-full text-left">
        <thead className="text-sm text-muted">
          <tr>
            <th scope="col" className="py-1 font-normal">Date</th>
            {sidesOf(site).map((side) => <th key={side ?? "one"} scope="col" className="py-1 text-right font-normal">{side ? SIDE_NAME[side] : unit}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((c) => (
            <tr key={c.id}>
              <th scope="row" className="py-2 font-normal">
                <Link to={`/body/checkins/${c.id}`} className="text-accent-text underline underline-offset-2">{shortDate(c.date)}</Link>
              </th>
              {bySide.map((m, i) => {
                const r = m.get(c.id);
                return <td key={i} className="num py-2 text-right font-bold">{r ? valueText(r.value, unit) : <span className="font-normal text-muted">No data</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
