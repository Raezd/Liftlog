import { Dumbbell, History, Settings, Upload } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

const links = [
  { to: "/", label: "History", icon: History },
  { to: "/library", label: "Library", icon: Dumbbell },
  { to: "/import", label: "Import", icon: Upload },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  return (
    <div className="min-h-dvh">
      <main className="mx-auto w-full max-w-md px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto grid max-w-md grid-cols-4">
          {links.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink to={to} end={to === "/"}
                className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs ${isActive ? "font-bold text-accent-text" : "text-muted"}`}>
                <Icon size={22} aria-hidden />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
