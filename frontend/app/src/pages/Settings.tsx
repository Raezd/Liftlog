import { Capacitor } from "@capacitor/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorText, Loading, Page, Segmented, SelectField, TextField, btn } from "../components/ui";
import { API_BASE, get, send } from "../lib/api";
import { checkForUpdate } from "../lib/appUpdate";
import { refresh } from "../lib/offline";
import { useMe } from "../lib/queries";
import type { DistanceUnit, Me, WeightUnit } from "../lib/types";
import { useOnline } from "../lib/useOnline";
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

      <Card title="Bars and plates" className="mt-6">
        <p className="mb-3 text-sm text-muted">The bars and plates plate math uses, and your defaults.</p>
        <Link to="/settings/gear" className={`${btn.secondary} w-full`}>Bars and plates</Link>
      </Card>

      <Card title="Export">
        <p className="mb-3 text-sm text-muted">Download your history as a spreadsheet or a full backup.</p>
        <Link to="/settings/export" className={`${btn.secondary} w-full`}>Export</Link>
      </Card>

      <Card title="Import">
        <p className="mb-3 text-sm text-muted">Bring in your workout history from a Hevy export.</p>
        <Link to="/settings/import" className={`${btn.secondary} w-full`}>Import from Hevy</Link>
      </Card>

      <Card title="About">
        <dl className="text-sm">
          <div className="flex justify-between gap-3 py-1"><dt className="text-muted">Signed in as</dt><dd className="break-all font-bold">{me.data?.login ?? "..."}</dd></div>
          <div className="flex justify-between gap-3 py-1"><dt className="text-muted">Version</dt><dd className="font-bold">{__BUILD_ID__}</dd></div>
        </dl>
        {Capacitor.isNativePlatform()
          ? <AppUpdate />
          : <a href="/download" className={`${btn.secondary} mt-3 w-full`}>Get the Android app</a>}
      </Card>
    </Page>
  );
}

/**
 * In the Android app: Update app, plus a notice when /download serves a
 * different version than this one. Checked once each time Settings opens
 * with a connection; offline or on any failure there's no notice. Both
 * buttons are links to /download on the server's host, which Capacitor hands
 * to the phone's browser (like Export), where the APK downloads and installs.
 */
function AppUpdate() {
  const online = useOnline();
  const check = useQuery({
    queryKey: ["app-update"],
    queryFn: () => checkForUpdate(__BUILD_ID__, () => get<unknown>("/api/app/latest")),
    enabled: online,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: "always",
  });
  const newer = online ? check.data : null;
  const href = `${API_BASE || window.location.origin}/download`;
  return (
    <>
      {newer && (
        <div role="status" className="mt-3 rounded-xl border border-line bg-sunken p-3">
          <p className="font-bold">Update available</p>
          <p className="mb-3 text-sm text-muted">Version {newer} is ready to download.</p>
          <a href={href} className={`${btn.primary} w-full`}>
            <ExternalLink size={18} aria-hidden /> Update to {newer}
          </a>
        </div>
      )}
      <a href={href} className={`${btn.secondary} mt-3 w-full`}>
        <ExternalLink size={18} aria-hidden /> Update app<span className="sr-only"> in your browser</span>
      </a>
    </>
  );
}
