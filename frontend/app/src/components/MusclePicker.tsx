import { useMuscles } from "../lib/queries";
import { Chip } from "./ui";

/** Primary and secondary muscles as two sets of chips. A muscle can be in one list, not both. */
export function MusclePicker({ primary, secondary, onChange }: {
  primary: string[]; secondary: string[]; onChange: (primary: string[], secondary: string[]) => void;
}) {
  const { data: muscles } = useMuscles();
  if (!muscles) return null;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((m) => m !== id));
  const group = (label: string, hint: string, list: string[], other: string[], set: (next: string[]) => void) => (
    <fieldset className="mb-3">
      <legend className="font-bold">{label}</legend>
      <p className="text-sm text-muted">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {muscles.map((m) => (
          <Chip key={m.id} label={m.label} checked={list.includes(m.id)} disabled={other.includes(m.id)}
            onChange={(on) => set(toggle(list, m.id, on))} />
        ))}
      </div>
    </fieldset>
  );
  return (
    <>
      {group("Primary muscles", "Count as a full set.", primary, secondary, (p) => onChange(p, secondary))}
      {group("Secondary muscles", "Count as half a set.", secondary, primary, (s) => onChange(primary, s))}
    </>
  );
}
