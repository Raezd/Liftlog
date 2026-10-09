import { Capacitor } from "@capacitor/core";
import { CloudUpload, Dumbbell, History, ListChecks, Settings } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { plural } from "../lib/format";
import { syncAndRefresh, useOffline } from "../lib/offline";
import { btn } from "./ui";

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
  const waiting = off.queue.length;
  const failed = off.queue.find((q) => q.error);
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
      {waiting > 0 && (
        <section aria-label="Upload status" className="mb-4 flex items-center gap-2 rounded-2xl border border-line bg-surface p-2 pl-3">
          <CloudUpload size={20} aria-hidden className="shrink-0 text-muted" />
          <p className="min-w-0 flex-1 text-sm" role="status">
            {off.syncing ? "Uploading..." : `${plural(waiting, "workout")} waiting to upload.`}
            {!off.syncing && (failed?.error ?? off.problem) && <span className="block text-muted">{failed?.error ?? off.problem}</span>}
          </p>
          <button type="button" disabled={off.syncing} onClick={() => void syncAndRefresh(true)} className={`${btn.secondary} shrink-0`}>
            Retry
          </button>
        </section>
      )}
    </>
  );
}
