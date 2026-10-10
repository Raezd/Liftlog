import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { MusclePicker } from "../components/MusclePicker";
import { Badge, Button, Card, ErrorText, Loading, Page, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { shortDate } from "../lib/format";
import { refresh } from "../lib/offline";
import { weightText } from "../lib/plates";
import { useMuscleLabels } from "../lib/queries";
import { FIELDS } from "../lib/session";
import type { Equipment, ExerciseDetail, LoggingType, MuscleMap } from "../lib/types";
import { EQUIPMENT_OPTIONS, LOGGING_OPTIONS } from "./ExerciseAdd";
import { useGear } from "./Gear";

type Form = {
  name: string; equipment: Equipment; logging_type: LoggingType; primary: string[]; secondary: string[];
  /** "" is the user's default. */
  plate_math: boolean; bar_id: string; plate_set_id: string;
};

/** Edit an exercise. Saving the muscles confirms them and is recorded. */
export default function ExerciseEdit() {
  const { id } = useParams();
  const qc = useQueryClient();
  const label = useMuscleLabels();
  const q = useQuery({ queryKey: ["exercise", id], queryFn: () => get<ExerciseDetail>(`/api/exercises/${id}`) });
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const ex = q.data;
  const gear = useGear();

  useEffect(() => {
    if (ex) setForm({
      name: ex.name, equipment: ex.equipment, logging_type: ex.logging_type, primary: ex.primary_muscles, secondary: ex.secondary_muscles,
      plate_math: ex.plate_math, bar_id: ex.bar_id ?? "", plate_set_id: ex.plate_set_id ?? "",
    });
  }, [ex]);

  const save = useMutation({
    mutationFn: (body: object) => send<ExerciseDetail>("PATCH", `/api/exercises/${id}`, body),
    onSuccess: (data) => {
      qc.setQueryData(["exercise", id], data);
      void qc.invalidateQueries({ queryKey: ["exercises"] });
      void qc.invalidateQueries({ queryKey: ["workout"] });
      void refresh(true); // History, records, and muscle volume read the copy.
      void qc.invalidateQueries({ queryKey: ["exercise-basic"] });
      setSaved(true);
    },
  });

  const map = (m: MuscleMap) => [
    m.primary.length ? m.primary.map(label).join(", ") : "none",
    m.secondary.length ? `; secondary ${m.secondary.map(label).join(", ")}` : "",
  ].join("");

  return (
    <Page title={ex?.name ?? "Exercise"} back={`/exercises/${id}`}>
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {ex && form && (
        <form onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ name: form.name, equipment: form.equipment, logging_type: form.logging_type,
            primary_muscles: form.primary, secondary_muscles: form.secondary,
            plate_math: form.plate_math, bar_id: form.bar_id || null, plate_set_id: form.plate_set_id || null });
        }}>
          {ex.needs_review && (
            <div className="mb-4 rounded-2xl border-2 border-accent bg-surface p-4" role="note">
              <Badge>Needs review</Badge>
              <p className="mt-2">The catalog only says "shoulders" for this one. Check which delts it works, then save to confirm.</p>
            </div>
          )}
          <Card>
            <TextField label="Name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <SelectField label="Equipment" options={EQUIPMENT_OPTIONS} value={form.equipment}
              onChange={(e) => {
                const equipment = e.target.value as Equipment;
                // Barbell exercises get plate math by default.
                setForm({ ...form, equipment, plate_math: equipment === "barbell" ? true : form.plate_math });
              }} />
            <SelectField label="Logged as" options={LOGGING_OPTIONS} value={form.logging_type}
              onChange={(e) => setForm({ ...form, logging_type: e.target.value as LoggingType })} />
          </Card>
          {FIELDS[form.logging_type].weight && (
            <Card title="Plate math">
              <label className="mb-3 flex min-h-11 items-center justify-between gap-3">
                <span>
                  Show plates
                  <span className="block text-sm text-muted">The weight field gets a plate button during workouts.</span>
                </span>
                <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={form.plate_math}
                  onChange={(e) => setForm({ ...form, plate_math: e.target.checked })} />
              </label>
              {form.plate_math && gear.data && (() => {
                const g = gear.data;
                const defBar = g.bars.find((b) => b.id === g.default_bar_id);
                const defSet = g.plate_sets.find((s) => s.id === g.default_plate_set_id);
                return (
                  <>
                    <SelectField label="Bar" value={form.bar_id} onChange={(e) => setForm({ ...form, bar_id: e.target.value })}
                      options={[["", `Default${defBar ? ` (${defBar.name}, ${weightText(defBar)})` : ""}`], ...g.bars.map((b): [string, string] => [b.id, `${b.name}, ${weightText(b)}`])]} />
                    <SelectField label="Plates" value={form.plate_set_id} onChange={(e) => setForm({ ...form, plate_set_id: e.target.value })}
                      options={[["", `Default${defSet ? ` (${defSet.name})` : ""}`], ...g.plate_sets.map((s): [string, string] => [s.id, s.name])]} />
                    <Link to="/settings/gear" className="text-sm font-bold text-accent-text underline">Edit bars and plates</Link>
                  </>
                );
              })()}
              <ErrorText error={gear.error} />
            </Card>
          )}
          <Card title="Muscles">
            <MusclePicker primary={form.primary} secondary={form.secondary} onChange={(p, s) => setForm({ ...form, primary: p, secondary: s })} />
          </Card>
          <ErrorText error={save.error} />
          {saved && !save.isPending && <p role="status" className="mb-3 font-bold text-accent-text">Saved.</p>}
          <Button variant="primary" type="submit" className="w-full" disabled={save.isPending || !form.name.trim()}>
            {ex.needs_review ? "Save and confirm muscles" : "Save"}
          </Button>
          <Button className="mt-2 w-full" disabled={save.isPending} onClick={() => { setSaved(false); save.mutate({ archived: !ex.archived }); }}>
            {ex.archived ? "Unarchive" : "Archive"}
          </Button>
          {ex.archived && <p className="mt-2 text-sm text-muted">Archived exercises stay in your history but are hidden from your library.</p>}
          {ex.muscle_history.length > 0 && (
            <Card title="Muscle changes" className="mt-4">
              <ul className="space-y-2 text-sm">
                {ex.muscle_history.map((h) => (
                  <li key={h.changed_at}>
                    <span className="font-bold">{shortDate(h.changed_at.slice(0, 10))}</span>: {map(h.old)} to {map(h.new)}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </form>
      )}
    </Page>
  );
}
