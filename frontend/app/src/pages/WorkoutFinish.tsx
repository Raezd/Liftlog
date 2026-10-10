import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, Card, Loading, Page, TextField, btn } from "../components/ui";
import { finish, update, useActive } from "../lib/active";
import { duration, plural } from "../lib/format";
import { useOffline } from "../lib/offline";
import { finishCounts, summarize, toUpload, type Summary } from "../lib/session";
import type { LoggingType } from "../lib/types";
import { formatVolume } from "../lib/volume";
import { stopRest } from "../timer/useRest";
import { DiscardSheet, NoWorkout, isNative } from "./Workout";

function Screen({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-md px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>;
}

/** Confirm before saving: what gets dropped, and the title and notes. */
export function WorkoutFinish() {
  const { loaded, workout: w } = useActive();
  const off = useOffline();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isNative()) return <NoWorkout web />;
  if (!loaded) return <Screen><Loading /></Screen>;
  if (!w) return <NoWorkout />;

  const c = finishCounts(w);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = toUpload(w, new Date().toISOString());
      const logging: Record<string, LoggingType> = Object.fromEntries(w.exercises.map((e) => [e.exercise_id, e.logging_type]));
      const summary = summarize(body, logging, off.copy?.me.weight_unit ?? "lb");
      await stopRest();
      await finish(body);
      navigate("/workout/done", { replace: true, state: { summary, id: w.id } satisfies DoneState });
    } catch {
      setError("Couldn't save the workout on this phone. Try again.");
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Page title="Finish workout" back="/workout">
        <Card>
          <TextField label="Title" maxLength={120} value={w.title} onChange={(e) => void update((x) => ({ ...x, title: e.target.value }), { instant: true })} />
          <label className="block">
            <span className="font-bold">Notes</span>
            <textarea value={w.notes} maxLength={5000} rows={3} onChange={(e) => void update((x) => ({ ...x, notes: e.target.value }), { instant: true })}
              className="mt-1 block w-full rounded-xl border border-line bg-ground px-3 py-2" />
          </label>
        </Card>
        <Card>
          <p className="font-bold">{c.sets ? `${plural(c.sets, "set")} done.` : "No sets are done yet, so there's nothing to save."}</p>
          {c.droppedSets > 0 && <p className="mt-1">{plural(c.droppedSets, "set")} not done won't be saved.</p>}
          {c.droppedExercises > 0 && <p className="mt-1">{plural(c.droppedExercises, "exercise")} with no sets done won't be saved.</p>}
        </Card>
        {error && <p role="alert" className="mb-3 font-bold text-over">{error}</p>}
        <Button variant="primary" className="w-full" disabled={busy || c.sets === 0} onClick={() => void save()}>
          {busy ? "Saving..." : "Save workout"}
        </Button>
        <Link to="/workout" className={`${btn.secondary} mt-2 w-full`}>Back to workout</Link>
        <Button className="mt-6 w-full text-over" onClick={() => setDiscarding(true)}>Discard workout</Button>
        <DiscardSheet open={discarding} onClose={() => setDiscarding(false)} onDiscarded={() => navigate("/", { replace: true })} />
      </Page>
    </Screen>
  );
}

type DoneState = { summary: Summary; id: string };

/** The summary after saving: duration, completed sets, and volume, with confetti. */
export function WorkoutDone() {
  const state = useLocation().state as DoneState | null;
  const off = useOffline();
  if (!state) return <Navigate to="/" replace />;
  const { summary: s, id } = state;
  const waiting = off.queue.find((q) => q.id === id);
  return (
    <Screen>
      <Confetti />
      <h1 className="display mb-1 text-3xl font-extrabold text-accent-text">Workout saved</h1>
      <p className="mb-5 font-bold">{s.title}</p>
      <dl className="mb-5 grid grid-cols-3 gap-2 text-center">
        {[["Time", duration(s.seconds)], ["Sets", String(s.sets)], ["Volume", s.volume !== null ? formatVolume(s.volume, s.unit) : "No weighted sets"]].map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-line bg-surface p-3">
            <dt className="text-sm text-muted">{k}</dt>
            <dd className="num display text-xl font-bold">{v}</dd>
          </div>
        ))}
      </dl>
      <p role="status" className="mb-5 text-muted">
        {!waiting ? "Uploaded." : waiting.error ? `The server didn't take it: ${waiting.error} It's kept on this phone under Needs attention.`
          : off.syncing ? "Uploading..." : "Saved on this phone. It uploads when you're back online."}
      </p>
      <Link to="/" className={`${btn.primary} w-full`}>Done</Link>
    </Screen>
  );
}

/** A short burst of confetti in the palette's colors. None with reduced motion. */
function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const colors = ["--accent", "--accent-strong", "--over", "--muted"].map((v) => css.getPropertyValue(v).trim());
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const bits = Array.from({ length: 140 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 11 - 4,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const start = performance.now();
    let frame = 0;
    const tick = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      for (const b of bits) {
        b.vy += 0.3;
        b.x += b.vx;
        b.y += b.vy;
        b.r += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.r);
        ctx.fillStyle = b.c;
        ctx.fillRect(-4, -2, 8, 4);
        ctx.restore();
      }
      if (t - start < 3000) frame = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 h-dvh w-screen" />;
}
