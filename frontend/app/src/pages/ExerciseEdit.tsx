import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { MusclePicker } from "../components/MusclePicker";
import { Badge, Button, Card, ErrorText, Loading, Page, SelectField, TextField } from "../components/ui";
import { get, send } from "../lib/api";
import { shortDate } from "../lib/format";
import { useMuscleLabels } from "../lib/queries";
import type { Equipment, ExerciseDetail, LoggingType, MuscleMap } from "../lib/types";
import { EQUIPMENT_OPTIONS, LOGGING_OPTIONS } from "./ExerciseAdd";

type Form = { name: string; equipment: Equipment; logging_type: LoggingType; primary: string[]; secondary: string[] };

/** Edit an exercise. Saving the muscles confirms them and is recorded. */
export default function ExerciseEdit() {
  const { id } = useParams();
  const qc = useQueryClient();
  const label = useMuscleLabels();
  const q = useQuery({ queryKey: ["exercise", id], queryFn: () => get<ExerciseDetail>(`/api/exercises/${id}`) });
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  const ex = q.data;

  useEffect(() => {
    if (ex) setForm({ name: ex.name, equipment: ex.equipment, logging_type: ex.logging_type, primary: ex.primary_muscles, secondary: ex.secondary_muscles });
  }, [ex]);

  const save = useMutation({
    mutationFn: (body: object) => send<ExerciseDetail>("PATCH", `/api/exercises/${id}`, body),
    onSuccess: (data) => {
      qc.setQueryData(["exercise", id], data);
      void qc.invalidateQueries({ queryKey: ["exercises"] });
      void qc.invalidateQueries({ queryKey: ["workout"] });
      setSaved(true);
    },
  });

  const map = (m: MuscleMap) => [
    m.primary.length ? m.primary.map(label).join(", ") : "none",
    m.secondary.length ? `; secondary ${m.secondary.map(label).join(", ")}` : "",
  ].join("");

  return (
    <Page title={ex?.name ?? "Exercise"} back="/library">
      {q.isPending && <Loading />}
      <ErrorText error={q.error} />
      {ex && form && (
        <form onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ name: form.name, equipment: form.equipment, logging_type: form.logging_type,
            primary_muscles: form.primary, secondary_muscles: form.secondary });
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
              onChange={(e) => setForm({ ...form, equipment: e.target.value as Equipment })} />
            <SelectField label="Logged as" options={LOGGING_OPTIONS} value={form.logging_type}
              onChange={(e) => setForm({ ...form, logging_type: e.target.value as LoggingType })} />
          </Card>
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
