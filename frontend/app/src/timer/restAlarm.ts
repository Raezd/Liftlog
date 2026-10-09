import { registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

/**
 * Rest timer scheduling for the Spec 2 prototype. Two paths are under test:
 *
 *   A: @capacitor/local-notifications with allowWhileIdle
 *      (AlarmManager.setExactAndAllowWhileIdle under the hood)
 *   B: the app's own RestAlarm plugin, AlarmManager.setAlarmClock
 *      (android/app/src/main/java/.../RestAlarmPlugin.java)
 *
 * Both post to the same channels, so sound and vibration are identical.
 * Timer state is an absolute end time, never a countdown, so it survives the
 * app being backgrounded or killed.
 */

export type NativeStatus = {
  notifications: boolean;
  exactAlarms: boolean;
  channelOn: boolean;
  alarmChannelOn: boolean;
  ringer: "normal" | "vibrate" | "silent";
};

interface RestAlarmPlugin {
  status(): Promise<NativeStatus>;
  schedule(o: { id: number; at: number; title: string; body: string; alarmStream: boolean }): Promise<void>;
  cancel(o: { ids: number[] }): Promise<void>;
  isForeground(): Promise<{ foreground: boolean }>;
  playNow(o: { alarmStream: boolean }): Promise<void>;
  delivered(): Promise<{ notifications: { id: number; postTime: number }[] }>;
  openSettings(o: { kind: "notifications" | "exactAlarms" | "app" }): Promise<void>;
}

export const RestAlarm = registerPlugin<RestAlarmPlugin>("RestAlarm");

export type Path = "A" | "B";

/** Channel ids match RestAlerts.java. A new sound needs a new id (-v2). */
const channelFor = (alarmStream: boolean) => (alarmStream ? "rest-timer-alarm-v1" : "rest-timer-v1");

const TITLE = "Rest is over";

export async function scheduleAlert(path: Path, id: number, endsAt: number, body: string, alarmStream: boolean) {
  if (path === "A") {
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title: TITLE,
        body,
        channelId: channelFor(alarmStream),
        smallIcon: "ic_stat_rest",
        schedule: { at: new Date(endsAt), allowWhileIdle: true },
      }],
    });
  } else {
    await RestAlarm.schedule({ id, at: endsAt, title: TITLE, body, alarmStream });
  }
}

/** Cancels pending alerts on both paths, whichever one scheduled them. */
export async function cancelAlerts(ids: number[]) {
  if (!ids.length) return;
  await Promise.allSettled([
    LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }),
    RestAlarm.cancel({ ids }),
  ]);
}

/** Asks for notification permission if Android hasn't asked yet. */
export async function ensureNotificationPermission() {
  const p = await LocalNotifications.checkPermissions();
  if (p.display === "prompt" || p.display === "prompt-with-rationale") {
    await LocalNotifications.requestPermissions();
  }
}
