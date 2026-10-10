import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Sheet } from "../components/Sheet";
import { Button, Card, ErrorText, Loading, Page, Segmented, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { cached, refresh } from "../lib/offline";
import { weightText } from "../lib/plates";
import type { Bar, Gear, Plate, PlateSet, WeightUnit } from "../lib/types";

export const useGear = () =>
  useQuery({ queryKey: ["gear"], queryFn: cached(() => get<Gear>("/api/gear"), (c) => c.gear) });

/** Every gear change answers with the whole gear. Keeps the page and the phone's copy current. */
function useGearChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ method, path, body }: { method: string; path: string; body?: unknown }) => send<Gear>(method, `/api/gear${path}`, body),
    onSuccess: (g) => {
      qc.setQueryData(["gear"], g);
      // Deleting a bar or plate set puts exercises that used it back on the defaults.
      void qc.invalidateQueries({ queryKey: ["exercise"] });
      void refresh(true);
    },
  });
}

type Editing =
  | { kind: "bar"; bar?: Bar }
  | { kind: "set"; set?: PlateSet }
  | { kind: "plate"; set: PlateSet; plate?: Plate };

const PAIRS: [string, string][] = [["", "Unlimited pairs"], ...Array.from({ length: 12 }, (_, i): [string, string] => [String(i + 1), `${i + 1} ${i ? "pairs" : "pair"}`])];

/** Settings, Bars and plates. Editing needs a connection; plate math at the gym uses the copy on the phone. */
export default function GearPage() {
  const gear = useGear();
  const change = useGearChange();
  const [editing, setEditing] = useState<Editing | null>(null);
  const g = gear.data;
  const run = (method: string, path: string, body?: unknown) => change.mutateAsync({ method, path, body });

  return (
    <Page title="Bars and plates" back="/settings">
      {gear.isPending && <Loading />}
      <ErrorText error={gear.error} />
      {g && (
        <>
          <p className="mb-4 text-sm text-muted">Plate math uses these. Each exercise can pick its own bar and plates in the Library; otherwise it uses your defaults. Changes need a connection.</p>
          <ErrorText error={editing ? null : change.error} />
          <Card title="Defaults">
            <SelectField label="Default bar" value={g.default_bar_id ?? ""} options={g.bars.map((b) => [b.id, `${b.name}, ${weightText(b)}`])}
              onChange={(e) => void run("PATCH", "/defaults", { bar_id: e.target.value }).catch(() => {})} />
            <SelectField label="Default plates" value={g.default_plate_set_id ?? ""} options={g.plate_sets.map((s) => [s.id, s.name])}
              onChange={(e) => void run("PATCH", "/defaults", { plate_set_id: e.target.value }).catch(() => {})} />
          </Card>

          <Card title="Bars">
            <ul className="mb-3 divide-y divide-line">
              {g.bars.map((b) => (
                <li key={b.id} className="flex min-h-11 items-center justify-between gap-2 py-1">
                  <span><span className="font-bold">{b.name}</span> <span className="num text-muted">{weightText(b)}</span></span>
                  <EditButton label={`Edit ${b.name}`} onClick={() => setEditing({ kind: "bar", bar: b })} />
                </li>
              ))}
            </ul>
            <Button className="w-full" onClick={() => setEditing({ kind: "bar" })}><Plus size={18} aria-hidden /> Add a bar</Button>
          </Card>

          {g.plate_sets.map((s) => (
            <Card key={s.id} title={s.name}>
              {s.plates.length === 0 && <p className="mb-3 text-muted">No plates yet.</p>}
              <ul className="mb-3 divide-y divide-line">
                {s.plates.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 py-1">
                    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                      <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={p.enabled}
                        onChange={(e) => void run("PATCH", `/plates/${p.id}`, { enabled: e.target.checked }).catch(() => {})} />
                      <span className={`min-w-0 ${p.enabled ? "" : "text-muted line-through"}`}>
                        <span className="num font-bold">{p.name}</span>
                        {p.name !== weightText(p) && <span className="num text-muted"> {weightText(p)}</span>}
                        <span className="sr-only">{p.enabled ? ", on" : ", off"}</span>
                      </span>
                    </label>
                    <label className="shrink-0">
                      <span className="sr-only">Pairs of {p.name}</span>
                      <select value={p.pair_count?.toString() ?? ""} className="min-h-11 rounded-xl border border-line bg-ground px-2"
                        onChange={(e) => void run("PATCH", `/plates/${p.id}`, { pair_count: e.target.value ? Number(e.target.value) : null }).catch(() => {})}>
                        {(p.pair_count && p.pair_count > 12 ? [...PAIRS, [String(p.pair_count), `${p.pair_count} pairs`] as [string, string]] : PAIRS)
                          .map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </label>
                    <EditButton label={`Edit ${p.name}`} onClick={() => setEditing({ kind: "plate", set: s, plate: p })} />
                  </li>
                ))}
              </ul>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => setEditing({ kind: "plate", set: s })}><Plus size={18} aria-hidden /> Add a plate<span className="sr-only"> to {s.name}</span></Button>
                <Button onClick={() => setEditing({ kind: "set", set: s })}>Rename or delete<span className="sr-only"> {s.name}</span></Button>
              </div>
            </Card>
          ))}
          <Button className="w-full" onClick={() => setEditing({ kind: "set" })}><Plus size={18} aria-hidden /> Add a plate set</Button>

          <Sheet open={editing !== null} title={editing ? sheetTitle(editing) : ""} onClose={() => { setEditing(null); change.reset(); }}>
            {editing && <EditForm key={JSON.stringify(editing)} editing={editing} gear={g} busy={change.isPending} error={change.error}
              onSave={(method, path, body) => run(method, path, body).then(() => setEditing(null), () => {})} />}
          </Sheet>
        </>
      )}
    </Page>
  );
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-sunken">
      <Pencil size={18} aria-hidden /><span className="sr-only">{label}</span>
    </button>
  );
}

function sheetTitle(e: Editing): string {
  if (e.kind === "bar") return e.bar ? "Edit bar" : "Add a bar";
  if (e.kind === "set") return e.set ? "Plate set" : "Add a plate set";
  return e.plate ? "Edit plate" : `Add a plate to ${e.set.name}`;
}

const isWeight = (t: string) => /^\d+(\.\d{1,2})?$/.test(t.trim());

function EditForm({ editing: e, gear, busy, error, onSave }: {
  editing: Editing; gear: Gear; busy: boolean; error: unknown;
  onSave: (method: string, path: string, body?: unknown) => Promise<void>;
}) {
  const item = e.kind === "bar" ? e.bar : e.kind === "plate" ? e.plate : e.set;
  const weighted = e.kind !== "set";
  const [name, setName] = useState(item?.name ?? "");
  const [weight, setWeight] = useState(e.kind === "bar" ? e.bar?.weight_value ?? "" : e.kind === "plate" ? e.plate?.weight_value ?? "" : "");
  const [confirming, setConfirming] = useState(false);
  const [unit, setUnit] = useState<WeightUnit>(
    (e.kind === "bar" ? e.bar?.weight_unit : e.kind === "plate" ? e.plate?.weight_unit ?? e.set.plates[0]?.weight_unit : undefined) ?? "lb");
  const isDefault = (e.kind === "bar" && e.bar?.id === gear.default_bar_id) || (e.kind === "set" && e.set?.id === gear.default_plate_set_id);
  const nameNeeded = e.kind !== "plate";
  const ok = (!nameNeeded || name.trim()) && (!weighted || isWeight(weight));

  const save = () => {
    const body = weighted ? { name: name.trim() || null, weight_value: weight.trim(), weight_unit: unit } : { name: name.trim() };
    if (e.kind === "bar") return onSave(e.bar ? "PATCH" : "POST", e.bar ? `/bars/${e.bar.id}` : "/bars", body);
    if (e.kind === "set") return onSave(e.set ? "PATCH" : "POST", e.set ? `/plate-sets/${e.set.id}` : "/plate-sets", body);
    // An empty name on a plate means "name it after its weight".
    return onSave(e.plate ? "PATCH" : "POST", e.plate ? `/plates/${e.plate.id}` : `/plate-sets/${e.set.id}/plates`, { ...body, name: name.trim() || (e.plate ? "" : null) });
  };
  const remove = () => {
    if (e.kind === "bar" && e.bar) return onSave("DELETE", `/bars/${e.bar.id}`);
    if (e.kind === "set" && e.set) return onSave("DELETE", `/plate-sets/${e.set.id}`);
    if (e.kind === "plate" && e.plate) return onSave("DELETE", `/plates/${e.plate.id}`);
  };

  return (
    <form onSubmit={(x) => { x.preventDefault(); if (ok) void save(); }}>
      <TextField label="Name" required={nameNeeded} maxLength={80} value={name} onChange={(x) => setName(x.target.value)}
        hint={e.kind === "plate" ? "Leave empty to name it by its weight." : e.kind === "bar" ? "A sled or carriage works too." : undefined} />
      {weighted && (
        <>
          <TextField label="Weight" inputMode="decimal" required value={weight} onChange={(x) => setWeight(x.target.value)}
            hint={e.kind === "bar" ? "Up to two decimal places. Zero is fine for a sled with no weight of its own." : "Up to two decimal places."} />
          <Segmented<WeightUnit> label="Unit" name="gear-unit" value={unit} options={[["lb", "lb"], ["kg", "kg"]]} onChange={setUnit} />
        </>
      )}
      <ErrorText error={error} />
      <Button variant="primary" type="submit" className="w-full" disabled={busy || !ok}>Save</Button>
      {item && (
        isDefault ? (
          <p className="mt-3 text-sm text-muted">This is your default, so it can't be deleted. Pick another default first.</p>
        ) : (
          <Button className="mt-2 w-full text-over" disabled={busy} onClick={() => (confirming ? void remove() : setConfirming(true))}>
            {confirming ? "Tap again to delete" : `Delete${e.kind === "set" ? " this plate set and its plates" : ""}`}
          </Button>
        )
      )}
      {item && e.kind !== "plate" && !isDefault && (
        <p className="mt-2 text-sm text-muted">Exercises that use it go back to your default.</p>
      )}
    </form>
  );
}
