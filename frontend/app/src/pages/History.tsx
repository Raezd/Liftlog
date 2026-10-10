import { BarChart3, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Loading, Page, Segmented, btn } from "../components/ui";
import { longDate, plural } from "../lib/format";
import { workoutDate, type StatWorkout } from "../lib/stats";
import { useStats } from "../lib/useStats";

const PAGE = 50;

/** Every workout, newest first, as a list or a month calendar. Workouts still
 *  on this phone show too, labeled. */
export default function History() {
  const { stats, failed } = useStats();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [shown, setShown] = useState(PAGE);

  return (
    <Page title="History" action={<Link to="/history/muscles" className={btn.secondary}><BarChart3 size={18} aria-hidden /> Muscles</Link>}>
      {!stats && (failed ? <p role="alert" className="font-bold text-over">Can't reach the server, and there's no copy on this device yet.</p> : <Loading />)}
      {stats && stats.workouts.length === 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p>No workouts yet.</p>
          <Link to="/settings/import" className={`${btn.primary} mt-3`}>Import from Hevy</Link>
        </div>
      )}
      {stats && stats.workouts.length > 0 && (
        <>
          <Segmented label="Show" name="history-view" value={view} onChange={setView} options={[["list", "List"], ["calendar", "Calendar"]]} />
          {view === "list" ? (
            <>
              <WorkoutList workouts={[...stats.workouts].reverse().slice(0, shown)} />
              {stats.workouts.length > shown && (
                <Button className="mt-4 w-full" onClick={() => setShown(shown + PAGE)}>Show older</Button>
              )}
            </>
          ) : (
            <Calendar workouts={stats.workouts} today={workoutDate(new Date().toISOString(), stats.me.timezone)} />
          )}
        </>
      )}
    </Page>
  );
}

export function StatusBadge({ w }: { w: Pick<StatWorkout, "status" | "source"> }) {
  if (w.status === "waiting") return <Badge>Waiting to upload</Badge>;
  if (w.status === "attention") return <Badge>Needs attention</Badge>;
  if (w.source === "hevy_import") return <Badge tone="muted">Imported</Badge>;
  return null;
}

function WorkoutList({ workouts, dates = true }: { workouts: StatWorkout[]; dates?: boolean }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {workouts.map((w) => {
        const sets = w.exercises.reduce((n, e) => n + e.sets.length, 0);
        return (
          <li key={w.id}>
            <Link to={`/workouts/${w.id}`} className="block px-4 py-3 hover:bg-sunken focus-visible:bg-sunken">
              <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
                {dates ? longDate(w.workout_date) : <span />}
                <StatusBadge w={w} />
              </span>
              <span className="block font-bold">{w.title}</span>
              <span className="block text-sm text-muted">{plural(w.exercises.length, "exercise")}, {plural(sets, "set")}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A month, Monday first, each workout day marked by its workout date. Tap a day for its workouts. */
function Calendar({ workouts, today }: { workouts: StatWorkout[]; today: string }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const byDay = new Map<string, StatWorkout[]>();
  for (const w of workouts) byDay.set(w.workout_date, [...(byDay.get(w.workout_date) ?? []), w]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const name = first.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(d.toISOString().slice(0, 7));
    setPicked(null);
  };
  const count = [...byDay.keys()].filter((d) => d.startsWith(month)).length;
  const chosen = picked ? byDay.get(picked) ?? [] : [];

  return (
    <section aria-label="Calendar">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Button onClick={() => shift(-1)}><ChevronLeft size={20} aria-hidden /><span className="sr-only">Previous month</span></Button>
        <h2 className="display text-lg font-bold" aria-live="polite">{name}</h2>
        <Button onClick={() => shift(1)}><ChevronRight size={20} aria-hidden /><span className="sr-only">Next month</span></Button>
      </div>
      <p className="mb-2 text-sm text-muted">{count ? `${plural(count, "day")} with a workout.` : "No workouts this month."}</p>
      <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={name}>
        {WEEKDAYS.map((d) => <div key={d} className="text-xs font-bold text-muted" role="columnheader">{d}</div>)}
        {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} />)}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const has = byDay.get(date)?.length ?? 0;
          const label = `${longDate(date)}${has ? `, ${plural(has, "workout")}` : ""}${date === today ? ", today" : ""}`;
          return (
            <button key={date} type="button" aria-label={label} aria-pressed={picked === date} onClick={() => setPicked(picked === date ? null : date)}
              className={`num flex aspect-square min-h-11 flex-col items-center justify-center rounded-xl text-sm ${has ? "bg-accent-strong font-bold text-white" : "bg-surface"} ${date === today ? "ring-2 ring-accent-text ring-inset" : ""} ${picked === date ? "outline-2 outline-offset-2 outline-ink" : ""}`}>
              <span aria-hidden>{i + 1}</span>
              {has > 1 && <span aria-hidden className="text-xs">x{has}</span>}
            </button>
          );
        })}
      </div>
      {picked && (
        <div className="mt-4">
          <h3 className="mb-2 font-bold">{longDate(picked)}</h3>
          {chosen.length ? <WorkoutList workouts={[...chosen].reverse()} dates={false} /> : <p className="text-muted">No workout this day.</p>}
        </div>
      )}
    </section>
  );
}
