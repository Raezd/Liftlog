// The superset move rules (src/lib/reorder.ts). `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { moveExercise, moveUnit, stepExercise } from "../src/lib/reorder.ts";
import type { Linked } from "../src/lib/reorder.ts";

type Ex = Linked & { name: string };

/** "A [B C D] E" is A, then a superset of B, C, D (rest 90 s on its first), then E. */
function list(s: string): Ex[] {
  const out: Ex[] = [];
  for (const part of s.match(/\[[^\]]+\]|\S+/g)!) {
    const names = part.replace(/[[\]]/g, "").split(" ");
    names.forEach((name, i) => out.push({
      name, linkNext: part.startsWith("[") && i < names.length - 1,
      supersetRest: part.startsWith("[") && i === 0 ? 90 : null,
    }));
  }
  return out;
}

/** Back to the same notation, with the rest shown on whichever exercise holds it. */
function show(items: Ex[]): string {
  const parts: string[] = [];
  let cur: string[] = [];
  for (const it of items) {
    cur.push(it.supersetRest !== null ? `${it.name}*` : it.name);
    if (!it.linkNext) {
      parts.push(cur.length > 1 ? `[${cur.join(" ")}]` : cur[0]);
      cur = [];
    }
  }
  return parts.join(" ");
}

const L = "A [B C D] E";

test("swapping inside a superset keeps the group, and its rest moves to the new first", () => {
  assert.equal(show(stepExercise(list(L), 2, -1)), "A [C* B D] E");  // button
  assert.equal(show(stepExercise(list(L), 2, 1)), "A [B* D C] E");
  assert.equal(show(moveExercise(list(L), 3, 1)), "A [D* B C] E");   // drag D to the top of the group
});

test("moving past the group's first or last exercise takes it out", () => {
  // Buttons: one step at the edge steps out and stays next to the group.
  assert.equal(show(stepExercise(list(L), 1, -1)), "A B [C* D] E");
  assert.equal(show(stepExercise(list(L), 3, 1)), "A [B* C] D E");
  // Drag: dropped past an edge.
  assert.equal(show(moveExercise(list(L), 1, 0)), "B A [C* D] E");
  assert.equal(show(moveExercise(list(L), 2, 4)), "A [B* D] E C");
  // Group at the bottom of the list: dropping below it still takes the exercise out.
  assert.equal(show(moveExercise(list("A [B C]"), 2, 2, "after")), "A B C");
  assert.equal(show(stepExercise(list("A [B C]"), 2, 1)), "A B C");
  // Leaving a pair leaves no superset of one.
  assert.equal(show(stepExercise(list("[A B] C"), 0, -1)), "A B C");
});

test("a lone exercise never lands inside a superset", () => {
  assert.equal(show(stepExercise(list(L), 0, 1)), "[B* C D] A E");   // steps past the whole group
  assert.equal(show(stepExercise(list(L), 4, -1)), "A E [B* C D]");
  assert.equal(show(moveExercise(list(L), 0, 2)), "[B* C D] A E");   // drag into the middle: past it
  assert.equal(show(moveExercise(list(L), 4, 2)), "A E [B* C D]");
  assert.equal(show(moveExercise(list("A [B C] [D E]"), 0, 3)), "[B* C] [D* E] A");
});

test("a whole superset moves as one unit", () => {
  assert.equal(show(moveUnit(list(L), 1, 0)), "[B* C D] A E");
  assert.equal(show(moveUnit(list(L), 1, 2)), "A E [B* C D]");
  assert.equal(show(moveUnit(list("[A B] [C D]"), 0, 1)), "[C* D] [A* B]");
});

test("edges are no-ops", () => {
  assert.equal(show(stepExercise(list(L), 0, -1)), L.replace("B", "B*"));
  assert.equal(show(moveUnit(list(L), 0, -1)), L.replace("B", "B*"));
});
