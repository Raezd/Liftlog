import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge, Button, ErrorText, Loading, Page, btn } from "../components/ui";
import { get } from "../lib/api";
import { longDate, plural } from "../lib/format";
import type { WorkoutSummary } from "../lib/types";

type PageData = { workouts: WorkoutSummary[]; more: boolean };

/** Every workout, newest first. Charts and PRs come later. */
export default function History() {
  const q = useInfiniteQuery({
    queryKey: ["workouts"],
    queryFn: ({ pageParam }) => get<PageData>(`/api/workouts?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.more ? last.workouts[last.workouts.length - 1].started_at : undefined),
  });
  const workouts = q.data?.pages.flatMap((p) => p.workouts) ?? [];

  return (
    <Page title="History">
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {q.isSuccess && workouts.length === 0 && (
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p>No workouts yet.</p>
          <Link to="/import" className={`${btn.primary} mt-3`}>Import from Hevy</Link>
        </div>
      )}
      {workouts.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {workouts.map((w) => (
            <li key={w.id}>
              <Link to={`/workouts/${w.id}`} className="block px-4 py-3 hover:bg-sunken focus-visible:bg-sunken">
                <span className="flex items-center justify-between gap-2 text-sm text-muted">
                  {longDate(w.workout_date)}
                  {w.source === "hevy_import" && <Badge tone="muted">Imported</Badge>}
                </span>
                <span className="block font-bold">{w.title}</span>
                <span className="block text-sm text-muted">
                  {plural(w.exercise_count, "exercise")}, {plural(w.set_count, "set")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <Button className="mt-4 w-full" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading..." : "Show older"}
        </Button>
      )}
    </Page>
  );
}
