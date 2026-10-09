/**
 * The "play through silent mode" setting lives on the server (per user). The
 * timer has to work with no signal, so the last value seen is kept on the
 * phone too. Proper on-device storage arrives with offline sync (Spec 5).
 */
const KEY = "liftlog.playThroughSilent";

export function rememberAlertSetting(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage off: default applies */ }
}

export function lastAlertSetting(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
