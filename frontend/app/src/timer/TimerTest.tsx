import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMe } from "../lib/queries";
import { lastAlertSetting, rememberAlertSetting } from "./alertSetting";
import { ensureNotificationPermission, type NativeStatus, RestAlarm } from "./restAlarm";
import { type Alert, type Plan, useRestTimer } from "./useRestTimer";

/**
 * Temporary test screen for the Spec 2 rest timer prototype. It goes away
 * when the real workout screen is built. Alerts use the "play through silent
 * mode" setting from Settings.
 */

const SINGLES = [10, 60, 90, 180];
// Five 2:30 rests with 30 seconds of "work" between them.
const SEQUENCE: Plan = Array.from({ length: 5 }, (_, i) => ({
  label: `Rest ${i + 1} of 5`,
  secondsFromNow: 150 + i * 180,
}));
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Re-runs fn when the app comes back to the front or the network returns. */
function useOnReturn(fn: () => void) {
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && fn();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", fn);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", fn);
    };
  }, [fn]);
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl border border-line bg-surface p-4" aria-label={title}>
      <h2 className="display mb-3 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

const button = "min-h-11 rounded-xl px-4 font-bold disabled:opacity-50";
const primary = `${button} bg-accent-strong text-white`;
const secondary = `${button} border border-line bg-sunken`;

function Connection() {
  const me = useMe();
  const refetch = me.refetch;
  useOnReturn(useCallback(() => void refetch(), [refetch]));
  const online = me.isSuccess;
  return (
    <Card title="Server">
      <p className="flex items-center gap-2">
        <span aria-hidden className={`inline-block size-2.5 rounded-full ${online ? "bg-accent" : "bg-over"}`} />
        {me.isPending ? "Checking..." : online ? `Connected as ${me.data.login}` : me.error?.message}
      </p>
      {!online && !me.isPending && (
        <p className="mt-1 text-sm text-muted">That's fine for the timer. It works with no signal.</p>
      )}
      <button type="button" className={`${secondary} mt-3`} onClick={() => void refetch()}>Check again</button>
    </Card>
  );
}

function Permissions() {
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const refresh = useCallback(() => {
    RestAlarm.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    // First launch: Android asks for notification permission once.
    ensureNotificationPermission().catch(() => {}).finally(refresh);
  }, [refresh]);
  useOnReturn(refresh);
  if (!status) return null;

  const problems: { text: string; kind: "notifications" | "exactAlarms" }[] = [];
  if (!status.notifications) {
    problems.push({
      kind: "notifications",
      text: "Notifications are off, so the timer can't alert you. Tap Open settings, then turn on Notifications for Liftlog.",
    });
  } else if (!status.channelOn || !status.alarmChannelOn) {
    problems.push({
      kind: "notifications",
      text: "A rest timer alert is turned off. Tap Open settings, then turn on both Rest timer alerts.",
    });
  }
  if (!status.exactAlarms) {
    problems.push({
      kind: "exactAlarms",
      text: "Liftlog isn't allowed to set alarms, so the timer could be late. Tap Open settings, then turn on Alarms and reminders.",
    });
  }

  return (
    <>
      {problems.map((p) => (
        <section key={p.text} role="alert" className="mb-4 rounded-2xl border-2 border-over bg-surface p-4">
          <p>{p.text}</p>
          <button type="button" className={`${primary} mt-3`} onClick={() => RestAlarm.openSettings({ kind: p.kind })}>
            Open settings
          </button>
        </section>
      ))}
      <p className="mb-4 text-sm text-muted">
        Ringer: {status.ringer === "normal" ? "sound on" : status.ringer}
      </p>
    </>
  );
}

function describe(a: Alert): string {
  const off = a.firedAt !== undefined ? (a.firedAt - a.endsAt) / 1000 : 0;
  const delta = `${Math.abs(off).toFixed(1)} s ${off >= 0 ? "late" : "early"}`;
  switch (a.status) {
    case "fired": return `Went off, ${delta}`;
    case "played": return `Played in the app, ${delta}`;
    case "app": return "Will play in the app";
    case "done": return "Ended early";
    case "cancelled": return "Cancelled";
    case "scheduled": return a.endsAt > Date.now() ? "Waiting" : "No record (cleared?)";
  }
}

export function TimerTest() {
  const me = useMe();
  const alarmStream = me.data?.play_through_silent ?? lastAlertSetting();
  useEffect(() => {
    if (me.data) rememberAlertSetting(me.data.play_through_silent);
  }, [me.data]);
  const { run, error, start, doneResting, cancel, clear } = useRestTimer();
  const next = run?.alerts.find((a) => a.status === "scheduled" || a.status === "app");
  const now = useNow(!!next);
  const go = (plan: Plan) => void start(plan, alarmStream);

  return (
    <>
      <header className="mb-4">
        <Link to="/settings" className="mb-1 inline-flex min-h-11 items-center text-muted">Back to settings</Link>
        <h1 className="display text-3xl font-extrabold text-accent-text">Rest timer test</h1>
        <p className="text-sm text-muted">Version {__BUILD_ID__}</p>
      </header>

      <Permissions />
      <Connection />

      <Card title="Timer">
        <p className="num display mb-1 text-center text-6xl font-extrabold tabular-nums" aria-live="off">
          {next ? mmss(next.endsAt - now) : "Ready"}
        </p>
        <p className="mb-4 min-h-6 text-center text-muted">
          {next ? `${next.label}, ends at ${clock(next.endsAt)}` : ""}
        </p>
        <div className="grid grid-cols-4 gap-2">
          {SINGLES.map((s) => (
            <button key={s} type="button" className={primary} onClick={() => go([{ label: `${s} s timer`, secondsFromNow: s }])}>
              {s} s
            </button>
          ))}
        </div>
        <button type="button" className={`${secondary} mt-2 w-full`} onClick={() => go(SEQUENCE)}>
          Five 2:30 rests, 30 s apart
        </button>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button type="button" className={secondary} disabled={!next} onClick={() => void doneResting()}>
            Done resting
          </button>
          <button type="button" className={secondary} disabled={!next} onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
        {error && <p role="alert" className="mt-3 font-bold text-over">{error}</p>}
      </Card>

      <Card title="Alert sound">
        <p>
          {alarmStream ? "Plays through silent mode." : "Follows your ringer."}{" "}
          <Link to="/settings" className="font-bold text-accent-text underline">Change in Settings</Link>
        </p>
        {next && <p className="mt-2 text-sm text-muted">A change applies to the next timer.</p>}
      </Card>

      {run && (
        <Card title="Results">
          <p className="mb-2 text-sm text-muted">
            {run.alarmStream ? "Played through silent mode" : "Followed the ringer"}
          </p>
          <ul className="divide-y divide-line">
            {run.alerts.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 py-2">
                <span>{a.label}<span className="block text-sm text-muted">due {clock(a.endsAt)}</span></span>
                <span className="text-right font-bold">{describe(a)}</span>
              </li>
            ))}
          </ul>
          {!next && <button type="button" className={`${secondary} mt-3`} onClick={clear}>Clear</button>}
        </Card>
      )}
    </>
  );
}
