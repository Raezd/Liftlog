import { ChevronRight, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, Loading, Page, btn } from "../components/ui";
import { METHODS_IN_TEXT, changeText, fatTrend, siteTrend, valueText, type FatReading, type Reading, type Trend } from "../lib/body";
import { plural, shortDate } from "../lib/format";
import { useBody } from "../lib/queries";
import type { BodyCheckin, BodySite, LengthUnit, Side } from "../lib/types";
import { useOnline } from "../lib/useOnline";

export const NEEDS_CONNECTION = "Adding and editing measurements need a connection.";
export const sidesOf = (s: BodySite): (Side | null)[] => (s.paired ? ["left", "right"] : [null]);
export const SIDE_NAME: Record<Side, string> = { left: "Left", right: "Right" };

/** The Body tab: each site's latest value and how it's changed, body fat, and every check-in. Works offline from the copy. */
export default function Body() {
  const q = useBody();
  const online = useOnline();
  const b = q.data;
  const active = b?.sites.filter((s) => !s.archived) ?? [];

  return (
    <Page title="Body" action={online
      ? <Link to="/body/checkins/new" className={btn.primary}><Plus size={18} aria-hidden /> Add</Link>
      : <Button variant="primary" disabled aria-describedby="body-offline"><Plus size={18} aria-hidden /> Add</Button>}>
      {!online && <p id="body-offline" className="-mt-3 mb-4 text-sm text-muted">{NEEDS_CONNECTION}</p>}
      {q.isPending && <Loading />}
      {!b && <ErrorText error={q.error} />}
      {b && (
        <>
          <Card title="Measurements">
            {active.length === 0 && <p className="text-muted">No sites. Add one under Manage sites.</p>}
            <ul className="divide-y divide-line">
              {active.map((s) => <SiteRow key={s.id} site={s} checkins={b.checkins} unit={b.length_unit} />)}
            </ul>
            <p className="mt-3 text-sm text-muted">
              Showing {b.length_unit === "in" ? "inches" : "centimeters"}. Change it in <Link to="/settings" className="underline underline-offset-2">Settings</Link>.
            </p>
          </Card>

          <Card title="Body fat"><BodyFat checkins={b.checkins} /></Card>

          <h2 className="display mb-2 mt-6 text-lg font-bold">Check-ins</h2>
          {b.checkins.length === 0 && <p className="mb-4 text-muted">No check-ins yet.</p>}
          <ul className="mb-4 space-y-2">
            {b.checkins.map((c) => (
              <li key={c.id}>
                <Link to={`/body/checkins/${c.id}`} className="flex min-h-11 items-center justify-between gap-2 rounded-2xl border border-line bg-surface p-3 hover:bg-sunken">
                  <span>
                    <span className="block font-bold">{shortDate(c.date)}</span>
                    <span className="block text-sm text-muted">{summary(c)}</span>
                  </span>
                  <ChevronRight size={20} aria-hidden className="shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/body/sites" className={`${btn.secondary} w-full`}>Manage sites</Link>
        </>
      )}
    </Page>
  );
}

function summary(c: BodyCheckin): string {
  const sites = new Set(c.values.map((v) => v.site_id)).size;
  const parts = [];
  if (sites) parts.push(plural(sites, "site"));
  if (c.body_fat_pct !== null && c.body_fat_method) parts.push(`body fat ${c.body_fat_pct}% (${METHODS_IN_TEXT[c.body_fat_method]})`);
  return parts.join(", ");
}

function SiteRow({ site, checkins, unit }: { site: BodySite; checkins: BodyCheckin[]; unit: LengthUnit }) {
  return (
    <li>
      <Link to={`/body/sites/${site.id}`} className="-mx-2 flex min-h-11 items-start justify-between gap-2 rounded-xl px-2 py-2 hover:bg-sunken">
        <span className="min-w-0 flex-1">
          <span className="block font-bold">{site.name}</span>
          {sidesOf(site).map((side) => {
            const t = siteTrend(checkins, site.id, side, unit);
            return (
              <span key={side ?? "one"} className="block">
                {side && <span className="text-muted">{SIDE_NAME[side]}: </span>}
                {t ? <TrendText t={t} text={(r) => valueText(r.value, unit)} unit={unit} /> : <span className="text-muted">No data</span>}
              </span>
            );
          })}
        </span>
        <ChevronRight size={20} aria-hidden className="mt-0.5 shrink-0 text-muted" />
      </Link>
    </li>
  );
}

/** The latest value and its date, then its changes. */
function TrendText<R extends Reading | FatReading>({ t, text, unit }: { t: Trend<R>; text: (r: R) => string; unit: string }) {
  return (
    <>
      <span className="num font-bold">{text(t.latest)}</span> <span className="text-sm text-muted">{shortDate(t.latest.date)}</span>
      {t.sincePrevious !== null && t.previous && (
        <span className="block text-sm"><span className="num">{changeText(t.sincePrevious, unit)}</span> since {shortDate(t.previous.date)}</span>
      )}
      {t.sinceFirst !== null && t.first && t.first !== t.previous && (
        <span className="block text-sm"><span className="num">{changeText(t.sinceFirst, unit)}</span> since {shortDate(t.first.date)}, the first</span>
      )}
    </>
  );
}

function BodyFat({ checkins }: { checkins: BodyCheckin[] }) {
  const t = fatTrend(checkins);
  if (!t) return <p className="text-muted">No data</p>;
  const other = t.previous && t.previous.method !== t.latest.method ? t.previous : null;
  return (
    <p>
      <TrendText t={t} unit="points" text={(r) => `${r.pct}%`} />
      <span className="block text-sm text-muted">By {METHODS_IN_TEXT[t.latest.method]}.</span>
      {other && (
        <span className="block text-sm text-muted">
          The reading before was by {METHODS_IN_TEXT[other.method]}, so there's no change from it. Changes only compare readings by the same method.
        </span>
      )}
    </p>
  );
}
