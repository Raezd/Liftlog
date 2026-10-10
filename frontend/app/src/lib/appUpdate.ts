/**
 * The Android app's update check on Settings (pure, tested in
 * tests/appUpdate.test.ts; keep it free of runtime imports).
 *
 * The installed version is the APK's version name (`<code>-<commit>`, baked
 * into the app's web build as __BUILD_ID__ by scripts/android-build.sh). The
 * served version is `version_name` from GET /api/app/latest, the same file
 * the /download page reads. Any difference counts as an update; there's no
 * ordering. Anything else (a failed fetch, no APK published, no version)
 * shows nothing.
 */

/** The version /download serves, if it differs from the installed one; else null. */
export function newerVersion(installed: string, latest: unknown): string | null {
  const served = (latest as { version_name?: unknown } | null | undefined)?.version_name;
  if (typeof served !== "string" || served.trim() === "") return null;
  return served.trim() === installed.trim() ? null : served.trim();
}

/** Fetches what /download serves and compares; any failure is null. */
export async function checkForUpdate(installed: string, fetchLatest: () => Promise<unknown>): Promise<string | null> {
  try {
    return newerVersion(installed, await fetchLatest());
  } catch {
    return null;
  }
}
