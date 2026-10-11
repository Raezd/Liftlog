import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Sheet } from "../components/Sheet";
import { Button, Card, ErrorText, Loading, Page, Segmented, TextField } from "../components/ui";
import { useBody, useBodyChange } from "../lib/queries";
import type { BodySite } from "../lib/types";
import { useOnline } from "../lib/useOnline";
import { NEEDS_CONNECTION } from "./Body";

/** Body, Manage sites: add custom sites, rename and archive any site, delete one with no values. */
export default function BodySites() {
  const q = useBody();
  const online = useOnline();
  const change = useBodyChange();
  const [editing, setEditing] = useState<BodySite | "new" | null>(null);
  const b = q.data;
  const run = (method: string, path: string, body?: unknown) => change.mutateAsync({ method, path, body });
  const close = () => { setEditing(null); change.reset(); };
  const active = b?.sites.filter((s) => !s.archived) ?? [];
  const archived = b?.sites.filter((s) => s.archived) ?? [];

  const row = (s: BodySite) => (
    <li key={s.id} className="flex min-h-11 items-center justify-between gap-2 py-1">
      <span>
        <span className="font-bold">{s.name}</span>
        {s.paired && <span className="text-sm text-muted"> left and right</span>}
      </span>
      <button type="button" disabled={!online} onClick={() => setEditing(s)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-sunken disabled:opacity-50">
        <Pencil size={18} aria-hidden /><span className="sr-only">Edit {s.name}</span>
      </button>
    </li>
  );

  return (
    <Page title="Sites" back="/body">
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {b && (
        <>
          <p className="mb-4 text-sm text-muted">{online ? "Archived sites drop off the Body tab and the check-in form. Their values are kept." : NEEDS_CONNECTION}</p>
          <ErrorText error={editing ? null : change.error} />
          <Card title="Active">
            {active.length === 0 && <p className="mb-3 text-muted">None.</p>}
            <ul className="mb-3 divide-y divide-line">{active.map(row)}</ul>
            <Button className="w-full" disabled={!online} onClick={() => setEditing("new")}><Plus size={18} aria-hidden /> Add a site</Button>
          </Card>
          {archived.length > 0 && (
            <Card title="Archived"><ul className="divide-y divide-line">{archived.map(row)}</ul></Card>
          )}
          <Sheet open={editing !== null} title={editing === "new" ? "Add a site" : "Edit site"} onClose={close}>
            {editing && <SiteForm key={editing === "new" ? "new" : editing.id} site={editing === "new" ? null : editing}
              busy={change.isPending} error={change.error} onSave={(m, p, body) => run(m, p, body).then(close, () => {})} />}
          </Sheet>
        </>
      )}
    </Page>
  );
}

function SiteForm({ site, busy, error, onSave }: {
  site: BodySite | null; busy: boolean; error: unknown; onSave: (method: string, path: string, body?: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(site?.name ?? "");
  const [paired, setPaired] = useState<"one" | "two">(site?.paired ? "two" : "one");
  const [confirming, setConfirming] = useState(false);
  const ok = name.trim().length > 0;
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!ok) return;
      void (site ? onSave("PATCH", `/sites/${site.id}`, { name }) : onSave("POST", "/sites", { name, paired: paired === "two" }));
    }}>
      <TextField label="Name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      {site ? (
        <p className="mb-3 text-sm text-muted">{site.paired ? "Measured left and right." : "One value."}</p>
      ) : (
        <Segmented label="Measured" name="site-paired" value={paired} onChange={setPaired} options={[["one", "One value"], ["two", "Left and right"]]} />
      )}
      <ErrorText error={error} />
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !ok}>Save</Button>
      {site && (
        <>
          <Button className="mt-2 w-full" disabled={busy} onClick={() => void onSave("PATCH", `/sites/${site.id}`, { archived: !site.archived })}>
            {site.archived ? "Restore" : "Archive"}
          </Button>
          {site.has_values ? (
            <p className="mt-2 text-sm text-muted">It has measurements, so it can be archived but not deleted.</p>
          ) : (
            <Button className="mt-2 w-full text-over" disabled={busy} onClick={() => (confirming ? void onSave("DELETE", `/sites/${site.id}`) : setConfirming(true))}>
              {confirming ? "Tap again to delete" : "Delete"}
            </Button>
          )}
        </>
      )}
    </form>
  );
}
