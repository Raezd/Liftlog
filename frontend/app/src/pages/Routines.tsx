import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Sheet } from "../components/Sheet";
import { SortableList, moved } from "../components/Sortable";
import { Badge, Button, Chip, ErrorText, Loading, Page, SelectField, TextField, btn } from "../components/ui";
import { get, send } from "../lib/api";
import { plural } from "../lib/format";
import { uuid7 } from "../lib/ids";
import type { Folder, RoutineList, RoutineSummary } from "../lib/types";

type Target = { kind: "folder"; folder: Folder } | { kind: "routine"; routine: RoutineSummary } | { kind: "new-folder" };

export const useRoutineList = (archived = false) =>
  useQuery({ queryKey: ["routines", archived], queryFn: () => get<RoutineList>(`/api/routines?archived=${archived}`) });

/** Your programs (folders) and their days (routines), in your order. */
export default function Routines() {
  const [archived, setArchived] = useState(false);
  const [reorder, setReorder] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const qc = useQueryClient();
  const list = useRoutineList(archived);
  const data = list.data;

  const layout = useMutation({
    mutationFn: (next: RoutineList) => send("PUT", "/api/routines/layout", {
      folders: next.folders.map((f) => f.id),
      groups: [...next.folders.map((f) => ({ folder_id: f.id, routine_ids: f.routines.map((r) => r.id) })),
        { folder_id: null, routine_ids: next.routines.map((r) => r.id) }],
    }),
    onMutate: (next) => qc.setQueryData(["routines", archived], next),
    onSettled: () => qc.invalidateQueries({ queryKey: ["routines"] }),
  });

  const empty = data && data.folders.length === 0 && data.routines.length === 0;

  return (
    <Page title="Routines" action={<Link to="/routines/new" className={btn.primary}><Plus size={20} aria-hidden /> New</Link>}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip label="Show archived" checked={archived} onChange={setArchived} />
        {!empty && data && (
          <Button variant={reorder ? "primary" : "secondary"} onClick={() => setReorder(!reorder)} aria-pressed={reorder}>
            {reorder ? "Done" : "Reorder"}
          </Button>
        )}
      </div>
      {list.isPending && <Loading />}
      <ErrorText error={list.error ?? layout.error} />
      {empty && (
        <div className="mb-4 rounded-2xl border border-line bg-surface p-4">
          <p>{archived ? "Nothing here yet." : "No routines yet."}</p>
          <p className="mt-1 text-sm text-muted">Make one from scratch, or open a workout in History and save it as a routine.</p>
        </div>
      )}

      {data && reorder && <ReorderView data={data} onChange={(next) => layout.mutate(next)} />}

      {data && !reorder && (
        <>
          {data.folders.map((f) => (
            <section key={f.id} aria-label={f.name} className="mb-4 rounded-2xl border border-line bg-surface">
              <div className="flex items-center justify-between gap-2 border-b border-line py-1 pl-4 pr-1">
                <h2 className="display min-w-0 break-words text-lg font-bold">{f.name}</h2>
                <span className="flex items-center gap-1">
                  {f.archived && <Badge tone="muted">Archived</Badge>}
                  <MoreButton label={`Options for ${f.name}`} onClick={() => setTarget({ kind: "folder", folder: f })} />
                </span>
              </div>
              <RoutineRows routines={f.routines} onMore={(r) => setTarget({ kind: "routine", routine: r })} />
              <Link to={`/routines/new?folder=${f.id}`} className={`${btn.quiet} m-1`}>
                <Plus size={18} aria-hidden /> Add a routine<span className="sr-only"> to {f.name}</span>
              </Link>
            </section>
          ))}
          {data.routines.length > 0 && (
            <section aria-label="Not in a folder" className="mb-4 rounded-2xl border border-line bg-surface">
              {data.folders.length > 0 && <h2 className="border-b border-line px-4 py-3 text-sm font-bold text-muted">Not in a folder</h2>}
              <RoutineRows routines={data.routines} onMore={(r) => setTarget({ kind: "routine", routine: r })} />
            </section>
          )}
          <Button className="w-full" onClick={() => setTarget({ kind: "new-folder" })}>
            <FolderPlus size={20} aria-hidden /> New folder
          </Button>
        </>
      )}

      {data && <ActionSheet target={target} folders={data.folders} onClose={() => setTarget(null)} />}
    </Page>
  );
}

function MoreButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-sunken">
      <MoreHorizontal size={20} aria-hidden /><span className="sr-only">{label}</span>
    </button>
  );
}

function summary(r: RoutineSummary): string {
  if (r.exercise_names.length === 0) return "No exercises yet";
  const shown = r.exercise_names.slice(0, 3).join(", ");
  const more = r.exercise_names.length - 3;
  return `${shown}${more > 0 ? `, and ${more} more` : ""}`;
}

function RoutineRows({ routines, onMore }: { routines: RoutineSummary[]; onMore: (r: RoutineSummary) => void }) {
  if (routines.length === 0) return <p className="px-4 py-3 text-sm text-muted">No routines in this folder.</p>;
  return (
    <ul className="divide-y divide-line">
      {routines.map((r) => (
        <li key={r.id} className="flex items-center gap-1 pr-1">
          <Link to={`/routines/${r.id}`} className="min-w-0 flex-1 px-4 py-3 hover:bg-sunken focus-visible:bg-sunken">
            <span className="flex items-center gap-2">
              <span className="font-bold">{r.name}</span>
              {r.archived && <Badge tone="muted">Archived</Badge>}
            </span>
            <span className="block text-sm text-muted">{summary(r)}</span>
            <span className="block text-sm text-muted">{plural(r.set_count, "set")}</span>
          </Link>
          <MoreButton label={`Options for ${r.name}`} onClick={() => onMore(r)} />
        </li>
      ))}
    </ul>
  );
}

function ReorderView({ data, onChange }: { data: RoutineList; onChange: (next: RoutineList) => void }) {
  const routines = (rs: RoutineSummary[], label: string, set: (next: RoutineSummary[]) => void) => (
    rs.length > 0 && (
      <SortableList label={`Routines in ${label}`} items={rs} keyOf={(r) => r.id} labelOf={(r) => r.name}
        onMove={(a, b) => set(moved(rs, a, b))}>
        {(r) => <span className="flex min-h-11 items-center px-2 font-bold">{r.name}</span>}
      </SortableList>
    )
  );
  return (
    <>
      <p className="mb-3 text-sm text-muted">Drag the handles, or use the arrows. To move a routine to another folder, use its options.</p>
      {data.folders.length > 1 && (
        <>
          <h2 className="display mb-2 text-lg font-bold">Folders</h2>
          <div className="mb-6">
            <SortableList label="Folders" items={data.folders} keyOf={(f) => f.id} labelOf={(f) => f.name}
              onMove={(a, b) => onChange({ ...data, folders: moved(data.folders, a, b) })}>
              {(f) => <span className="flex min-h-11 items-center px-2 font-bold">{f.name}</span>}
            </SortableList>
          </div>
        </>
      )}
      {data.folders.map((f, i) => f.routines.length > 1 && (
        <div key={f.id} className="mb-6">
          <h2 className="display mb-2 text-lg font-bold">{f.name}</h2>
          {routines(f.routines, f.name, (next) =>
            onChange({ ...data, folders: data.folders.map((x, j) => (j === i ? { ...x, routines: next } : x)) }))}
        </div>
      ))}
      {data.routines.length > 1 && (
        <div className="mb-6">
          <h2 className="display mb-2 text-lg font-bold">Not in a folder</h2>
          {routines(data.routines, "no folder", (next) => onChange({ ...data, routines: next }))}
        </div>
      )}
    </>
  );
}

function ActionSheet({ target, folders, onClose }: { target: Target | null; folders: Folder[]; onClose: () => void }) {
  const title = !target ? "" : target.kind === "folder" ? target.folder.name : target.kind === "routine" ? target.routine.name : "New folder";
  return (
    <Sheet open={target !== null} title={title} onClose={onClose}>
      {target?.kind === "new-folder" && <NewFolder onDone={onClose} />}
      {target?.kind === "folder" && <FolderActions key={target.folder.id} folder={target.folder} onDone={onClose} />}
      {target?.kind === "routine" && <RoutineActions key={target.routine.id} routine={target.routine} folders={folders} onDone={onClose} />}
    </Sheet>
  );
}

/** A request that refreshes the routines list and closes the sheet when it's done. */
function useListAction(onDone: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method, path, body }: { method: string; path: string; body?: unknown }) => send(method, path, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      onDone();
    },
  });
}

function NewFolder({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const act = useListAction(onDone);
  return (
    <form onSubmit={(e) => { e.preventDefault(); act.mutate({ method: "POST", path: "/api/folders", body: { id: uuid7(), name } }); }}>
      <TextField label="Name" hint='A program, like "Upper/Lower" or "PPL".' required maxLength={120} autoFocus
        value={name} onChange={(e) => setName(e.target.value)} />
      <ErrorText error={act.error} />
      <Button variant="primary" type="submit" className="w-full" disabled={act.isPending || !name.trim()}>Make folder</Button>
    </form>
  );
}

function Rename({ initial, onSave, busy }: { initial: string; onSave: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState(initial);
  return (
    <form className="mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); onSave(name); }}>
      <div className="flex-1"><TextField label="Name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></div>
      <Button type="submit" className="mb-3" disabled={busy || !name.trim() || name.trim() === initial}>Rename</Button>
    </form>
  );
}

function DeleteButton({ what, used, usedText, onDelete, busy }: { what: string; used: boolean; usedText: string; onDelete: () => void; busy: boolean }) {
  const [sure, setSure] = useState(false);
  if (used) return <p className="mt-3 text-sm text-muted">{usedText}</p>;
  if (!sure) return <Button className="mt-2 w-full text-over" onClick={() => setSure(true)}>Delete</Button>;
  return (
    <div className="mt-2 rounded-xl border border-over p-3">
      <p className="mb-2 font-bold">Delete {what}? This can't be undone.</p>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => setSure(false)}>Keep</Button>
        <Button variant="primary" disabled={busy} onClick={onDelete}>Delete</Button>
      </div>
    </div>
  );
}

function FolderActions({ folder: f, onDone }: { folder: Folder; onDone: () => void }) {
  const act = useListAction(onDone);
  const path = `/api/folders/${f.id}`;
  return (
    <>
      <Rename initial={f.name} busy={act.isPending} onSave={(name) => act.mutate({ method: "PATCH", path, body: { name } })} />
      <div className="grid gap-2">
        <Link to={`/routines/new?folder=${f.id}`} className={btn.secondary}>Add a routine</Link>
        <Button disabled={act.isPending} onClick={() => act.mutate({ method: "POST", path: `${path}/duplicate`, body: { id: uuid7() } })}>
          Duplicate folder
        </Button>
        <Button disabled={act.isPending} onClick={() => act.mutate({ method: "PATCH", path, body: { archived: !f.archived } })}>
          {f.archived ? "Restore" : "Archive"}
        </Button>
      </div>
      <DeleteButton what={f.routines.length ? `${f.name} and its ${plural(f.routines.length, "routine")}` : f.name}
        used={f.used} usedText="A workout used a routine in this folder, so it can be archived but not deleted."
        busy={act.isPending} onDelete={() => act.mutate({ method: "DELETE", path })} />
      <ErrorText error={act.error} />
    </>
  );
}

function RoutineActions({ routine: r, folders, onDone }: { routine: RoutineSummary; folders: Folder[]; onDone: () => void }) {
  const act = useListAction(onDone);
  const [folder, setFolder] = useState(r.folder_id ?? "");
  const path = `/api/routines/${r.id}`;
  return (
    <>
      <Rename initial={r.name} busy={act.isPending} onSave={(name) => act.mutate({ method: "PATCH", path, body: { name } })} />
      <form className="mb-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ method: "PATCH", path, body: { folder_id: folder || null } }); }}>
        <div className="flex-1">
          <SelectField label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)}
            options={[["", "No folder"], ...folders.filter((f) => !f.archived || f.id === r.folder_id).map((f): [string, string] => [f.id, f.name])]} />
        </div>
        <Button type="submit" className="mb-3" disabled={act.isPending || folder === (r.folder_id ?? "")}>Move</Button>
      </form>
      <div className="grid gap-2">
        <Link to={`/routines/${r.id}`} className={btn.secondary}>Edit</Link>
        <Link to={`/routines/${r.id}/versions`} className={btn.secondary}>Earlier versions</Link>
        <Button disabled={act.isPending} onClick={() => act.mutate({ method: "POST", path: `${path}/duplicate`, body: { id: uuid7() } })}>
          Duplicate
        </Button>
        <Button disabled={act.isPending} onClick={() => act.mutate({ method: "PATCH", path, body: { archived: !r.archived } })}>
          {r.archived ? "Restore" : "Archive"}
        </Button>
      </div>
      <DeleteButton what={r.name} used={r.used} usedText="A workout used this routine, so it can be archived but not deleted."
        busy={act.isPending} onDelete={() => act.mutate({ method: "DELETE", path })} />
      <ErrorText error={act.error} />
    </>
  );
}
