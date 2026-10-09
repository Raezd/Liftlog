import { useEffect, useState } from "react";

type Me = { login: string };
type Health = { status: string; database: string };
type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

// Auth rejections carry a code (see backend app/auth.py); turn them into plain words.
function explain(status: number, body: unknown): string {
  const detail = (body as { detail?: { code?: string; login?: string } } | null)?.detail;
  if (detail?.code === "auth_not_allowed") return `${detail.login} isn't on the list for this app.`;
  if (detail?.code === "auth_no_identity") return "Open this from a device signed in to Tailscale.";
  if (status === 403) return "Access denied.";
  return `Error ${status}`;
}

function useApi<T>(path: string, acceptOn503 = false): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fetch(path, { headers: { Accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!live) return;
        if (r.ok || (acceptOn503 && r.status === 503 && body)) setLoad({ state: "ok", data: body as T });
        else setLoad({ state: "error", message: explain(r.status, body) });
      })
      .catch(() => live && setLoad({ state: "error", message: "Can't reach the server." }));
    return () => { live = false; };
  }, [path, acceptOn503]);
  return load;
}

function Row({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-line last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-2 font-bold text-right break-all">
        {good !== undefined && (
          <span aria-hidden className={`inline-block size-2.5 rounded-full ${good ? "bg-accent" : "bg-over"}`} />
        )}
        {value}
      </dd>
    </div>
  );
}

export function Hello() {
  const me = useApi<Me>("/api/me");
  const health = useApi<Health>("/api/health", true);

  const login = me.state === "ok" ? me.data.login : me.state === "loading" ? "Checking..." : me.message;
  const backend =
    health.state === "loading" ? { value: "Checking..." }
    : health.state === "error" ? { value: "Down", good: false }
    : { value: health.data.status === "ok" ? "OK" : "Error", good: health.data.status === "ok" };
  const database =
    health.state === "ok" ? { value: health.data.database === "ok" ? "OK" : "Down", good: health.data.database === "ok" }
    : health.state === "loading" ? { value: "Checking..." }
    : { value: "Unknown" };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="mb-6">
        <h1 className="display text-4xl font-extrabold text-accent-text">Liftlog</h1>
        <p className="mt-1 text-muted">Hello. The app is coming soon.</p>
      </header>

      <section className="rounded-2xl border border-line bg-surface px-4" aria-label="Status">
        <dl>
          <Row label="Signed in as" value={login} />
          <Row label="Backend" {...backend} />
          <Row label="Database" {...database} />
          <Row label="Version" value={__BUILD_ID__} />
        </dl>
      </section>
    </main>
  );
}
