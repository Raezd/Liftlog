import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";
import { StrictMode, Suspense, lazy, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Download } from "./Download";
import { currentActive, loadActive } from "./lib/active";
import { ApiError } from "./lib/api";
import { getOffline, onOfflineChange, startOffline } from "./lib/offline";
import ExerciseAdd from "./pages/ExerciseAdd";
import ExerciseEdit from "./pages/ExerciseEdit";
import Export from "./pages/Export";
import GearPage from "./pages/Gear";
import History from "./pages/History";
import Import from "./pages/Import";
import Library from "./pages/Library";
import RoutineEdit from "./pages/RoutineEdit";
import RoutineView from "./pages/RoutineView";
import Routines from "./pages/Routines";
import { RoutineVersionPage, RoutineVersions } from "./pages/RoutineVersions";
import Settings from "./pages/Settings";
import Workout from "./pages/Workout";
import { WorkoutDone, WorkoutFinish } from "./pages/WorkoutFinish";
import WorkoutEdit from "./pages/WorkoutEdit";
import WorkoutView from "./pages/WorkoutView";
import "./styles.css";

// The chart pages carry ECharts, so they load on first use.
const ExerciseView = lazy(() => import("./pages/ExerciseView"));
const MuscleVolume = lazy(() => import("./pages/MuscleVolume"));
const later = (page: ReactNode) => <Suspense fallback={<p className="text-muted" role="status">Loading...</p>}>{page}</Suspense>;

const queryClient = new QueryClient({
  defaultOptions: {
    // Run even when the phone says it's offline: pages fall back to the
    // on-device copy (lib/offline.ts), and edits say plainly that they failed.
    mutations: { networkMode: "always" },
    queries: {
      networkMode: "always",
      staleTime: 30_000,
      // Not found and access problems won't fix themselves by retrying.
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

startOffline();

// After uploads, history and the routines' "used" flags are out of date.
let waiting = getOffline().queue.length;
onOfflineChange(() => {
  const now = getOffline().queue.length;
  if (now < waiting) {
    void queryClient.invalidateQueries({ queryKey: ["workouts"] });
    void queryClient.invalidateQueries({ queryKey: ["routines"] });
  }
  waiting = now;
});

/** Reopening the app with a workout in progress goes straight back to it. */
function Root() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || pathname !== "/") return;
    void loadActive().then(() => { if (currentActive()) navigate("/workout", { replace: true }); });
    // Only on launch.
  }, []);
  return <Outlet />;
}

// The same pages on the web and in the Android app. /download is web only.
// The workout screens (full screen, no bottom nav) run in the Android app only.
const router = createBrowserRouter([{ element: <Root />, children: [
  { path: "/download", element: <Download /> },
  { path: "/workout", element: <Workout /> },
  { path: "/workout/finish", element: <WorkoutFinish /> },
  { path: "/workout/done", element: <WorkoutDone /> },
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Routines /> },
      { path: "/routines/new", element: <RoutineEdit /> },
      { path: "/routines/:id", element: <RoutineView /> },
      { path: "/routines/:id/edit", element: <RoutineEdit /> },
      { path: "/routines/:id/versions", element: <RoutineVersions /> },
      { path: "/routines/:id/versions/:vid", element: <RoutineVersionPage /> },
      { path: "/history", element: <History /> },
      { path: "/history/muscles", element: later(<MuscleVolume />) },
      { path: "/exercises/:id", element: later(<ExerciseView />) },
      { path: "/workouts/:id", element: <WorkoutView /> },
      { path: "/workouts/:id/edit", element: <WorkoutEdit /> },
      { path: "/library", element: <Library /> },
      { path: "/library/add", element: <ExerciseAdd /> },
      { path: "/library/:id", element: <ExerciseEdit /> },
      { path: "/settings/import", element: <Import /> },
      { path: "/settings/gear", element: <GearPage /> },
      { path: "/settings/export", element: <Export /> },
      { path: "/settings", element: <Settings /> },
      { path: "*", element: <Routines /> },
    ],
  },
] }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
