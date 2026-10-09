import { useCallback, useEffect, useState } from "react";

/**
 * Where the API lives. The web build is served by the same Caddy as the API,
 * so it uses relative paths. The Android build bundles its files and calls
 * the liftlog Tailscale hostname, set at build time by scripts/android-build.sh.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

export type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

// Auth rejections carry a code (see backend app/auth.py); turn them into plain words.
export function explain(status: number, body: unknown): string {
  const detail = (body as { detail?: { code?: string; login?: string } } | null)?.detail;
  if (detail?.code === "auth_not_allowed") return `${detail.login} isn't on the list for this app.`;
  if (detail?.code === "auth_no_identity") return "Open this from a device signed in to Tailscale.";
  if (status === 403) return "Access denied.";
  return `Error ${status}`;
}

/** Fetches an API path. Returns a reload function so callers can check again. */
export function useApi<T>(path: string, acceptOn503 = false): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    setLoad({ state: "loading" });
    fetch(API_BASE + path, { headers: { Accept: "application/json" }, signal: abort.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!live) return;
        if (r.ok || (acceptOn503 && r.status === 503 && body)) setLoad({ state: "ok", data: body as T });
        else setLoad({ state: "error", message: explain(r.status, body) });
      })
      .catch(() => live && setLoad({ state: "error", message: "Can't reach the server." }))
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [path, acceptOn503, tick]);
  return [load, reload];
}
