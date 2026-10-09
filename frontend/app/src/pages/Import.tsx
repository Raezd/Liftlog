import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Chip, ErrorText, Page, SelectField, TextField, btn } from "../components/ui";
import { api } from "../lib/api";
import { EQUIPMENT, plural, shortDate } from "../lib/format";
import { useMuscleLabels } from "../lib/queries";
import type { CatalogEntry, Counts, Equipment, ImportPreview, ImportResult, LoggingType, TitleReview } from "../lib/types";
import { EQUIPMENT_OPTIONS, LOGGING_OPTIONS, useCatalogSearch } from "./ExerciseAdd";

const DELTS: [string, string][] = [["front_delts", "Front delts"], ["side_delts", "Side delts"], ["rear_delts", "Rear delts"]];
// Matches this strong start out picked. Everything is still shown to check.
const STRONG = 1.1;

type Choice =
  | { kind: "catalog"; entry: CatalogEntry; delts: string[]; confirm: boolean; fromSearch?: boolean }
  | { kind: "existing"; id: string; name: string }
  | { kind: "custom"; name: string; equipment: Equipment; logging_type: LoggingType }
  | { kind: "search" };

function upload<T>(path: string, file: File, extra?: Record<string, string>) {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
  return api<T>(path, { method: "POST", body: form, timeoutMs: 120000 });
}

const deltsOf = (e: CatalogEntry) => DELTS.map(([d]) => d).filter((d) => e.primary_muscles.includes(d) || e.secondary_muscles.includes(d));

function catalogChoice(entry: CatalogEntry, fromSearch = false): Choice {
  return { kind: "catalog", entry, delts: deltsOf(entry), confirm: false, fromSearch };
}

function initialChoice(t: TitleReview): Choice | undefined {
  const exact = t.user_matches?.find((u) => u.name.toLowerCase() === t.title.toLowerCase());
  if (exact) return { kind: "existing", id: exact.id, name: exact.name };
  const top = t.suggestions?.[0];
  if (top && (top.score ?? 0) >= STRONG) return catalogChoice(top);
  return undefined;
}

function isComplete(c: Choice | undefined): boolean {
  if (!c || c.kind === "search") return false;
  if (c.kind === "custom") return c.name.trim().length > 0;
  return true;
}

function resolution(c: Choice) {
  if (c.kind === "existing") return { action: "existing", exercise_id: c.id };
  if (c.kind === "custom") return { action: "custom", name: c.name, equipment: c.equipment, logging_type: c.logging_type };
  if (c.kind !== "catalog") throw new Error("unresolved");
  const e = c.entry;
  if (!e.shoulders) return { action: "catalog", catalog_id: e.id };
  const isDelt = (m: string) => DELTS.some(([d]) => d === m);
  const primary = e.primary_muscles.filter((m) => !isDelt(m));
  const secondary = e.secondary_muscles.filter((m) => !isDelt(m));
  (e.shoulders_role === "primary" ? primary : secondary).push(...c.delts);
  return { action: "catalog", catalog_id: e.id, primary_muscles: primary, secondary_muscles: secondary, confirm_muscles: c.confirm };
}

function CountRow({ label, c, hint }: { label: string; c: Counts; hint?: string }) {
  return (
    <div className="flex justify-between gap-3 border-t border-line py-2 first:border-t-0">
      <dt>{label}{hint && <span className="block text-sm text-muted">{hint}</span>}</dt>
      <dd className="num text-right font-bold">{plural(c.workouts, "workout")}<span className="block text-sm font-normal text-muted">{plural(c.sets, "set")}</span></dd>
    </div>
  );
}

/** Import Hevy history: upload, review exercise matches, import. */
export default function Import() {
  const [file, setFile] = useState<File | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice | undefined>>({});
  const qc = useQueryClient();

  const preview = useMutation({
    mutationFn: (f: File) => upload<ImportPreview>("/api/imports/hevy/preview", f),
    onSuccess: (p) => setChoices(Object.fromEntries(p.titles.filter((t) => !t.mapped_to).map((t) => [t.title, initialChoice(t)]))),
  });
  const commit = useMutation({
    mutationFn: () => {
      const res = Object.fromEntries(Object.entries(choices).map(([t, c]) => [t, resolution(c!)]));
      return upload<ImportResult>("/api/imports/hevy", file!, { resolutions: JSON.stringify(res) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["workouts"] });
      void qc.invalidateQueries({ queryKey: ["exercises"] });
    },
  });

  const p = preview.data;
  const toReview = p?.titles.filter((t) => !t.mapped_to) ?? [];
  const matched = p?.titles.filter((t) => t.mapped_to) ?? [];
  const left = toReview.filter((t) => !isComplete(choices[t.title])).length;
  const reset = () => { setFile(null); preview.reset(); commit.reset(); setChoices({}); };

  if (commit.data) {
    const r = commit.data;
    return (
      <Page title="Import" back="/settings">
        <Card title="Done">
          <dl><CountRow label="Added" c={r.added} />
            <CountRow label="Already here, skipped" c={r.skipped} />
            <CountRow label="Changed in Hevy, not overwritten" c={r.conflicting} /></dl>
        </Card>
        {r.conflicting.workouts > 0 && p && <Conflicts p={p} />}
        <div className="grid grid-cols-2 gap-2">
          <Link to="/history" className={btn.primary}>See history</Link>
          <Button onClick={reset}>Import another</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Import" back="/settings">
      {!p && (
        <>
          <p className="mb-4">
            In Hevy, open Profile, then Settings, then Export &amp; Import Data, and export your workouts.
            Import the whole file each time. Workouts already here are skipped.
          </p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line bg-surface p-6 text-center focus-within:ring-2 focus-within:ring-accent">
            <FileUp size={28} className="text-muted" aria-hidden />
            <span className="font-bold">{preview.isPending ? "Reading..." : file ? file.name : "Choose the Hevy CSV file"}</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" disabled={preview.isPending}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f) preview.mutate(f);
              }} />
          </label>
          <ErrorText error={preview.error} />
        </>
      )}

      {p && (
        <>
          <Card title="In this file">
            <p className="mb-2 text-sm text-muted">
              {shortDate(p.first_date)} to {shortDate(p.last_date)}. Weights in {p.weight_unit}, distances in {p.distance_unit}.
            </p>
            <dl>
              <CountRow label="New" c={p.new} />
              <CountRow label="Already here" c={p.skipped} hint="Skipped" />
              {p.conflicting.workouts > 0 && <CountRow label="Changed in Hevy" c={p.conflicting} hint="Kept as they are here, never overwritten" />}
            </dl>
          </Card>
          {p.conflicting.workouts > 0 && <Conflicts p={p} />}

          {toReview.length > 0 && (
            <>
              <h2 className="display mb-1 mt-6 text-xl font-bold">Match your exercises</h2>
              <p className="mb-4 text-muted">
                Pick what each Hevy exercise is. Strong matches are picked for you; check them. You'll only be asked once per exercise.
              </p>
              {toReview.map((t) => (
                <TitleCard key={t.title} t={t} choice={choices[t.title]} onChoose={(c) => setChoices((cs) => ({ ...cs, [t.title]: c }))} />
              ))}
            </>
          )}
          {matched.length > 0 && (
            <p className="mb-4 text-sm text-muted">{plural(matched.length, "exercise")} already matched from before.</p>
          )}

          <ErrorText error={commit.error} />
          <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] -mx-4 border-t border-line bg-ground px-4 py-3">
            {left > 0 && <p className="mb-2 text-center text-sm font-bold" aria-live="polite">{plural(left, "exercise")} left to match</p>}
            <div className="grid grid-cols-3 gap-2">
              <Button onClick={reset} disabled={commit.isPending}>Cancel</Button>
              <Button variant="primary" className="col-span-2" disabled={left > 0 || commit.isPending} onClick={() => commit.mutate()}>
                {commit.isPending ? "Importing..." : p.new.workouts ? `Import ${plural(p.new.workouts, "workout")}` : "Import"}
              </Button>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

function Conflicts({ p }: { p: ImportPreview }) {
  return (
    <Card title="Changed in Hevy since you imported">
      <p className="mb-2 text-sm text-muted">These stay as they are here. Nothing was overwritten.</p>
      <ul className="text-sm">
        {p.conflicts.map((c) => <li key={c.start + c.title}>{shortDate(c.start.slice(0, 10))}: {c.title}</li>)}
      </ul>
    </Card>
  );
}

function TitleCard({ t, choice, onChoose }: { t: TitleReview; choice: Choice | undefined; onChoose: (c: Choice) => void }) {
  const label = useMuscleLabels();
  const [q, setQ] = useState(t.title.replace(/\(.*?\)/g, "").trim());
  const search = useCatalogSearch(choice?.kind === "search" || (choice?.kind === "catalog" && choice.fromSearch) ? q : "");
  const name = `pick-${t.title}`;
  const value =
    !choice ? "" : choice.kind === "catalog" ? (choice.fromSearch ? "search" : `c:${choice.entry.id}`)
      : choice.kind === "existing" ? `u:${choice.id}` : choice.kind;
  const muscles = (e: CatalogEntry) => e.primary_muscles.map(label).join(", ") || "Muscles unassigned";

  const option = (v: string, title: string, sub: string | null, onPick: () => void) => (
    <label key={v} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-sunken has-[:checked]:bg-sunken">
      <input type="radio" name={name} className="mt-1 size-5 shrink-0 accent-[var(--accent-strong)]" checked={value === v} onChange={onPick} />
      <span><span className="block font-bold">{title}</span>{sub && <span className="block text-sm text-muted">{sub}</span>}</span>
    </label>
  );

  return (
    <section className={`mb-4 rounded-2xl border bg-surface p-4 ${isComplete(choice) ? "border-line" : "border-accent border-2"}`} aria-label={t.title}>
      <h3 className="display text-lg font-bold">{t.title}</h3>
      <p className="mb-2 text-sm text-muted">{plural(t.sets, "set")} in Hevy</p>
      <fieldset>
        <legend className="sr-only">What is {t.title}?</legend>
        {t.suggestions?.map((s) => option(`c:${s.id}`, s.name, `${EQUIPMENT[s.equipment]}, ${muscles(s)}`, () => onChoose(catalogChoice(s))))}
        {t.user_matches?.map((u) => option(`u:${u.id}`, `Merge into ${u.name}`, "One of your exercises", () => onChoose({ kind: "existing", id: u.id, name: u.name })))}
        {option("search", "Search for another", null, () => onChoose({ kind: "search" }))}
        {option("custom", "Make it a custom exercise", null, () =>
          onChoose({ kind: "custom", name: t.title, equipment: t.equipment ?? "other", logging_type: t.logging_type ?? "weight_reps" }))}
      </fieldset>

      {(choice?.kind === "search" || (choice?.kind === "catalog" && choice.fromSearch)) && (
        <div className="mt-2 border-t border-line pt-3">
          <label className="block">
            <span className="font-bold">Search all exercises</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
              className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-ground px-3" />
          </label>
          {search.data && search.data.length === 0 && <p className="mt-2 text-sm text-muted">Nothing matches.</p>}
          <ul className="mt-2">
            {search.data?.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onChoose(catalogChoice(s, true))}
                  aria-pressed={choice.kind === "catalog" && choice.entry.id === s.id}
                  className="flex min-h-11 w-full flex-col items-start rounded-xl px-2 py-2 text-left hover:bg-sunken aria-pressed:bg-accent-strong aria-pressed:text-white">
                  <span className="font-bold">{s.name}</span>
                  <span className="text-sm opacity-80">{EQUIPMENT[s.equipment]}, {muscles(s)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {choice?.kind === "custom" && (
        <div className="mt-2 border-t border-line pt-3">
          <TextField label="Name" maxLength={120} value={choice.name} onChange={(e) => onChoose({ ...choice, name: e.target.value })} />
          <SelectField label="Equipment" options={EQUIPMENT_OPTIONS} value={choice.equipment}
            onChange={(e) => onChoose({ ...choice, equipment: e.target.value as Equipment })} />
          <SelectField label="Logged as" options={LOGGING_OPTIONS} value={choice.logging_type}
            onChange={(e) => onChoose({ ...choice, logging_type: e.target.value as LoggingType })} />
          <p className="text-sm text-muted">Set its muscles in your library after the import.</p>
        </div>
      )}

      {choice?.kind === "catalog" && choice.entry.shoulders && (
        <div className="mt-2 border-t border-line pt-3"><fieldset>
          <legend className="font-bold">Which delts? <Badge>Needs review</Badge></legend>
          <p className="mb-2 text-sm text-muted">
            The catalog only says "shoulders". This is our guess from the name, as {choice.entry.shoulders_role} muscles.
          </p>
          <div className="flex flex-wrap gap-2">
            {DELTS.map(([d, l]) => (
              <Chip key={d} label={l} checked={choice.delts.includes(d)}
                onChange={(on) => onChoose({ ...choice, delts: on ? [...choice.delts, d] : choice.delts.filter((x) => x !== d) })} />
            ))}
          </div>
          <label className="mt-3 flex min-h-11 items-center gap-3">
            <input type="checkbox" className="size-5 accent-[var(--accent-strong)]" checked={choice.confirm}
              onChange={(e) => onChoose({ ...choice, confirm: e.target.checked })} />
            These delts are right
          </label>
          {!choice.confirm && <p className="text-sm text-muted">Leave it unchecked to confirm later in your library.</p>}
        </fieldset></div>
      )}
    </section>
  );
}
