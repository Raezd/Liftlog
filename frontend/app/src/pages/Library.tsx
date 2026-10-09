import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Chip, ErrorText, Loading, Page, btn } from "../components/ui";
import { get } from "../lib/api";
import { EQUIPMENT, LOGGING } from "../lib/format";
import { useMuscleLabels } from "../lib/queries";
import type { Exercise } from "../lib/types";

/** Your exercises: the ones you've added or imported. */
export default function Library() {
  const [q, setQ] = useState("");
  const [review, setReview] = useState(false);
  const [archived, setArchived] = useState(false);
  const label = useMuscleLabels();
  const params = new URLSearchParams({ q, needs_review: String(review), archived: String(archived) });
  const list = useQuery({
    queryKey: ["exercises", q, review, archived],
    queryFn: () => get<Exercise[]>(`/api/exercises?${params}`),
    placeholderData: (prev) => prev,
  });

  return (
    <Page title="Library" action={<Link to="/library/add" className={btn.primary}><Plus size={20} aria-hidden /> Add</Link>}>
      <label className="mb-3 block">
        <span className="sr-only">Search your exercises</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your exercises"
          className="block min-h-11 w-full rounded-xl border border-line bg-surface px-3" />
      </label>
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip label="Needs review" checked={review} onChange={setReview} />
        <Chip label="Archived" checked={archived} onChange={setArchived} />
      </div>
      {list.isPending && <Loading />}
      <ErrorText error={list.error} />
      {list.data && list.data.length === 0 && (
        <p className="text-muted">
          {q || review || archived ? "Nothing matches." : "No exercises yet. Add one, or import your Hevy history."}
        </p>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {list.data.map((e) => (
            <li key={e.id}>
              <Link to={`/library/${e.id}`} className="block px-4 py-3 hover:bg-sunken focus-visible:bg-sunken">
                <span className="flex items-start justify-between gap-2">
                  <span className="font-bold">{e.name}</span>
                  {e.needs_review && <Badge>Needs review</Badge>}
                </span>
                <span className="block text-sm text-muted">
                  {EQUIPMENT[e.equipment]}, {LOGGING[e.logging_type].toLowerCase()}
                </span>
                <span className="block text-sm text-muted">
                  {e.primary_muscles.length ? e.primary_muscles.map(label).join(", ") : "Muscles unassigned"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
