import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Download } from "./Download";
import { ApiError } from "./lib/api";
import ExerciseAdd from "./pages/ExerciseAdd";
import ExerciseEdit from "./pages/ExerciseEdit";
import History from "./pages/History";
import Import from "./pages/Import";
import Library from "./pages/Library";
import RoutineEdit from "./pages/RoutineEdit";
import RoutineView from "./pages/RoutineView";
import Routines from "./pages/Routines";
import { RoutineVersionPage, RoutineVersions } from "./pages/RoutineVersions";
import Settings from "./pages/Settings";
import WorkoutView from "./pages/WorkoutView";
import { TimerTest } from "./timer/TimerTest";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Not found and access problems won't fix themselves by retrying.
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

// The same pages on the web and in the Android app. /download is web only;
// the rest timer test (temporary, Spec 2) is reachable from Settings in the app.
const router = createBrowserRouter([
  { path: "/download", element: <Download /> },
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
      { path: "/workouts/:id", element: <WorkoutView /> },
      { path: "/library", element: <Library /> },
      { path: "/library/add", element: <ExerciseAdd /> },
      { path: "/library/:id", element: <ExerciseEdit /> },
      { path: "/settings/import", element: <Import /> },
      { path: "/settings", element: <Settings /> },
      { path: "/timer-test", element: <TimerTest /> },
      { path: "*", element: <Routines /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
