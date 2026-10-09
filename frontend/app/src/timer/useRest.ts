import { useEffect } from "react";
import { currentActive, update } from "../lib/active";
import type { ActiveWorkout, Rest } from "../lib/session";
import { lastAlertSetting } from "./alertSetting";
import { cancelAlerts, RestAlarm, scheduleAlert } from "./restAlarm";

/**
 * The workout's rest timer. A rest is an absolute end time saved with the
 * workout, and the phone alerts at that time through a scheduled local
 * notification (path A), locked or not, signal or not.
 *
 * While the app is open in front, it takes the alert over just before it's
 * due, cancels the notification, and plays the same sound and vibration
 * itself, so there's no duplicate. Leaving the app hands it back.
 */

// How early the open app takes an alert over from the phone.
const TAKEOVER_MS = 600;
// Notification ids for rest alerts: 2000 and up, counted per workout.
const ID_BASE = 2000;

const alarmStream = () => lastAlertSetting();

async function schedule(r: Rest) {
  await scheduleAlert(r.alertId, Math.max(r.endsAt, Date.now() + 100), r.label, alarmStream());
}

/** The workout with a new rest started (any running one replaced). Pair with afterChange(). */
export function withRest(w: ActiveWorkout, seconds: number, key: string, label: string): ActiveWorkout {
  const rest: Rest = { endsAt: Date.now() + seconds * 1000, seconds, alertId: ID_BASE + w.nextAlertId, label, key, takenOver: false };
  return { ...w, rest, nextAlertId: w.nextAlertId + 1 };
}

/** Tells the phone about a rest change, after it's saved: cancel the old alert, schedule the new one. */
export async function afterChange(before: Rest | null, after: Rest | null): Promise<void> {
  if (before && (!after || before.alertId !== after.alertId || before.endsAt !== after.endsAt)) {
    await cancelAlerts([before.alertId]);
  }
  if (after && !after.takenOver && (!before || before.alertId !== after.alertId || before.endsAt !== after.endsAt)) {
    await schedule(after).catch(() => {});
  }
}

/** Ends the rest now (skip, uncomplete, discard, finish). */
export async function stopRest(): Promise<void> {
  const w = currentActive();
  const r = w?.rest ?? null;
  if (!r) return;
  await update((x) => ({ ...x, rest: null }));
  await cancelAlerts([r.alertId]);
}

/** Moves the running rest's end by `seconds` (the plus and minus buttons). */
export async function shiftRest(seconds: number): Promise<void> {
  const before = currentActive()?.rest ?? null;
  if (!before) return;
  const after: Rest = { ...before, endsAt: Math.max(Date.now() + 1000, before.endsAt + seconds * 1000) };
  await update((x) => ({ ...x, rest: after }));
  await afterChange(before, after);
}

/** Runs the in-app takeover for the current rest. Mount once on the workout screen. */
export function useRestAlarm(rest: Rest | null) {
  useEffect(() => {
    if (!rest) return;
    const now = Date.now();
    const timers: number[] = [];
    if (!rest.takenOver) {
      if (rest.endsAt <= now) {
        // The phone already alerted while the app was away.
        void update((x) => (x.rest?.alertId === rest.alertId ? { ...x, rest: null } : x));
      } else {
        timers.push(window.setTimeout(async () => {
          if (document.visibilityState !== "visible") return;
          const { foreground } = await RestAlarm.isForeground().catch(() => ({ foreground: false }));
          if (!foreground || currentActive()?.rest?.alertId !== rest.alertId) return;
          await update((x) => (x.rest?.alertId === rest.alertId ? { ...x, rest: { ...x.rest, takenOver: true } } : x));
          await cancelAlerts([rest.alertId]);
        }, Math.max(0, rest.endsAt - TAKEOVER_MS - now)));
        // Not taken over (the app wasn't in front): the phone alerts, so just end the rest.
        timers.push(window.setTimeout(() => {
          void update((x) => (x.rest?.alertId === rest.alertId && !x.rest.takenOver ? { ...x, rest: null } : x));
        }, rest.endsAt - now + 1500));
      }
    } else {
      timers.push(window.setTimeout(() => {
        if (currentActive()?.rest?.alertId !== rest.alertId || !currentActive()?.rest?.takenOver) return;
        void RestAlarm.playNow({ alarmStream: alarmStream() }).catch(() => {});
        void update((x) => (x.rest?.alertId === rest.alertId ? { ...x, rest: null } : x));
      }, Math.max(0, rest.endsAt - now)));
    }
    return () => timers.forEach(clearTimeout);
  }, [rest]);

  // Leaving the app after a takeover: hand the alert back to the phone.
  useEffect(() => {
    const onHide = async () => {
      if (document.visibilityState !== "hidden") return;
      const r = currentActive()?.rest;
      if (!r?.takenOver) return;
      const back: Rest = { ...r, takenOver: false };
      // Schedule first: the app may be paused moments after it's hidden.
      await schedule(back).catch(() => {});
      await update((x) => (x.rest?.alertId === r.alertId ? { ...x, rest: back } : x));
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
}
