import { useApi } from "./api";

type Me = { login: string };
type Health = { status: string; database: string };

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
  const [me] = useApi<Me>("/api/me");
  const [health] = useApi<Health>("/api/health", true);

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
