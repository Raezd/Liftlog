import { registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

/**
 * Rest timer scheduling: @capacitor/local-notifications with allowWhileIdle
 * (AlarmManager.setExactAndAllowWhileIdle under the hood). Chosen in Spec 2
 * after it passed every test, including forced idle.
 *
 * The app's own RestAlarm plugin (RestAlarmPlugin.java) owns the channels and
 * covers what the notifications plugin doesn't: in-app playback, permission
 * status, and when each alert was posted.
 *
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
  isForeground(): Promise<{ foreground: boolean }>;
  playNow(o: { alarmStream: boolean }): Promise<void>;
  delivered(): Promise<{ notifications: { id: number; postTime: number }[] }>;
  openSettings(o: { kind: "notifications" | "exactAlarms" | "app" }): Promise<void>;
}

export const RestAlarm = registerPlugin<RestAlarmPlugin>("RestAlarm");

/**
 * Channel ids match RestAlerts.java. A new sound needs a new id (-v2).
 * Default follows the ringer; the per-user "play through silent mode"
 * setting switches to the alarm channel.
 */
const channelFor = (alarmStream: boolean) => (alarmStream ? "rest-timer-alarm-v1" : "rest-timer-v1");

const TITLE = "Rest is over";

export async function scheduleAlert(id: number, endsAt: number, body: string, alarmStream: boolean) {
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
}

/** Cancels pending alerts and removes any that are showing. */
export async function cancelAlerts(ids: number[]) {
  if (!ids.length) return;
  await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) }).catch(() => {});
}

/** Asks for notification permission if Android hasn't asked yet. */
export async function ensureNotificationPermission() {
  const p = await LocalNotifications.checkPermissions();
  if (p.display === "prompt" || p.display === "prompt-with-rationale") {
    await LocalNotifications.requestPermissions();
  }
}
