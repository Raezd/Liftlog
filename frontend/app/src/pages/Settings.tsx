import { Capacitor } from "@capacitor/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, Loading, Page, Segmented, SelectField, TextField, btn } from "../components/ui";
import { send } from "../lib/api";
import { refresh } from "../lib/offline";
import { useMe } from "../lib/queries";
import type { DistanceUnit, Me, WeightUnit } from "../lib/types";
import { rememberAlertSetting } from "../timer/alertSetting";

function timezones(current: string): [string, string][] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  return zones.map((z) => [z, z.replaceAll("_", " ")]);
}

type Form = Pick<Me, "display_name" | "timezone" | "weight_unit" | "distance_unit" | "play_through_silent">;

export default function Settings() {
  const me = useMe();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me.data) {
      const { display_name, timezone, weight_unit, distance_unit, play_through_silent } = me.data;
      setForm({ display_name, timezone, weight_unit, distance_unit, play_through_silent });
    }
  }, [me.data]);

  const save = useMutation({
    mutationFn: (f: Form) => send<Me>("PATCH", "/api/me", f),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
      rememberAlertSetting(data.play_through_silent);
      void refresh(true);
      setSaved(true);
    },
  });

  return (
    <Page title="Settings">
      {me.isPending && <Loading />}
      <ErrorText error={me.error} />
      {form && (
        <form onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(form); }}>
          <Card>
            <TextField label="Display name" required maxLength={60} value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
            <SelectField label="Timezone" options={timezones(form.timezone)} value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            <p className="-mt-2 mb-3 text-sm text-muted">A workout before 4 AM counts toward the day before.</p>
            <Segmented<WeightUnit> label="Weight" name="weight" value={form.weight_unit}
              options={[["lb", "Pounds (lb)"], ["kg", "Kilograms (kg)"]]} onChange={(v) => setForm({ ...form, weight_unit: v })} />
            <Segmented<DistanceUnit> label="Distance" name="distance" value={form.distance_unit}
              options={[["mi", "Miles"], ["km", "Kilometers"]]} onChange={(v) => setForm({ ...form, distance_unit: v })} />
          </Card>
          <Card title="Rest timer">
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span>
                Play through silent mode
                <span className="block text-sm text-muted">
                  The alert rings even when your phone is on vibrate or silent. Off means it follows your ringer.
                </span>
              </span>
              <input type="checkbox" className="size-6 shrink-0 accent-[var(--accent-strong)]" checked={form.play_through_silent}
                onChange={(e) => setForm({ ...form, play_through_silent: e.target.checked })} />
            </label>
          </Card>
          <ErrorText error={save.error} />
          {saved && !save.isPending && <p role="status" className="mb-3 font-bold text-accent-text">Saved.</p>}
          <Button variant="primary" type="submit" className="w-full" disabled={save.isPending}>Save</Button>
        </form>
      )}

      <Card title="Import" className="mt-6">
        <p className="mb-3 text-sm text-muted">Bring in your workout history from a Hevy export.</p>
        <Link to="/settings/import" className={`${btn.secondary} w-full`}>Import from Hevy</Link>
      </Card>

      <Card title="About">
        <dl className="text-sm">
          <div className="flex justify-between gap-3 py-1"><dt className="text-muted">Signed in as</dt><dd className="break-all font-bold">{me.data?.login ?? "..."}</dd></div>
          <div className="flex justify-between gap-3 py-1"><dt className="text-muted">Version</dt><dd className="font-bold">{__BUILD_ID__}</dd></div>
        </dl>
        {!Capacitor.isNativePlatform() && <a href="/download" className={`${btn.secondary} mt-3 w-full`}>Get the Android app</a>}
      </Card>
    </Page>
  );
}
