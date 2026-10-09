import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import {
  canStep, describeExercise, describeUnit, groupOf, moveExercise, moveUnit, stepExercise, supersetLetters, units,
  type Linked, type Out,
} from "../lib/reorder";

type Item = Linked & { key: string; name: string };

type Drag =
  | { kind: "exercise"; from: number; dy: number; startY: number; to: number; out: Out }
  | { kind: "unit"; from: number; dy: number; startY: number; to: number };

const center = (r: DOMRect) => r.top + r.height / 2;

function Arrows({ name, up, down, onUp, onDown }: { name: string; up: boolean; down: boolean; onUp: () => void; onDown: () => void }) {
  const b = "inline-flex size-11 items-center justify-center rounded-xl hover:bg-sunken disabled:opacity-30";
  return (
    <span className="flex shrink-0">
      <button type="button" className={b} disabled={!up} onClick={onUp}><ArrowUp size={18} aria-hidden /><span className="sr-only">Move {name} up</span></button>
      <button type="button" className={b} disabled={!down} onClick={onDown}><ArrowDown size={18} aria-hidden /><span className="sr-only">Move {name} down</span></button>
    </span>
  );
}

/**
 * The exercise list in reorder mode. Drag a grip, or use the arrows. An
 * exercise moved within its superset stays in it; moved past the group's
 * first or last exercise, it leaves. A superset's header moves the whole
 * group. Every move is announced. Rules: src/lib/reorder.ts.
 */
export function ExerciseOrder<T extends Item>({ items, onChange }: { items: T[]; onChange: (next: T[]) => void }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");
  const rows = useRef(new Map<string, HTMLElement>());
  const box = useRef<HTMLDivElement>(null);
  const snap = useRef<{ ex: DOMRect[]; units: DOMRect[] }>({ ex: [], units: [] });
  const letters = supersetLetters(items);
  const us = units(items);
  const starts: number[] = [];
  us.reduce((s, u) => (starts.push(s), s + u.length), 0);

  const rect = (key: string) => rows.current.get(key)!.getBoundingClientRect();
  const unitRect = (u: number) => {
    const first = us[u].length > 1 ? rect(`h-${us[u][0].key}`) : rect(us[u][0].key);
    const last = rect(us[u][us[u].length - 1].key);
    return new DOMRect(first.x, first.top, first.width, last.bottom - first.top);
  };

  const apply = (next: T[], message: string) => {
    if (next === items) return;
    onChange(next);
    setSaid(message);
  };
  const stepEx = (i: number, dir: -1 | 1) => {
    const next = stepExercise(items, i, dir);
    apply(next, describeExercise(next, items[i].key));
  };
  const stepUnit = (u: number, dir: -1 | 1) => {
    const next = moveUnit(items, u, u + dir);
    apply(next, describeUnit(next, us[u][0].key));
  };

  const start = (e: PointerEvent<HTMLButtonElement>, d: Drag) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    snap.current = { ex: items.map((x) => rect(x.key)), units: us.map((_, u) => unitRect(u)) };
    setDrag(d);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (drag.kind === "exercise") {
      const rs = snap.current.ex;
      const c = center(rs[drag.from]) + dy;
      const to = rs.filter((r, j) => j !== drag.from && center(r) < c).length;
      const g = groupOf(items, drag.from);
      const out: Out = g ? (c < rs[g[0]].top ? "before" : c > rs[g[1]].bottom ? "after" : false) : false;
      setDrag({ ...drag, dy, to, out });
    } else {
      const rs = snap.current.units;
      const c = center(rs[drag.from]) + dy;
      setDrag({ ...drag, dy, to: rs.filter((r, j) => j !== drag.from && center(r) < c).length });
    }
  };
  const end = () => {
    if (drag?.kind === "exercise") {
      const next = moveExercise(items, drag.from, drag.to, drag.out);
      apply(next, describeExercise(next, items[drag.from].key));
    } else if (drag) {
      const next = moveUnit(items, drag.from, drag.to);
      apply(next, describeUnit(next, us[drag.from][0].key));
    }
    setDrag(null);
  };

  // Where it would land, shown as a line while dragging.
  let lineY: number | null = null;
  let landing = "";
  if (drag && box.current) {
    const top = box.current.getBoundingClientRect().top;
    if (drag.kind === "exercise") {
      const key = items[drag.from].key;
      const next = moveExercise(items, drag.from, drag.to, drag.out);
      const p = next.findIndex((x) => x.key === key);
      const inGroup = groupOf(next, p) !== null;
      const byKey = new Map(items.map((x, j) => [x.key, snap.current.ex[j]]));
      const prev = next[p - 1];
      if (prev && (inGroup || !prev.linkNext)) lineY = byKey.get(prev.key)!.bottom;
      else {
        const after = next[p + 1];
        const ai = items.findIndex((x) => x.key === after?.key);
        const au = us.findIndex((u) => u[0].key === after?.key);
        lineY = after ? (!inGroup && au >= 0 ? snap.current.units[au].top : snap.current.ex[ai].top) : null;
      }
      landing = inGroup ? `In superset ${supersetLetters(next)[p]}` : "Not in a superset";
    } else {
      const others = snap.current.units.filter((_, j) => j !== drag.from);
      lineY = drag.to < others.length ? others[drag.to].top : others[others.length - 1]?.bottom ?? null;
    }
    if (lineY !== null) lineY = lineY - top - 4;
  }

  const grip = (label: string, d: { kind: "exercise"; from: number; to: number; out: Out } | { kind: "unit"; from: number; to: number }) => (
    <button type="button" tabIndex={-1} aria-hidden title={label}
      onPointerDown={(e) => start(e, { ...d, dy: 0, startY: e.clientY } as Drag)} onPointerMove={move} onPointerUp={end}
      onPointerCancel={() => setDrag(null)}
      className="flex w-11 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded-l-2xl text-muted hover:bg-sunken active:cursor-grabbing">
      <GripVertical size={20} />
    </button>
  );

  const exRow = (x: T, i: number) => {
    const dragging = drag?.kind === "exercise" && drag.from === i;
    return (
      <li key={x.key} ref={(el) => { if (el) rows.current.set(x.key, el); else rows.current.delete(x.key); }}
        style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
        className={`relative flex items-center gap-1 rounded-2xl border bg-surface border-line ${dragging ? "z-10 shadow-lg ring-2 ring-accent-text" : ""}`}>
        {grip(`Drag ${x.name}`, { kind: "exercise", from: i, to: i, out: false })}
        <span className="min-w-0 flex-1 py-2">
          <span className="block font-bold">{x.name}</span>
          {dragging && <span className="block text-sm text-accent-text">{landing}</span>}
        </span>
        <Arrows name={x.name} up={canStep(items, i, -1)} down={canStep(items, i, 1)} onUp={() => stepEx(i, -1)} onDown={() => stepEx(i, 1)} />
      </li>
    );
  };

  return (
    <div ref={box} className="relative">
      <ol aria-label="Exercises" className="space-y-2">
        {us.map((u, ui) => {
          if (u.length === 1) return exRow(u[0], starts[ui]);
          const letter = letters[starts[ui]]!;
          const dragging = drag?.kind === "unit" && drag.from === ui;
          const name = `superset ${letter}`;
          return (
            <li key={`h-${u[0].key}`} aria-label={`Superset ${letter}`}
              style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
              className={`relative rounded-2xl border-l-4 border-accent-strong bg-sunken p-1 ${dragging ? "z-10 shadow-lg ring-2 ring-accent-text" : ""}`}>
              <div ref={(el) => { if (el) rows.current.set(`h-${u[0].key}`, el); else rows.current.delete(`h-${u[0].key}`); }}
                className="flex items-center gap-1">
                {grip(`Drag ${name}`, { kind: "unit", from: ui, to: ui })}
                <span className="min-w-0 flex-1 font-bold text-accent-text">Superset {letter}</span>
                <Arrows name={name} up={ui > 0} down={ui < us.length - 1} onUp={() => stepUnit(ui, -1)} onDown={() => stepUnit(ui, 1)} />
              </div>
              <ol className="mt-1 space-y-1">{u.map((x, k) => exRow(x, starts[ui] + k))}</ol>
            </li>
          );
        })}
      </ol>
      {lineY !== null && <div aria-hidden className="pointer-events-none absolute inset-x-0 z-20 h-1 rounded-full bg-accent-text" style={{ top: lineY }} />}
      <p className="sr-only" aria-live="polite">{said}</p>
    </div>
  );
}

