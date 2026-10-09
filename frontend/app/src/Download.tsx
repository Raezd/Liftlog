import { useQuery } from "@tanstack/react-query";
import { type ApiError, get } from "./lib/api";

type Latest = { version_name: string; version_code: number; size: number; built_at: string };

/** /download: the signed Android app, for both phones to install and update from. */
export function Download() {
  const latest = useQuery({ queryKey: ["apk"], queryFn: () => get<Latest>("/api/app/latest"), retry: false });
  const built = latest.data ? new Date(latest.data.built_at).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="mb-6">
        <h1 className="display text-4xl font-extrabold text-accent-text">Get the app</h1>
        <p className="mt-1 text-muted">Liftlog for Android.</p>
      </header>

      <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Download">
        {latest.isPending && <p>Checking...</p>}
        {latest.isError && (
          <p>{(latest.error as ApiError).status === 404 ? "No app has been published yet." : latest.error.message}</p>
        )}
        {latest.data && (
          <>
            <p className="num display text-2xl font-bold">Version {latest.data.version_name}</p>
            <p className="text-muted">
              {built}, {(latest.data.size / 1_048_576).toFixed(1)} MB
            </p>
            <a href="/api/app/liftlog.apk" download="liftlog.apk"
              className="mt-4 flex min-h-11 items-center justify-center rounded-xl bg-accent-strong px-4 font-bold text-white">
              Download
            </a>
          </>
        )}
      </section>

      <section className="mt-6 text-muted" aria-label="How to install">
        <h2 className="display mb-2 text-lg font-bold text-ink">How to install</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Tap Download, then open the file.</li>
          <li>If your phone asks, allow your browser to install apps.</li>
          <li>Tap Install, or Update if you already have it. Your data stays.</li>
        </ol>
      </section>
    </main>
  );
}
