// Who the on-device copy belongs to (src/lib/offlineRules.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loginCheck, unsyncedFor, withWorkout, withoutWorkout } from "../src/lib/offlineRules.ts";

const TRAV = "trav@example.com";
const HER = "partner@example.com";

test("the same login, or no copy yet, keeps the cache", () => {
  assert.equal(loginCheck(TRAV, TRAV, 3), "keep");
  assert.equal(loginCheck(null, HER, 0), "keep");
});

test("a different login clears the cache when everything has uploaded", () => {
  assert.equal(loginCheck(TRAV, HER, unsyncedFor(TRAV, [], null)), "clear");
  // Her own queued workouts don't hold his copy.
  assert.equal(loginCheck(TRAV, HER, unsyncedFor(TRAV, [{ login: HER }], null)), "clear");
});

test("the cache refuses to clear while the cached user has unsynced workouts", () => {
  assert.equal(loginCheck(TRAV, HER, unsyncedFor(TRAV, [{ login: TRAV }], null)), "blocked");
  // A workout still in progress counts too.
  assert.equal(loginCheck(TRAV, HER, unsyncedFor(TRAV, [], { login: TRAV })), "blocked");
  assert.equal(unsyncedFor(TRAV, [{ login: TRAV }, { login: TRAV }, { login: HER }], { login: TRAV }), 3);
});

test("the cache drops a deleted workout and replaces an edited one, newest first", () => {
  const w = (id: string, day: number, title = id) => ({ id, title, started_at: `2026-10-0${day}T17:00:00Z` });
  const copy = { me: TRAV, workouts: [w("c", 7), w("b", 5), w("a", 3)] };
  // An edit moved b's start before a's: it's replaced, not added, and sorts by its new start.
  const edited = withWorkout(copy, w("b", 2, "b (fixed)"));
  assert.deepEqual(edited.workouts.map((x) => x.title), ["c", "a", "b (fixed)"]);
  assert.equal(edited.me, TRAV);
  const deleted = withoutWorkout(edited, "a");
  assert.deepEqual(deleted.workouts.map((x) => x.id), ["c", "b"]);
  // The stored copy itself is never changed in place.
  assert.deepEqual(copy.workouts.map((x) => x.id), ["c", "b", "a"]);
});
