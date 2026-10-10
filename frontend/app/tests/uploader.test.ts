// The upload loop (src/lib/uploader.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFLINE, uploadQueue } from "../src/lib/uploader.ts";
import type { Queued } from "../src/lib/session.ts";

const ME = "trav@example.com";

function q(id: string, minute: number, login = ME): Queued {
  return { id, login, routine_id: null, queued_at: `2026-10-09T18:${String(minute).padStart(2, "0")}:00Z`, error: null,
    body: { title: id, notes: "", started_at: "2026-10-09T17:00:00Z", ended_at: "2026-10-09T18:00:00Z", routine_version_id: null, exercises: [] } };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A fake server: answers per workout id, and records what happened. */
function server(answers: Record<string, number>) {
  const log: string[] = [];
  return {
    log,
    deps: {
      put: async (x: Queued) => {
        log.push(`put ${x.id}`);
        const code = answers[x.id] ?? 201;
        if (code >= 300 || code === 0) throw new HttpError(code, `refused ${code}`);
        return x.id;
      },
      uploaded: async (x: Queued) => { log.push(`uploaded ${x.id}`); },
      refused: async (x: Queued, why: string) => { log.push(`refused ${x.id}: ${why}`); },
    },
  };
}

test("a refused workout is marked and doesn't block the ones after it", async () => {
  const s = server({ b: 409, c: 422 });
  const problem = await uploadQueue([q("d", 4), q("b", 2), q("a", 1), q("c", 3)], ME, s.deps);
  assert.deepEqual(s.log, [
    "put a", "uploaded a",
    "put b", "refused b: The server already has a different workout saved under this one's id, so it wasn't replaced.",
    "put c", "refused c: refused 422",
    "put d", "uploaded d",
  ]);
  assert.equal(problem, "refused 422");
});

test("no connection stops the loop and keeps everything queued", async () => {
  const s = server({ b: 0 });
  assert.equal(await uploadQueue([q("a", 1), q("b", 2), q("c", 3)], ME, s.deps), OFFLINE);
  assert.deepEqual(s.log, ["put a", "uploaded a", "put b"]);
});

test("only the signed-in login's workouts upload", async () => {
  const s = server({});
  await uploadQueue([q("hers", 1, "partner@example.com"), q("mine", 2)], ME, s.deps);
  assert.deepEqual(s.log, ["put mine", "uploaded mine"]);
});
