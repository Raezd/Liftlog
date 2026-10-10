// The update check on Settings (src/lib/appUpdate.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkForUpdate, newerVersion } from "../src/lib/appUpdate.ts";

const latest = (version_name: unknown) => ({ version_name, version_code: 33, size: 1, built_at: "2026-10-10T12:00:00Z" });

test("the same version shows no notice", async () => {
  assert.equal(newerVersion("32-55487bd", latest("32-55487bd")), null);
  assert.equal(await checkForUpdate("32-55487bd", async () => latest("32-55487bd")), null);
});

test("a different version shows it, with no ordering", async () => {
  assert.equal(await checkForUpdate("32-55487bd", async () => latest("33-a1b2c3d")), "33-a1b2c3d");
  // Older or rebuilt counts too: any difference is an update.
  assert.equal(newerVersion("33-a1b2c3d", latest("32-55487bd")), "32-55487bd");
});

test("a failed fetch shows nothing", async () => {
  assert.equal(await checkForUpdate("32-55487bd", async () => { throw new Error("Can't reach the server."); }), null);
});

test("a missing version shows nothing", async () => {
  for (const body of [null, undefined, {}, latest(undefined), latest(""), latest("  "), latest(33)]) {
    assert.equal(await checkForUpdate("32-55487bd", async () => body), null, JSON.stringify(body));
  }
});
