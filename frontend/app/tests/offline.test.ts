// Who the on-device copy belongs to (src/lib/offlineRules.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loginCheck, unsyncedFor } from "../src/lib/offlineRules.ts";

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
