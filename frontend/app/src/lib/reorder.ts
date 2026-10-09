/**
 * Reordering exercises without breaking supersets. Used by the routine
 * editor, and by anything else that reorders exercises (the Spec 5a
 * Overview). Pure; tests in tests/reorder.test.ts (`npm test`).
 *
 * A superset is a run of exercises where each one but the last has
 * linkNext set. Its rest after each round lives on its first exercise.
 *
 * The rules:
 * - Moving an exercise within its own superset keeps it in the group.
 * - Moving it past the group's first or last exercise takes it out.
 * - A single exercise never lands inside another superset: it goes past
 *   the whole group instead.
 * - A whole superset moves as one unit.
 *
 * Keep this file free of runtime imports so the tests run with plain Node.
 */

export type Linked = { linkNext: boolean; supersetRest: number | null };

/** Where the dragged exercise was dropped relative to its own superset:
 *  above it, below it, or (false) within it. */
export type Out = "before" | "after" | false;

/** [first, last] index of the superset that index i is in, or null. */
export function groupOf<T extends Linked>(items: T[], i: number): [number, number] | null {
  let a = i;
  while (a > 0 && items[a - 1].linkNext) a--;
  let b = i;
  while (b < items.length - 1 && items[b].linkNext) b++;
  return a === b ? null : [a, b];
}

/** The list as units: each superset is one unit, each lone exercise another. */
export function units<T extends Linked>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const it of items) {
    cur.push(it);
    if (!it.linkNext) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Links a unit back together, with its rest on whichever exercise is first now. */
function relink<T extends Linked>(unit: T[], rest: number | null): T[] {
  const group = unit.length > 1;
  return unit.map((it, i) => ({ ...it, linkNext: group && i < unit.length - 1, supersetRest: group && i === 0 ? rest : null }));
}

const flat = <T,>(us: T[][]): T[] => us.flat();

function moved<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Moves the exercise at `from` so it ends up at index `to` (as a drag drop
 * would). Inside its superset's span it stays in the group. `out` says the
 * drop was above or below its superset, which takes it out even when `to`
 * is still within the span (a group at the top or bottom of the list).
 */
export function moveExercise<T extends Linked>(items: T[], from: number, to: number, out: Out = false): T[] {
  to = Math.max(0, Math.min(items.length - 1, to));
  const g = groupOf(items, from);
  if (g && !out && to >= g[0] && to <= g[1]) {
    if (to === from) return items;
    const chain = items.slice(g[0], g[1] + 1);
    const re = relink(moved(chain, from - g[0], to - g[0]), chain[0].supersetRest);
    return [...items.slice(0, g[0]), ...re, ...items.slice(g[1] + 1)];
  }
  if (!g && to === from) return items;

  // Take it out of its unit; what's left of a superset stays together.
  const us = units(items);
  let u = 0, k = from;
  while (k >= us[u].length) k -= us[u++].length;
  const item = { ...us[u][k], linkNext: false, supersetRest: null };
  const left = us[u].filter((_, j) => j !== k);
  const rest: T[][] = us.slice();
  if (left.length) rest[u] = relink(left, us[u][0].supersetRest);
  else rest.splice(u, 1);

  let at: number;
  if (g && (out || to < g[0] || to > g[1]) && to >= g[0] && to <= g[1]) {
    // Dropped just outside its own superset: right next to it.
    at = out === "before" ? u : u + 1;
  } else {
    // Into the list at `to`, but never inside a superset: past it, in the direction of the move.
    const down = to > from;
    at = rest.length;
    let start = 0;
    for (let j = 0; j < rest.length; j++) {
      const end = start + rest[j].length;
      if (to <= start) { at = j; break; }
      if (to < end) { at = down ? j + 1 : j; break; }
      start = end;
    }
  }
  rest.splice(at, 0, [item]);
  return flat(rest);
}

/** One step up (-1) or down (+1), as the move buttons do. Inside a superset
 *  it swaps with its neighbor; at the group's edge it steps out, staying
 *  next to the group; a lone exercise steps past the whole next unit. */
export function stepExercise<T extends Linked>(items: T[], i: number, dir: -1 | 1): T[] {
  const g = groupOf(items, i);
  if (g) {
    const j = i + dir;
    if (j >= g[0] && j <= g[1]) return moveExercise(items, i, j);
    return moveExercise(items, i, i, dir < 0 ? "before" : "after");
  }
  const us = units(items);
  let u = 0, start = 0;
  while (start < i) start += us[u++].length;
  const v = u + dir;
  if (v < 0 || v >= us.length) return items;
  const to = dir < 0 ? start - us[v].length : start + us[v].length;
  return moveExercise(items, i, to);
}

/** Can the step buttons move this exercise? */
export function canStep<T extends Linked>(items: T[], i: number, dir: -1 | 1): boolean {
  if (groupOf(items, i)) return true;
  return dir < 0 ? i > 0 : i < items.length - 1;
}

/** Moves a whole unit (a superset, or a lone exercise) to unit index `to`. */
export function moveUnit<T extends Linked>(items: T[], from: number, to: number): T[] {
  const us = units(items);
  if (to < 0 || to >= us.length || to === from) return items;
  return flat(moved(us, from, to));
}

/** Index of the unit that starts at exercise index i. */
export function unitIndexAt<T extends Linked>(items: T[], i: number): number {
  return units(items.slice(0, i)).length;
}

/** "A", "B"... per superset in list order, for each exercise (null if alone). */
export function supersetLetters<T extends Linked>(items: T[]): (string | null)[] {
  const out: (string | null)[] = [];
  let n = 0;
  for (const u of units(items)) {
    const letter = u.length > 1 ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[n++] ?? "?" : null;
    for (let i = 0; i < u.length; i++) out.push(letter);
  }
  return out;
}

/** What a screen reader hears after an exercise moves. */
export function describeExercise<T extends Linked & { key: string; name: string }>(items: T[], key: string): string {
  const i = items.findIndex((x) => x.key === key);
  const letter = supersetLetters(items)[i];
  return `${items[i].name} moved to position ${i + 1} of ${items.length}, ${letter ? `in superset ${letter}` : "not in a superset"}.`;
}

/** What a screen reader hears after a superset moves. */
export function describeUnit<T extends Linked & { key: string }>(items: T[], firstKey: string): string {
  const us = units(items);
  const u = us.findIndex((x) => x[0].key === firstKey);
  const letter = supersetLetters(items)[items.findIndex((x) => x.key === firstKey)];
  return `Superset ${letter} moved to position ${u + 1} of ${us.length}.`;
}
