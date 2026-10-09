/**
 * The workout in progress, on the device only (the "active" store). One at a
 * time; it never syncs until it's finished. Every change is written to
 * storage before the screen shows it (typing shows first and writes right
 * after), so closing the app or losing power loses nothing.
 */
import { useSyncExternalStore } from "react";
import { read, write } from "./idb";
import { noteActive, syncNow } from "./offline";
import type { ActiveWorkout, Queued, UploadBody } from "./session";

type State = { loaded: boolean; workout: ActiveWorkout | null; problem: string | null };

let state: State = { loaded: false, workout: null, problem: null };
// The latest workout, ahead of what's shown while a write is in flight.
let latest: ActiveWorkout | null = null;
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const SAVE_FAILED = "Couldn't save to this phone's storage. Your last change may not be kept.";

let loading: Promise<void> | null = null;
export function loadActive(): Promise<void> {
  loading ??= read<ActiveWorkout>("active", "workout").then((w) => {
    latest = w ?? null;
    publish({ loaded: true, workout: latest });
    noteActive(!!latest);
  }, () => publish({ loaded: true, problem: SAVE_FAILED }));
  return loading;
}

export function useActive(): State {
  void loadActive();
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export const currentActive = () => latest;

/**
 * Changes the workout. By default the change is on disk before the screen
 * shows it. `instant` (typing) shows it first and writes right after.
 */
export function update(fn: (w: ActiveWorkout) => ActiveWorkout, opts: { instant?: boolean } = {}): Promise<void> {
  if (!latest) return Promise.resolve();
  const next = fn(latest);
  latest = next;
  if (opts.instant) publish({ workout: next });
  const p = chain.then(() => write(["active"], (s) => s.active.put(next, "workout"))).then(
    () => { if (!opts.instant && latest === next) publish({ workout: next, problem: null }); else if (!opts.instant) publish({ problem: null }); },
    () => publish({ workout: latest, problem: SAVE_FAILED }),
  );
  chain = p;
  return p;
}

/** Starts a workout. Refuses if one is already in progress. */
export async function begin(w: ActiveWorkout): Promise<boolean> {
  await loadActive();
  await chain;
  if (latest) return false;
  await write(["active"], (s) => s.active.put(w, "workout"));
  latest = w;
  publish({ workout: w, problem: null });
  noteActive(true);
  return true;
}

/** Moves the workout into the upload queue, in one write, then tries to upload. */
export async function finish(body: UploadBody): Promise<void> {
  await chain;
  const w = latest;
  if (!w) return;
  const q: Queued = { id: w.id, login: w.login, routine_id: w.routine_id, queued_at: new Date().toISOString(), body, error: null };
  await write(["active", "queue"], (s) => {
    s.active.delete("workout");
    s.queue.put(q);
  });
  latest = null;
  publish({ workout: null });
  noteActive(false);
  void syncNow();
}

/** Throws the workout away. Nothing is sent anywhere. */
export async function discard(): Promise<void> {
  await chain;
  await write(["active"], (s) => s.active.delete("workout"));
  latest = null;
  publish({ workout: null });
  noteActive(false);
}
