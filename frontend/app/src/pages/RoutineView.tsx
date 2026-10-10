import { useQuery } from "@tanstack/react-query";
import { History, Pencil, Play } from "lucide-react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Badge, Button, ErrorText, Loading, Page, btn } from "../components/ui";
import { get } from "../lib/api";
import { cached, routineFromCopy } from "../lib/offline";
import { useStartWorkout } from "../lib/start";
import type { RoutineDetail } from "../lib/types";
import { useRoutineList } from "./Routines";
import { VersionView } from "./RoutineVersions";
import { isNative } from "./Workout";

/** Set by Save as routine, so this page can confirm where it went. */
export type SavedState = { saved: { folder: string | null } };

/** A routine, read-only, with a way into the editor. */
export default function RoutineView() {
  const { id } = useParams();
  const saved = (useLocation().state as SavedState | null)?.saved;
  const q = useQuery({
    queryKey: ["routine", id],
    queryFn: cached(() => get<RoutineDetail>(`/api/routines/${id}`), (c) => routineFromCopy(c, id!)),
  });
  const starter = useStartWorkout();
  const list = useRoutineList(true);
  const r = q.data;
  const folder = r?.folder_id ? list.data?.folders.find((f) => f.id === r.folder_id)?.name : null;

  return (
    <Page title={r?.name ?? "Routine"} back="/"
      action={r && <Link to={`/routines/${id}/edit`} className={btn.primary}><Pencil size={18} aria-hidden /> Edit</Link>}>
      {saved && (
        <p role="status" className="mb-4 rounded-2xl border border-accent-strong bg-surface p-3 font-bold">
          Saved as a routine {saved.folder ? <>in {saved.folder}</> : "not in a folder"}.
        </p>
      )}
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {r && (
        <>
          <p className="-mt-3 mb-4 flex flex-wrap items-center gap-2 text-muted">
            {folder ?? (r.folder_id ? "" : "Not in a folder")}
            {r.archived && <Badge tone="muted">Archived</Badge>}
          </p>
          {isNative() && !r.archived && (
            <Button variant="primary" className="mb-4 w-full" disabled={starter.busy} onClick={() => void starter.start(r.id)}>
              <Play size={20} aria-hidden /> Start workout
            </Button>
          )}
          {starter.problem && <p role="alert" className="mb-3 font-bold text-over">{starter.problem}</p>}
          {starter.sheet}
          <VersionView v={r.current_version} />
          <p className="mt-4 text-sm text-muted">W is a warm-up. Working sets count from 1.</p>
          <Link to={`/routines/${id}/versions`} className={`${btn.quiet} mt-2 w-full`}><History size={18} aria-hidden /> Versions</Link>
        </>
      )}
    </Page>
  );
}
