/**
 * The upload loop, apart from storage and the network so the tests can run
 * it (tests/uploader.test.ts). lib/offline.ts supplies the PUT and the
 * storage writes.
 *
 * Workouts go up oldest first, only those made by whoever is signed in. When
 * the server can't be reached, the loop stops and everything stays queued.
 * When the server refuses one (a 4xx), it's marked with the reason (Needs
 * attention) and the loop moves on, so one bad workout never holds up the
 * rest. A workout that needs attention is skipped from then on, unless it's
 * retried by itself (`only`).
 *
 * A 410 means the workout was uploaded before and then deleted (on another
 * device, say). It's dropped from the queue, not marked: there's nothing to fix.
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */
import type { Queued } from "./session.ts";

export type UploadDeps<W> = {
  put: (q: Queued) => Promise<W>;
  uploaded: (q: Queued, w: W) => Promise<void>;
  refused: (q: Queued, why: string) => Promise<void>;
  /** The server deleted it: drop it from the phone. */
  gone: (q: Queued) => Promise<void>;
};

export const OFFLINE = "Can't reach the server right now. Your workouts are saved on this phone.";
const CONFLICT = "The server already has a different workout saved under this one's id, so it wasn't replaced.";

const status = (e: unknown) => (typeof e === "object" && e !== null && "status" in e ? Number((e as { status: unknown }).status) : 0);

/** Uploads `queue` for `login`, or just the workout `only`. Returns the problem to show, if any. */
export async function uploadQueue<W>(queue: Queued[], login: string, deps: UploadDeps<W>, only?: string): Promise<string | null> {
  let problem: string | null = null;
  const mine = queue
    .filter((q) => q.login === login && (only === undefined ? q.error === null : q.id === only))
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  for (const q of mine) {
    let w: W;
    try {
      w = await deps.put(q);
    } catch (e) {
      const code = status(e);
      if (code < 400 || code >= 500) return OFFLINE;
      if (code === 410) {
        await deps.gone(q);
        continue;
      }
      const why = code === 409 ? CONFLICT : (e as Error).message;
      await deps.refused(q, why);
      problem = why;
      continue;
    }
    await deps.uploaded(q, w);
  }
  return problem;
}
