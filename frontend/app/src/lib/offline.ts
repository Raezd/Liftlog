/**
 * The offline model: the on-device copy, the login check, and the upload
 * queue. Storage is lib/idb.ts.
 *
 * - The copy (GET /api/offline) is refreshed whenever there's a connection:
 *   at start, when the app comes back to the front, when the network returns,
 *   and after uploads. Pages fall back to it when the server can't be reached
 *   (`cached()`).
 * - The copy belongs to one login. A different login clears it, unless that
 *   login still has workouts that haven't uploaded (lib/offlineRules.ts).
 * - A finished workout waits in the queue and uploads as one PUT under its own
 *   id, which is safe to repeat. Uploads run on finish, on start and resume,
 *   when the network returns, and from the retry button. One that fails stays
 *   queued until it succeeds. Only the login that made a workout uploads it.
 */
import { useSyncExternalStore } from "react";
import { ApiError, api, get } from "./api";
import { read, readAll, write } from "./idb";
import { loginCheck, unsyncedFor } from "./offlineRules";
import type { ActiveWorkout, Queued } from "./session";
import { OFFLINE, uploadQueue } from "./uploader";
import type { Me, OfflineCopy, RoutineDetail, RoutineList, WorkoutDetail } from "./types";

type CacheRecord = { login: string; fetched_at: string; data: OfflineCopy };

export type OfflineState = {
  /** Loaded from the device at start. */
  ready: boolean;
  copy: OfflineCopy | null;
  /** Workouts waiting to upload, and what's in the queue. */
  queue: Queued[];
  hasActive: boolean;
  syncing: boolean;
  /** Plain words about the last upload or refresh that didn't work. */
  problem: string | null;
  /** Signed in as someone else while this phone holds the previous login's unsynced workouts. */
  blocked: { cached: string; current: string } | null;
  /** The first refresh of the copy has finished, whether or not it worked. */
  refreshed: boolean;
};

let state: OfflineState = { ready: false, copy: null, queue: [], hasActive: false, syncing: false, problem: null, blocked: null, refreshed: false };
const listeners = new Set<() => void>();

function set(next: Partial<OfflineState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const getOffline = () => state;

/** Calls fn on every change. Returns the unsubscribe. */
export function onOfflineChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useOffline(): OfflineState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

/** Network trouble, as opposed to the server saying no. */
export const unreachable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 502);

let loading: Promise<void> | null = null;

/** Reads the copy and queue from the device. Safe to call more than once. */
export function load(): Promise<void> {
  loading ??= (async () => {
    const [rec, queue, active] = await Promise.all([
      read<CacheRecord>("cache", "copy"), readAll<Queued>("queue"), read<ActiveWorkout>("active", "workout"),
    ]);
    set({ ready: true, copy: rec?.data ?? null, queue: sortQueue(queue), hasActive: !!active });
  })().catch(() => { set({ ready: true }); });
  return loading;
}

const sortQueue = (q: Queued[]) => q.slice().sort((a, b) => a.queued_at.localeCompare(b.queued_at));

export function noteActive(has: boolean) {
  if (state.hasActive !== has) set({ hasActive: has });
}

/**
 * A query function that asks the server and, when it can't be reached, answers
 * from the copy instead. `pick` returns undefined when the copy doesn't have it.
 */
export function cached<T>(fetch: () => Promise<T>, pick: (c: OfflineCopy) => T | undefined): () => Promise<T> {
  return async () => {
    await load();
    const fallback = () => (state.copy && !state.blocked ? pick(state.copy) : undefined);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const v = fallback();
      if (v !== undefined) return v;
    }
    try {
      return await fetch();
    } catch (e) {
      const v = unreachable(e) ? fallback() : undefined;
      if (v === undefined) throw e;
      return v;
    }
  };
}

let lastRefresh = 0;
let refreshing: Promise<void> | null = null;

/** Fetches a fresh copy, after checking whose it is. Quiet when offline. */
export function refresh(force = false): Promise<void> {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < 30_000) return Promise.resolve();
  refreshing = (async () => {
    await load();
    let data: OfflineCopy;
    try {
      data = await get<OfflineCopy>("/api/offline");
    } catch {
      return; // Offline or the server is down: keep what's here.
    }
    lastRefresh = Date.now();
    const rec = await read<CacheRecord>("cache", "copy");
    const queue = await readAll<Queued>("queue");
    const active = await read<ActiveWorkout>("active", "workout") ?? null;
    // No copy yet: the queue or a workout in progress still says whose phone this was.
    const cachedLogin = rec?.login ?? queue[0]?.login ?? active?.login ?? null;
    const check = loginCheck(cachedLogin, data.me.login, cachedLogin ? unsyncedFor(cachedLogin, queue, active) : 0);
    if (check === "blocked") {
      set({ blocked: { cached: cachedLogin!, current: data.me.login } });
      return;
    }
    // "clear" and "keep" both replace the copy. Anything left in the queue or
    // in progress belongs to some other login and waits for it.
    // Kept in memory even if the device won't store it (a private browser window).
    await write(["cache"], (s) => {
      s.cache.put({ login: data.me.login, fetched_at: new Date().toISOString(), data } satisfies CacheRecord, "copy");
    }).catch(() => {});
    set({ copy: data, blocked: null });
  })().finally(() => {
    refreshing = null;
    if (!state.refreshed) set({ refreshed: true });
  });
  return refreshing;
}

/** Puts a just-uploaded workout into the copy, so prefill sees it before the next refresh. */
async function remember(w: WorkoutDetail) {
  const rec = await read<CacheRecord>("cache", "copy");
  if (!rec || rec.login !== state.copy?.me.login) return;
  const data = { ...rec.data, workouts: [w, ...rec.data.workouts.filter((x) => x.id !== w.id)] };
  await write(["cache"], (s) => s.cache.put({ ...rec, data }, "copy"));
  set({ copy: data });
}

let syncing: Promise<void> | null = null;

/** Uploads every waiting workout that belongs to whoever is signed in, or
 *  just `only` (a Needs attention workout's own Retry). */
export function syncNow(only?: string): Promise<void> {
  if (syncing && only) return syncing.then(() => syncNow(only));
  syncing ??= (async () => {
    await load();
    const queue = sortQueue(await readAll<Queued>("queue"));
    set({ queue });
    if (!queue.some((q) => (only ? q.id === only : q.error === null))) return;
    set({ syncing: true });
    let me: Me;
    try {
      me = await get<Me>("/api/me");
    } catch (e) {
      set({ problem: unreachable(e) ? OFFLINE : (e as Error).message });
      return;
    }
    const problem = await uploadQueue(queue, me.login, {
      put: (q) => api<WorkoutDetail>(`/api/workouts/${q.id}`, { method: "PUT", json: q.body, timeoutMs: 30_000 }),
      uploaded: async (q, w) => {
        await write(["queue"], (s) => s.queue.delete(q.id));
        await remember(w).catch(() => {});
      },
      // The server said no. Keep it on the phone, and say why.
      refused: (q, why) => write(["queue"], (s) => s.queue.put({ ...q, error: why } satisfies Queued)),
    }, only);
    // A refusal shows on the workout itself (Needs attention), not here.
    set({ queue: sortQueue(await readAll<Queued>("queue")), problem: problem === OFFLINE ? OFFLINE : null });
  })().finally(() => {
    syncing = null;
    set({ syncing: false });
  });
  return syncing;
}

/** Rereads the queue after another module changed it (Reopen). */
export async function reloadQueue() {
  set({ queue: sortQueue(await readAll<Queued>("queue")) });
}

/** Removes a Needs attention workout from the phone, for good. Never automatic. */
export async function removeQueued(id: string) {
  await write(["queue"], (s) => s.queue.delete(id));
  set({ queue: sortQueue(await readAll<Queued>("queue")) });
}

/** Upload what's waiting, then refresh the copy. */
export async function syncAndRefresh(force = false) {
  await syncNow();
  await refresh(force);
}

/** Starts the automatic syncing: now, on resume, and when the network returns. */
export function startOffline() {
  void load().then(() => syncAndRefresh(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncAndRefresh();
  });
  window.addEventListener("online", () => void syncAndRefresh(true));
}

/** A routine as GET /api/routines/{id} returns it, from the copy. */
export function routineFromCopy(c: OfflineCopy, id: string): RoutineDetail | undefined {
  const r = [...c.routines.routines, ...c.routines.folders.flatMap((f) => f.routines)].find((x) => x.id === id);
  const v = c.versions[id];
  if (!r || !v) return undefined;
  return { id: r.id, name: r.name, folder_id: r.folder_id, position: r.position, archived: r.archived, used: r.used, current_version: v };
}

/** The routines list from the copy, without archived ones unless asked. */
export function routineListFromCopy(c: OfflineCopy, archived: boolean): RoutineList {
  if (archived) return c.routines;
  return {
    folders: c.routines.folders.filter((f) => !f.archived).map((f) => ({ ...f, routines: f.routines.filter((r) => !r.archived) })),
    routines: c.routines.routines.filter((r) => !r.archived),
  };
}
