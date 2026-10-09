import { useCallback, useEffect, useRef, useState } from "react";
import { cancelAlerts, RestAlarm, scheduleAlert } from "./restAlarm";

/**
 * scheduled: the phone will alert at endsAt
 * app:       the app is open, took the alert over, and will play it itself
 * fired:     the phone posted the notification (firedAt is when)
 * played:    the app played it in the foreground (firedAt is when)
 * done:      rest ended early with "Done resting"
 * cancelled: cancelled before it went off
 */
export type AlertStatus = "scheduled" | "app" | "fired" | "played" | "done" | "cancelled";
export type Alert = { id: number; endsAt: number; label: string; status: AlertStatus; firedAt?: number };
export type Run = { alarmStream: boolean; alerts: Alert[] };

const RUN_KEY = "liftlog.timerTest.run";
const ID_KEY = "liftlog.timerTest.nextId";
// How early the open app takes an alert over from the phone. Long enough for
// the cancel to land, short enough that locking the phone in between is rare,
// and covered anyway by rescheduling when the app goes to the background.
const TAKEOVER_MS = 600;

const pending = (a: Alert) => a.status === "scheduled" || a.status === "app";

function loadRun(): Run | null {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    return raw ? (JSON.parse(raw) as Run) : null;
  } catch {
    return null;
  }
}

function nextIds(n: number): number[] {
  let start = Number(localStorage.getItem(ID_KEY)) || 100;
  if (start + n > 1_000_000) start = 100;
  localStorage.setItem(ID_KEY, String(start + n));
  return Array.from({ length: n }, (_, i) => start + i);
}

export type Plan = { label: string; secondsFromNow: number }[];

export function useRestTimer() {
  const [run, setRun] = useState<Run | null>(loadRun);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  const save = useCallback((next: Run | null) => {
    runRef.current = next;
    setRun(next);
    if (next) localStorage.setItem(RUN_KEY, JSON.stringify(next));
    else localStorage.removeItem(RUN_KEY);
  }, []);

  const patch = useCallback((id: number, change: Partial<Alert>, only?: (a: Alert) => boolean) => {
    const cur = runRef.current;
    if (!cur) return;
    save({ ...cur, alerts: cur.alerts.map((a) => (a.id === id && (!only || only(a)) ? { ...a, ...change } : a)) });
  }, [save]);

  const start = useCallback(async (plan: Plan, alarmStream: boolean) => {
    setError(null);
    const old = runRef.current;
    if (old) await cancelAlerts(old.alerts.filter(pending).map((a) => a.id));
    const now = Date.now();
    const ids = nextIds(plan.length);
    const alerts: Alert[] = plan.map((p, i) => ({
      id: ids[i], endsAt: now + p.secondsFromNow * 1000, label: p.label, status: "scheduled",
    }));
    save({ alarmStream, alerts });
    try {
      for (const a of alerts) await scheduleAlert(a.id, a.endsAt, a.label, alarmStream);
    } catch {
      setError("The timer couldn't be set. Check the permissions above.");
      await cancelAlerts(ids);
      save({ alarmStream, alerts: alerts.map((a) => ({ ...a, status: "cancelled" })) });
    }
  }, [save]);

  /** Ends the current rest early. Later rests in a sequence keep going. */
  const doneResting = useCallback(async () => {
    const next = runRef.current?.alerts.find(pending);
    if (!next) return;
    patch(next.id, { status: "done" });
    await cancelAlerts([next.id]);
  }, [patch]);

  const cancel = useCallback(async () => {
    const cur = runRef.current;
    if (!cur) return;
    const ids = cur.alerts.filter(pending).map((a) => a.id);
    save({ ...cur, alerts: cur.alerts.map((a) => (pending(a) ? { ...a, status: "cancelled" } : a)) });
    await cancelAlerts(ids);
  }, [save]);

  const clear = useCallback(() => save(null), [save]);

  // While the app is open: take each alert over just before it's due, then
  // play it in the app at the end time, so the phone doesn't also post it.
  useEffect(() => {
    if (!run) return;
    const timers: number[] = [];
    const now = Date.now();
    for (const a of run.alerts) {
      if (a.status === "scheduled" && a.endsAt > now) {
        timers.push(window.setTimeout(async () => {
          if (document.visibilityState !== "visible") return;
          const { foreground } = await RestAlarm.isForeground();
          if (!foreground) return;
          patch(a.id, { status: "app" }, (x) => x.status === "scheduled");
          await cancelAlerts([a.id]);
        }, Math.max(0, a.endsAt - TAKEOVER_MS - now)));
      } else if (a.status === "app") {
        timers.push(window.setTimeout(() => {
          if (runRef.current?.alerts.find((x) => x.id === a.id)?.status !== "app") return;
          void RestAlarm.playNow({ alarmStream: run.alarmStream });
          patch(a.id, { status: "played", firedAt: Date.now() });
        }, Math.max(0, a.endsAt - now)));
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [run, patch]);

  // Leaving the app after a takeover: hand the alert back to the phone.
  useEffect(() => {
    const onHide = async () => {
      if (document.visibilityState !== "hidden") return;
      const cur = runRef.current;
      if (!cur) return;
      for (const a of cur.alerts.filter((x) => x.status === "app")) {
        patch(a.id, { status: "scheduled" });
        await scheduleAlert(a.id, Math.max(a.endsAt, Date.now() + 100), a.label, cur.alarmStream);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [patch]);

  // Record when the phone posted each alert, from the notifications showing now.
  useEffect(() => {
    const check = async () => {
      const cur = runRef.current;
      if (!cur || document.visibilityState !== "visible") return;
      const due = cur.alerts.filter((a) => a.status === "scheduled" && a.endsAt <= Date.now() + 1000);
      if (!due.length) return;
      const { notifications } = await RestAlarm.delivered();
      for (const a of due) {
        const n = notifications.find((x) => x.id === a.id);
        if (n) patch(a.id, { status: "fired", firedAt: n.postTime }, (x) => x.status === "scheduled");
      }
    };
    const t = window.setInterval(check, 1000);
    document.addEventListener("visibilitychange", check);
    void check();
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
    };
  }, [patch]);

  return { run, error, start, doneResting, cancel, clear };
}
