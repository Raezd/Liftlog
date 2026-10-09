import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useApi } from "../api";
import { ensureNotificationPermission, type NativeStatus, type Path, RestAlarm } from "./restAlarm";
import { type Alert, type Plan, useRestTimer } from "./useRestTimer";

/**
 * Temporary test screen for the Spec 2 rest timer prototype. It goes away
 * when the real workout screen is built.
 */

const SINGLES = [10, 60, 90, 180];
// Five 2:30 rests with 30 seconds of "work" between them.
const SEQUENCE: Plan = Array.from({ length: 5 }, (_, i) => ({
  label: `Rest ${i + 1} of 5`,
  secondsFromNow: 150 + i * 180,
}));
const SETTINGS_KEY = "liftlog.timerTest.settings";

type Me = { login: string };

function loadSettings(): { path: Path; alarmStream: boolean } {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "");
    return { path: s.path === "B" ? "B" : "A", alarmStream: !!s.alarmStream };
  } catch {
    return { path: "A", alarmStream: false };
  }
}

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
  const [me, reload] = useApi<Me>("/api/me");
  useOnReturn(reload);
  const online = me.state === "ok";
  return (
    <Card title="Server">
      <p className="flex items-center gap-2">
        <span aria-hidden className={`inline-block size-2.5 rounded-full ${online ? "bg-accent" : "bg-over"}`} />
        {me.state === "loading" ? "Checking..." : online ? `Connected as ${me.data.login}` : me.message}
      </p>
      {!online && me.state !== "loading" && (
        <p className="mt-1 text-sm text-muted">That's fine for the timer. It works with no signal.</p>
      )}
      <button type="button" className={`${secondary} mt-3`} onClick={reload}>Check again</button>
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
  const [settings, setSettings] = useState(loadSettings);
  const { run, error, start, doneResting, cancel, clear } = useRestTimer();
  const next = run?.alerts.find((a) => a.status === "scheduled" || a.status === "app");
  const now = useNow(!!next);

  const update = (s: Partial<typeof settings>) => {
    const merged = { ...settings, ...s };
    setSettings(merged);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  };
  const go = (plan: Plan) => void start(plan, settings.path, settings.alarmStream);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="mb-4">
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

      <Card title="Test settings">
        <fieldset disabled={!!next}>
          <legend className="mb-2 text-muted">How the alert is scheduled</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["A", "B"] as const).map((p) => (
              <label key={p} className={`${secondary} flex items-center justify-center gap-2 ${settings.path === p ? "border-accent ring-2 ring-accent" : ""}`}>
                <input type="radio" name="path" className="sr-only" checked={settings.path === p} onChange={() => update({ path: p })} />
                {p === "A" ? "A: notification" : "B: alarm clock"}
              </label>
            ))}
          </div>
          <label className="mt-4 flex min-h-11 items-center justify-between gap-3">
            <span>
              Use alarm sound
              <span className="block text-sm text-muted">Rings even on vibrate or silent</span>
            </span>
            <input type="checkbox" className="size-6 accent-[var(--accent-strong)]" checked={settings.alarmStream}
              onChange={(e) => update({ alarmStream: e.target.checked })} />
          </label>
        </fieldset>
        {next && <p className="mt-2 text-sm text-muted">Settings apply to the next timer.</p>}
      </Card>

      {run && (
        <Card title="Results">
          <p className="mb-2 text-sm text-muted">
            Path {run.path}, {run.alarmStream ? "alarm sound" : "follows ringer"}
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
    </main>
  );
}
