import { Dumbbell, History, ListChecks, Settings } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router-dom";

const links = [
  { to: "/", label: "Routines", icon: ListChecks, also: ["/routines"] },
  { to: "/history", label: "History", icon: History, also: ["/workouts"] },
  { to: "/library", label: "Library", icon: Dumbbell, also: [] },
  { to: "/settings", label: "Settings", icon: Settings, also: ["/timer-test"] },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh">
      <main className="mx-auto w-full max-w-md px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))]">
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
