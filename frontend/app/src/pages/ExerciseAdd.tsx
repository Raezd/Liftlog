import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MusclePicker } from "../components/MusclePicker";
import { Badge, Button, Card, ErrorText, Page, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { EQUIPMENT, LOGGING } from "../lib/format";
import { refresh } from "../lib/offline";
import { useMuscleLabels } from "../lib/queries";
import type { CatalogEntry, Equipment, Exercise, LoggingType } from "../lib/types";

export const EQUIPMENT_OPTIONS = Object.entries(EQUIPMENT) as [Equipment, string][];
export const LOGGING_OPTIONS = Object.entries(LOGGING) as [LoggingType, string][];

/** Search results from the catalog. Shared with the import review screen. */
export function useCatalogSearch(q: string) {
  return useQuery({
    queryKey: ["catalog", q],
    queryFn: () => get<CatalogEntry[]>(`/api/catalog?q=${encodeURIComponent(q)}&limit=20`),
    enabled: q.trim().length >= 2,
    placeholderData: (prev) => prev,
  });
}

/** Add an exercise: from the catalog, or a custom one. */
export default function ExerciseAdd() {
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState(false);
  const results = useCatalogSearch(q);
  const label = useMuscleLabels();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (body: object) => send<Exercise>("POST", "/api/exercises", body),
    onSuccess: (ex) => {
      void qc.invalidateQueries({ queryKey: ["exercises"] });
      void refresh(true); // History, records, and muscle volume read the copy.
      navigate(`/library/${ex.id}`);
    },
  });

  return (
    <Page title="Add exercise" back="/library">
      {!custom && (
        <>
          <label className="mb-3 block">
            <span className="font-bold">Search all exercises</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus
              className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-3" />
          </label>
          <ErrorText error={add.error ?? results.error} />
          {results.data && results.data.length === 0 && <p className="text-muted">Nothing matches. Try other words, or make a custom exercise.</p>}
          {results.data && results.data.length > 0 && (
            <ul className="mb-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {results.data.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span>
                    <span className="block font-bold">{c.name}</span>
                    <span className="block text-sm text-muted">
                      {EQUIPMENT[c.equipment]}{c.primary_muscles.length ? `, ${c.primary_muscles.map(label).join(", ")}` : ""}
                    </span>
                    {c.shoulders && <Badge tone="muted">Delts to confirm</Badge>}
                  </span>
                  <Button variant="primary" disabled={add.isPending} onClick={() => add.mutate({ catalog_id: c.id })}
                    aria-label={`Add ${c.name}`}>Add</Button>
                </li>
              ))}
            </ul>
          )}
          <Button className="w-full" onClick={() => setCustom(true)}>Make a custom exercise</Button>
        </>
      )}
      {custom && <CustomForm initialName={q} onCancel={() => setCustom(false)} onSave={(b) => add.mutate(b)} busy={add.isPending} error={add.error} />}
    </Page>
  );
}

export type CustomBody = { name: string; equipment: Equipment; logging_type: LoggingType; primary_muscles: string[]; secondary_muscles: string[] };

function CustomForm({ initialName, onSave, onCancel, busy, error }: {
  initialName: string; onSave: (b: CustomBody) => void; onCancel: () => void; busy: boolean; error: unknown;
}) {
  const [b, setB] = useState<CustomBody>({
    name: initialName, equipment: "other", logging_type: "weight_reps", primary_muscles: [], secondary_muscles: [],
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(b); }}>
      <Card title="Custom exercise">
        <TextField label="Name" required maxLength={120} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />
        <SelectField label="Equipment" options={EQUIPMENT_OPTIONS} value={b.equipment}
          onChange={(e) => setB({ ...b, equipment: e.target.value as Equipment })} />
        <SelectField label="Logged as" options={LOGGING_OPTIONS} value={b.logging_type}
          onChange={(e) => setB({ ...b, logging_type: e.target.value as LoggingType })} />
        <MusclePicker primary={b.primary_muscles} secondary={b.secondary_muscles}
          onChange={(p, s) => setB({ ...b, primary_muscles: p, secondary_muscles: s })} />
        <ErrorText error={error} />
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !b.name.trim()}>Save</Button>
        </div>
      </Card>
    </form>
  );
}
