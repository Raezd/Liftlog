/**
 * Who the on-device copy belongs to. The copy (the cache, the workout in
 * progress, and the upload queue) belongs to the Tailscale login that filled
 * it. When /api/me answers with a different login, the copy is cleared,
 * unless the login it belongs to still has workouts that haven't uploaded:
 * then nothing is cleared and the app says so in plain words.
 * Tests: tests/offline.test.ts (`npm test`).
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */

export type LoginCheck = "keep" | "clear" | "blocked";

/** Workouts on this device for `login` that the server doesn't have yet:
 *  queued uploads, plus a workout still in progress. */
export function unsyncedFor(login: string, queue: { login: string }[], active: { login: string } | null): number {
  return queue.filter((q) => q.login === login).length + (active?.login === login ? 1 : 0);
}

export function loginCheck(cachedLogin: string | null, currentLogin: string, unsynced: number): LoginCheck {
  if (cachedLogin === null || cachedLogin === currentLogin) return "keep";
  return unsynced > 0 ? "blocked" : "clear";
}

type HasWorkouts<W> = { workouts: W[] };

/**
 * The copy with one workout put in, or replaced by the server's newer one
 * (after an upload or an edit), keeping it newest first by start time, since
 * an edit can move a workout's start.
 */
export function withWorkout<W extends { id: string; started_at: string }, C extends HasWorkouts<W>>(copy: C, w: W): C {
  const rest = copy.workouts.filter((x) => x.id !== w.id);
  const at = rest.findIndex((x) => Date.parse(x.started_at) < Date.parse(w.started_at));
  return { ...copy, workouts: at < 0 ? [...rest, w] : [...rest.slice(0, at), w, ...rest.slice(at)] };
}

/** The copy without a deleted workout. */
export function withoutWorkout<W extends { id: string }, C extends HasWorkouts<W>>(copy: C, id: string): C {
  return { ...copy, workouts: copy.workouts.filter((x) => x.id !== id) };
}
