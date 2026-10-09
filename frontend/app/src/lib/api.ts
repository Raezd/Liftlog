/**
 * Where the API lives. The web build is served by the same Caddy as the API,
 * so it uses relative paths. The Android build bundles its files and calls
 * the liftlog Tailscale hostname, set at build time by scripts/android-build.sh.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  /** `code` is the server's machine-readable reason, when it sent one. */
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

// Auth rejections carry a code (see backend app/auth.py); turn them into plain words.
function describe(status: number, detail: unknown): { message: string; code?: string } {
  if (typeof detail === "string") return { message: detail };
  if (Array.isArray(detail)) return { message: "Something in the form isn't right." };
  const d = (detail ?? {}) as { code?: string; message?: string; login?: string };
  if (d.code === "auth_not_allowed") return { code: d.code, message: `${d.login} isn't on the list for this app.` };
  if (d.code === "auth_no_identity") return { code: d.code, message: "Open this from a device signed in to Tailscale." };
  if (d.message) return { code: d.code, message: d.message };
  if (status === 404) return { code: "not_found", message: "Not found." };
  if (status === 403) return { message: "Access denied." };
  if (status >= 502 && status <= 504) return { message: "The server is starting or down. Try again in a minute." };
  return { message: `Something went wrong (${status}).` };
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, headers, timeoutMs = 15000, ...rest } = init;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...rest,
      signal: abort.signal,
      headers: { Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and Tailscale.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { message, code } = describe(res.status, body?.detail);
    throw new ApiError(res.status, message, code);
  }
  return body as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const send = <T,>(method: string, path: string, json?: unknown) => api<T>(path, { method, json });
