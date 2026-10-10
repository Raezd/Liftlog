import { Capacitor } from "@capacitor/core";
import { AlertTriangle, CloudUpload, Dumbbell, History, ListChecks, Settings } from "lucide-react";
import { useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { reopenQueued } from "../lib/active";
import { plural } from "../lib/format";
import { removeQueued, syncAndRefresh, syncNow, useOffline } from "../lib/offline";
import { REOPEN_BLOCKED, type Queued } from "../lib/session";
import { Sheet } from "./Sheet";
import { Button, btn } from "./ui";

const links = [
  { to: "/", label: "Routines", icon: ListChecks, also: ["/routines"] },
  { to: "/history", label: "History", icon: History, also: ["/workouts"] },
  { to: "/library", label: "Library", icon: Dumbbell, also: [] },
  { to: "/settings", label: "Settings", icon: Settings, also: [] },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh">
      <main className="mx-auto w-full max-w-md px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <StatusBars />
        <Outlet />
      </main>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto grid max-w-md grid-cols-4">
          {links.map(({ to, label, icon: Icon, also }) => {
            const isActive = (to === "/" ? pathname === "/" : under(pathname, to)) || also.some((p) => under(pathname, p));
            return (
            <li key={to}>
              <Link to={to} aria-current={isActive ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs ${isActive ? "font-bold text-accent-text" : "text-muted"}`}>
                <Icon size={22} aria-hidden />
                {label}
              </Link>
            </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** The workout in progress, workouts waiting to upload (with retry), and a login mix-up. */
function StatusBars() {
  const off = useOffline();
  const waiting = off.queue.filter((q) => q.error === null);
  const attention = off.queue.filter((q) => q.error !== null);
  return (
    <>
      {off.blocked && (
        <p role="alert" className="mb-4 rounded-2xl border-2 border-over bg-surface p-3">
          This phone has workouts from {off.blocked.cached} that haven't uploaded yet, and you're signed in to Tailscale
          as {off.blocked.current}. Switch Tailscale back to {off.blocked.cached} so they can upload. Nothing has been deleted.
        </p>
      )}
      {off.hasActive && Capacitor.isNativePlatform() && (
        <Link to="/workout" className={`${btn.primary} mb-4 w-full`}>Workout in progress: resume</Link>
      )}
      {(waiting.length > 0 || attention.length > 0) && (
        <section aria-label="Upload status" className="mb-4 rounded-2xl border border-line bg-surface p-2 pl-3">
          {waiting.length > 0 && (
            <div className="flex items-center gap-2">
              <CloudUpload size={20} aria-hidden className="shrink-0 text-muted" />
              <p className="min-w-0 flex-1 text-sm" role="status">
                {off.syncing ? "Uploading..." : `${plural(waiting.length, "workout")} waiting to upload.`}
                {!off.syncing && off.problem && <span className="block text-muted">{off.problem}</span>}
              </p>
              <button type="button" disabled={off.syncing} onClick={() => void syncAndRefresh(true)} className={`${btn.secondary} shrink-0`}>
                Retry
              </button>
            </div>
          )}
          {attention.length > 0 && (
            <div className={waiting.length ? "mt-2 border-t border-line pt-2" : ""}>
              <p className="flex items-center gap-2 font-bold text-over">
                <AlertTriangle size={20} aria-hidden className="shrink-0" />
                {plural(attention.length, "workout")} {attention.length === 1 ? "needs" : "need"} attention
              </p>
              <ul className="divide-y divide-line">
                {attention.map((q) => <NeedsAttention key={q.id} q={q} busy={off.syncing} inProgress={off.hasActive} />)}
              </ul>
            </div>
          )}
        </section>
      )}
    </>
  );
}

/** A workout the server refused: the reason, and what you can do about it.
 *  Nothing here happens on its own. */
function NeedsAttention({ q, busy, inProgress }: { q: Queued; busy: boolean; inProgress: boolean }) {
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const [said, setSaid] = useState("");
  const when = new Date(q.body.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ id: q.id, ...q.body }, null, 2));
      setSaid("Copied.");
    } catch {
      setSaid("Couldn't copy.");
    }
  };
  const reopen = async () => {
    try {
      const why = await reopenQueued(q.id);
      if (why) setSaid(why);
      else navigate("/workout");
    } catch {
      setSaid("Couldn't reopen it on this phone. Try again.");
    }
  };
  const native = Capacitor.isNativePlatform();
  return (
    <li className="py-2 pr-1">
      <p className="font-bold">{q.body.title}<span className="font-normal text-muted">, {when}</span></p>
      <p className="text-sm">{q.error}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {native && <Button variant="primary" disabled={busy || inProgress} onClick={() => void reopen()}>Reopen</Button>}
        <Button onClick={() => void copy()}>Copy as JSON</Button>
        <Button disabled={busy} onClick={() => void syncNow(q.id)}>Retry</Button>
        <Button className="text-over" onClick={() => setRemoving(true)}>Remove from phone</Button>
      </div>
      {native && inProgress && <p className="mt-1 text-sm text-muted">To reopen it: {REOPEN_BLOCKED.toLowerCase()}</p>}
      <p role="status" className="text-sm text-muted">{said}</p>
      <Sheet open={removing} title="Remove this workout?" onClose={() => setRemoving(false)}>
        <p className="mb-4">It never reached the server, so once it's removed from this phone it can't be recovered. Copy it as JSON first if you might need it.</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setRemoving(false)}>Keep</Button>
          <Button variant="primary" onClick={() => { setRemoving(false); void removeQueued(q.id); }}>Remove</Button>
        </div>
      </Sheet>
    </li>
  );
}
