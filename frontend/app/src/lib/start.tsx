import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sheet } from "../components/Sheet";
import { btn } from "../components/ui";
import { begin } from "./active";
import { api, get } from "./api";
import { cached, getOffline, load, routineFromCopy } from "./offline";
import { history, startWorkout } from "./session";
import type { Me, RoutineDetail } from "./types";
import { ensureNotificationPermission } from "../timer/restAlarm";

/**
 * Starting a workout, from a routine (its current version, snapshotted) or
 * empty. Works offline from the copy on the phone. One workout at a time.
 */
export function useStartWorkout() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [inProgress, setInProgress] = useState(false);

  const start = async (routineId: string | null) => {
    setBusy(true);
    setProblem(null);
    try {
      await load();
      const off = getOffline();
      if (off.blocked) {
        setProblem(`This phone still has workouts from ${off.blocked.cached} waiting to upload. Switch back to that account first.`);
        return;
      }
      if (off.hasActive) {
        setInProgress(true);
        return;
      }
      let me: Me;
      try {
        me = off.copy?.me ?? await get<Me>("/api/me");
      } catch {
        setProblem("Open Liftlog once with a connection first, so it can keep your routines on this phone.");
        return;
      }
      let routine: RoutineDetail | undefined;
      if (routineId) {
        try {
          // The current version from the server if it answers within 2 seconds, else the copy.
          routine = await cached(() => api<RoutineDetail>(`/api/routines/${routineId}`, { timeoutMs: 2000 }),
            (c) => routineFromCopy(c, routineId))();
        } catch (e) {
          setProblem((e as Error).message);
          return;
        }
      }
      const w = startWorkout({
        login: me.login, units: me, hist: history(off.copy?.workouts ?? [], off.queue),
        routine: routine && { id: routine.id, name: routine.name, version: routine.current_version },
      });
      if (!(await begin(w))) {
        setInProgress(true);
        return;
      }
      void ensureNotificationPermission().catch(() => {});
      navigate("/workout");
    } catch {
      setProblem("Couldn't start the workout. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const sheet = (
    <Sheet open={inProgress} title="Workout in progress" onClose={() => setInProgress(false)}>
      <p className="mb-4">Finish or discard the workout you're doing before starting another.</p>
      <Link to="/workout" className={`${btn.primary} w-full`}>Resume workout</Link>
    </Sheet>
  );
  return { start, busy, problem, sheet };
}
