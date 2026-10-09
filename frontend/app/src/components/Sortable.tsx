import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";

type Drag = { from: number; to: number; dy: number; startY: number; rects: DOMRect[] };

/** Moves an item in a list. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * A list that reorders two ways: drag the grip (mouse or touch), or use the
 * move up and move down buttons (keyboard and screen readers). Each move is
 * announced.
 */
export function SortableList<T>({ items, keyOf, labelOf, onMove, children, label }: {
  items: T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  onMove: (from: number, to: number) => void;
  children: (item: T, index: number) => ReactNode;
  label: string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || to === from) return;
    onMove(from, to);
    setSaid(`${labelOf(items[from])} moved to position ${to + 1} of ${items.length}.`);
  };

  const down = (e: PointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rects = Array.from(listRef.current?.children ?? [], (el) => el.getBoundingClientRect());
    setDrag({ from: i, to: i, dy: 0, startY: e.clientY, rects });
  };
  const over = (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const r = drag.rects[drag.from];
    const center = r.top + r.height / 2 + dy;
    const to = drag.rects.filter((x, j) => j !== drag.from && x.top + x.height / 2 < center).length;
    setDrag({ ...drag, dy, to });
  };
  const up = () => {
    if (drag) move(drag.from, drag.to);
    setDrag(null);
  };

  // While dragging, the others slide over to show where it will land.
  const shift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    const { from, to, rects } = drag;
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 0;
    const h = rects[from].height + gap;
    if (from < to && i > from && i <= to) return -h;
    if (to < from && i >= to && i < from) return h;
    return 0;
  };

  return (
    <>
      <ol ref={listRef} aria-label={label} className="space-y-2">
        {items.map((item, i) => {
          const name = labelOf(item);
          const dragging = drag?.from === i;
          return (
            <li key={keyOf(item)}
              style={{ transform: `translateY(${dragging ? drag!.dy : shift(i)}px)` }}
              className={`relative flex items-stretch gap-1 rounded-2xl border border-line bg-surface ${dragging ? "z-10 shadow-lg ring-2 ring-accent" : drag ? "motion-safe:transition-transform" : ""}`}>
              <button type="button" onPointerDown={(e) => down(e, i)} onPointerMove={over} onPointerUp={up} onPointerCancel={() => setDrag(null)}
                className="flex w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-l-2xl text-muted hover:bg-sunken active:cursor-grabbing"
                tabIndex={-1} aria-hidden>
                <GripVertical size={20} />
              </button>
              <div className="min-w-0 flex-1 py-1">{children(item, i)}</div>
              <div className="flex shrink-0 flex-col justify-center">
                <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0}
                  className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-sunken disabled:opacity-30">
                  <ArrowUp size={18} aria-hidden /><span className="sr-only">Move {name} up</span>
                </button>
                <button type="button" onClick={() => move(i, i + 1)} disabled={i === items.length - 1}
                  className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-sunken disabled:opacity-30">
                  <ArrowDown size={18} aria-hidden /><span className="sr-only">Move {name} down</span>
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">{said}</p>
    </>
  );
}
