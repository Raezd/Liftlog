"""The exercise catalog (free-exercise-db) and liftlog's muscle vocabulary.

The dataset lives in app/seed/free-exercise-db (see SOURCE.md there). Migration
0002 loads it into the read-only catalog_exercises table; this module reads the
same file for the vocabulary, the delt suggestions, and fuzzy matching, which
run in memory (876 small entries).

Muscle vocabulary: the dataset's muscle groups with spaces turned into
underscores ("middle back" -> middle_back), except shoulders, which splits into
front_delts, side_delts, and rear_delts.
"""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATASET = Path(__file__).parent / "seed" / "free-exercise-db" / "exercises.json"

DELTS = ("front_delts", "side_delts", "rear_delts")
DELT_LABELS = {"front_delts": "Front delts", "side_delts": "Side delts", "rear_delts": "Rear delts"}

EQUIPMENT = ("barbell", "dumbbell", "machine", "cable", "bodyweight", "other")
LOGGING_TYPES = (
    "weight_reps", "bodyweight_reps", "weighted_bodyweight", "assisted_bodyweight",
    "duration", "distance_duration",
)


def load_dataset() -> list[dict]:
    return json.loads(DATASET.read_text(encoding="utf-8"))


def muscle_id(dataset_value: str) -> str:
    return dataset_value.strip().lower().replace(" ", "_")


def vocabulary(dataset: list[dict]) -> list[tuple[str, str]]:
    """(id, label) for every muscle, read from the dataset, shoulders split.
    Sorted by label so the list is stable however the file is ordered."""
    found = {m for x in dataset for m in x["primaryMuscles"] + x["secondaryMuscles"]}
    out = {muscle_id(m): m.strip().capitalize() for m in found if muscle_id(m) != "shoulders"}
    out.update(DELT_LABELS)
    return sorted(out.items(), key=lambda kv: kv[1])


@lru_cache
def muscle_ids() -> frozenset[str]:
    return frozenset(m for m, _ in vocabulary(load_dataset()))


def equipment_for(dataset_equipment: str | None) -> str:
    return {
        "barbell": "barbell", "e-z curl bar": "barbell", "dumbbell": "dumbbell", "machine": "machine",
        "cable": "cable", "body only": "bodyweight",
    }.get((dataset_equipment or "").lower(), "other")


def logging_type_for(entry: dict) -> str:
    if entry.get("category") == "stretching":
        return "duration"
    if entry.get("category") == "cardio":
        return "distance_duration"
    if entry.get("equipment") == "body only":
        return "bodyweight_reps"
    return "weight_reps"


# Copying a catalog exercise tagged shoulders: which delts the name suggests.
# Checked in this order, so "rear delt raise" is rear, not side.
DELT_RULES = (
    ("rear_delts", ("rear delt", "reverse fly", "reverse flye", "face pull")),
    ("side_delts", ("lateral raise", "side raise", "side lateral")),
    ("front_delts", ("press", "front raise")),
)


def suggest_delts(name: str) -> list[str]:
    n = name.lower()
    for delt, words in DELT_RULES:
        if any(w in n for w in words):
            return [delt]
    return []


@dataclass(frozen=True)
class MuscleMap:
    primary: list[str]
    secondary: list[str]
    shoulders: bool  # the dataset tagged it shoulders, so it needs review


def muscles_for(entry: dict) -> MuscleMap:
    """The dataset's muscles in liftlog's vocabulary. Shoulders becomes the
    suggested delts (none when the name doesn't suggest any)."""
    delts = suggest_delts(entry["name"])
    shoulders = False

    def convert(values: list[str]) -> list[str]:
        nonlocal shoulders
        out: list[str] = []
        for v in values:
            m = muscle_id(v)
            if m == "shoulders":
                shoulders = True
                out += [d for d in delts if d not in out]
            elif m not in out:
                out.append(m)
        return out

    primary = convert(entry["primaryMuscles"])
    secondary = [m for m in convert(entry["secondaryMuscles"]) if m not in primary]
    return MuscleMap(primary, secondary, shoulders)


# Fuzzy matching, for the import review screen and catalog search. Names like
# Hevy's "Lateral Raise (Dumbbell)" put the equipment in parentheses, so those
# words count as an equipment hint rather than part of the name.

PHRASES = {"biceps curl": "curl", "bicep curl": "curl", "overhead press": "shoulder press", "military press": "shoulder press", "ohp": "shoulder press"}
SYNONYMS = {
    "bicep": "biceps", "tricep": "triceps", "db": "dumbbell", "bb": "barbell",
    "skullcrusher": "skull crusher", "skullcrushers": "skull crusher", "pulldowns": "pulldown",
    "flye": "fly", "flyes": "fly", "flys": "fly", "raises": "raise", "curls": "curl", "rows": "row",
    "presses": "press", "extensions": "extension", "dumbbells": "dumbbell", "squats": "squat",
    "lunges": "lunge", "deadlifts": "deadlift", "kickbacks": "kickback", "pushdowns": "pushdown",
    "laterals": "lateral", "crunches": "crunch", "dips": "dip", "shrugs": "shrug",
}
# "Medium grip" is the plain version of a lift, so it says nothing about the match.
STOP = {"the", "a", "with", "on", "to", "of", "and", "grip", "medium"}
HINTS = {"barbell": "barbell", "dumbbell": "dumbbell", "machine": "machine", "cable": "cable",
         "bodyweight": "body only", "smith": "machine", "ez": "e-z curl bar"}


def _tokens(s: str) -> list[str]:
    s = s.lower().replace("e-z", "ez")
    for a, b in PHRASES.items():
        s = re.sub(rf"\b{a}\b", b, s)
    out: list[str] = []
    for w in re.findall(r"[a-z0-9]+", s):
        out += SYNONYMS.get(w, w).split()
    return [w for w in out if w not in STOP]


@lru_cache
def _index() -> list[tuple[dict, frozenset[str]]]:
    return [(e, frozenset(_tokens(e["name"]))) for e in load_dataset()]


def score(query: str, entry: dict, entry_tokens: frozenset[str]) -> float:
    """1.0 is every word of the name found with nothing extra; equipment that
    agrees with a hint adds a little, each extra word costs a little."""
    main_part = re.sub(r"\([^)]*\)", " ", query)
    hint_part = " ".join(re.findall(r"\(([^)]*)\)", query))
    main, hint = _tokens(main_part), set(_tokens(hint_part))
    if not main:
        return 0.0

    def found(w: str) -> bool:
        return w in entry_tokens or (len(w) >= 3 and any(t.startswith(w) for t in entry_tokens))

    cover = sum(1 for w in set(main) if found(w)) / len(set(main))
    if cover == 0:
        return 0.0
    extra = len(entry_tokens - set(main) - hint)
    equipment = (entry.get("equipment") or "").lower()
    agrees = any(HINTS.get(h) == equipment for h in hint)
    ratio = difflib.SequenceMatcher(None, " ".join(main), " ".join(_tokens(entry["name"]))).ratio()
    return cover - 0.12 * extra + (0.15 if agrees else 0) + 0.05 * len(hint & entry_tokens) + 0.1 * ratio


def search(query: str, limit: int = 20) -> list[tuple[dict, float]]:
    """Best catalog matches for a name, best first."""
    query = query.strip()
    if not query:
        return []
    scored = [(e, score(query, e, toks)) for e, toks in _index()]
    scored = [x for x in scored if x[1] > 0.3]
    scored.sort(key=lambda x: (-x[1], len(x[0]["name"]), x[0]["name"]))
    return scored[:limit]


@lru_cache
def by_id() -> dict[str, dict]:
    return {e["id"]: e for e in load_dataset()}


def name_score(query: str, name: str) -> float:
    """How well a name (say, one of the user's own exercises) matches a query."""
    return score(query, {"name": name}, frozenset(_tokens(name)))
