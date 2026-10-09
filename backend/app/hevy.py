"""Hevy workout CSV import (Profile > Settings > Export & Import Data).

Parsing is adapted from Foodlog's Hevy importer (copied, not shared). Hevy
exports one row per set, with every workout in the account each time. The
columns, checked against a real export (October 2026):

  "title","start_time","end_time","description","exercise_title","superset_id",
  "exercise_notes","set_index","set_type","weight_lbs","reps","distance_miles",
  "duration_seconds","rpe"

An account set to kilograms writes weight_kg and distance_km instead, which is
how the unit is detected. Times look like "6 Oct 2026, 16:19" and carry no
timezone, so they're read as the user's own local time.

Mapping: each run of rows with the same exercise (and superset) becomes one
workout exercise, in file order, so an exercise done twice in a workout stays
twice. superset_id becomes the superset group, set types map to ours
(dropset -> drop), and the workout description becomes the workout notes.

Dedupe: a workout's key is its start time (to the minute) plus title, unique
per user. Re-importing skips keys already present. A key that's present with
different content is reported as a conflict and never overwritten.

The import is atomic: it refuses to write anything until every exercise title
in the new workouts is resolved, then it all commits in one transaction.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import uuid
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import catalog
from app.dates import workout_date_for
from app.library import catalog_summary, copy_from_catalog, create_custom, problem
from app.models import HevyTitleMapping, Import, Set, User, UserExercise, Workout, WorkoutExercise, uuid7
from app.units import to_kg, to_m

COLUMNS = ("title", "start_time", "end_time", "description", "exercise_title", "superset_id",
           "exercise_notes", "set_index", "set_type", "reps", "duration_seconds", "rpe")
WEIGHT_COLUMNS = {"weight_lbs": "lb", "weight_kg": "kg"}
DISTANCE_COLUMNS = {"distance_miles": "mi", "distance_km": "km"}
SET_TYPES = {"normal": "normal", "warmup": "warmup", "dropset": "drop", "failure": "failure"}
MONTHS = {m: i + 1 for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}
MAX_PROBLEMS = 20
MAX_BYTES = 20 * 1024 * 1024


class FormatError(ValueError):
    """The file isn't a readable Hevy workout export. Nothing is written."""

    def __init__(self, message: str, problems: list[str] | None = None):
        super().__init__(message)
        self.problems = problems or []


def parse_time(s: str) -> dt.datetime:
    """A naive local time. Hevy writes "6 Oct 2026, 16:19"; ISO is accepted too."""
    s = s.strip()
    try:
        day_part, time_part = (p.strip() for p in s.split(",", 1))
        d, mon, y = day_part.split()
        hm = [int(x) for x in time_part.split(":")]
        return dt.datetime(int(y), MONTHS[mon[:3].lower()], int(d), hm[0], hm[1], hm[2] if len(hm) > 2 else 0)
    except (ValueError, KeyError, IndexError):
        pass
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        raise ValueError(f"unreadable time {s!r}") from None
    return t.replace(tzinfo=None)


def _num(s: str | None) -> Decimal | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        v = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"not a number: {s!r}") from None
    if not v.is_finite() or v < 0:
        raise ValueError(f"not a valid amount: {s!r}")
    return v


def _int(s: str | None, what: str) -> int | None:
    v = _num(s)
    if v is None:
        return None
    if v != v.to_integral_value():
        raise ValueError(f"{what} must be a whole number: {s!r}")
    return int(v)


def map_set_type(hevy: str) -> str:
    t = (hevy or "").strip().lower()
    if t not in SET_TYPES:
        raise ValueError(f"unknown set type {hevy!r}")
    return SET_TYPES[t]


def parse_rpe(s: str | None) -> Decimal | None:
    v = _num(s)
    if v is None:
        return None
    if not (Decimal(6) <= v <= Decimal(10)) or (v * 2) != (v * 2).to_integral_value():
        raise ValueError(f"RPE must be 6 to 10 in half steps: {s!r}")
    return v.quantize(Decimal("0.1"))


def clean_notes(s: str | None) -> str:
    # Hevy writes line breaks in notes as a literal backslash-n.
    return (s or "").replace("\\n", "\n").strip()


@dataclass
class ParsedSet:
    set_type: str
    weight: Decimal | None
    reps: int | None
    rpe: Decimal | None
    duration_seconds: int | None
    distance: Decimal | None


@dataclass
class ParsedBlock:
    title: str
    superset_group: int | None
    notes: str
    sets: list[ParsedSet] = field(default_factory=list)
    last_index: int = -1


@dataclass
class ParsedWorkout:
    title: str
    start: dt.datetime  # naive, local
    end: dt.datetime | None
    notes: str
    blocks: list[ParsedBlock] = field(default_factory=list)

    @property
    def key(self) -> str:
        return f"{self.start.isoformat(timespec='minutes')}|{self.title}"

    @property
    def set_count(self) -> int:
        return sum(len(b.sets) for b in self.blocks)


@dataclass
class ParsedFile:
    sha256: str
    weight_unit: str
    distance_unit: str
    rows: int
    workouts: list[ParsedWorkout]


def content_hash(w: ParsedWorkout, weight_unit: str, distance_unit: str) -> str:
    """Fingerprint of a workout as Hevy exported it. Same rows, same hash."""
    def n(v: Decimal | None) -> str | None:
        return None if v is None else format(v.normalize(), "f")
    doc = {
        "title": w.title, "start": w.start.isoformat(), "end": w.end.isoformat() if w.end else None,
        "notes": w.notes, "units": [weight_unit, distance_unit],
        "blocks": [{
            "title": b.title, "superset": b.superset_group, "notes": b.notes,
            "sets": [[s.set_type, n(s.weight), s.reps, n(s.rpe), s.duration_seconds, n(s.distance)] for s in b.sets],
        } for b in w.blocks],
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def parse(content: bytes) -> ParsedFile:
    """Every workout in the file, in file order. Any unreadable row rejects
    the whole file, so counts always match the export."""
    if len(content) > MAX_BYTES:
        raise FormatError("This file is too large to be a Hevy export.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise FormatError("This isn't a text CSV file. Choose the workouts file Hevy exports.") from None
    if not text.strip():
        raise FormatError("The file is empty.")
    reader = csv.DictReader(io.StringIO(text, newline=""))
    cols = {c.strip() for c in reader.fieldnames or []}
    weight_col = next((c for c in WEIGHT_COLUMNS if c in cols), None)
    distance_col = next((c for c in DISTANCE_COLUMNS if c in cols), None)
    missing = [c for c in COLUMNS if c not in cols]
    missing += [] if weight_col else ["weight_lbs or weight_kg"]
    missing += [] if distance_col else ["distance_miles or distance_km"]
    if missing:
        raise FormatError(f"This doesn't look like a Hevy workout export. Missing columns: {', '.join(missing)}.")

    workouts: dict[tuple[dt.datetime, str], ParsedWorkout] = {}
    problems: list[str] = []
    rows = 0
    for row in reader:
        rows += 1
        line = reader.line_num
        try:
            title = (row["title"] or "").strip()
            exercise = (row["exercise_title"] or "").strip()
            if not title:
                raise ValueError("no workout title")
            if not exercise:
                raise ValueError("no exercise title")
            start = parse_time(row["start_time"] or "")
            index = _int(row["set_index"], "set_index")
            superset = _int(row["superset_id"], "superset_id")
            s = ParsedSet(
                set_type=map_set_type(row["set_type"]),
                weight=_num(row[weight_col]),
                reps=_int(row["reps"], "reps"),
                rpe=parse_rpe(row["rpe"]),
                duration_seconds=_int(row["duration_seconds"], "duration_seconds"),
                distance=_num(row[distance_col]),
            )
            w = workouts.get((start, title))
            if w is None:
                end = parse_time(row["end_time"]) if (row["end_time"] or "").strip() else None
                if end is not None and end < start:
                    end = None
                w = workouts[(start, title)] = ParsedWorkout(
                    title=title, start=start, end=end, notes=clean_notes(row["description"]))
        except ValueError as e:
            if len(problems) < MAX_PROBLEMS:
                problems.append(f"Row {line}: {e}")
            continue
        b = w.blocks[-1] if w.blocks else None
        # A new exercise block when the exercise or superset changes, or the
        # set numbers start over (the same exercise done again later).
        if b is None or b.title != exercise or b.superset_group != superset or index is None or index <= b.last_index:
            b = ParsedBlock(title=exercise, superset_group=superset, notes=clean_notes(row["exercise_notes"]))
            w.blocks.append(b)
        b.sets.append(s)
        b.last_index = index if index is not None else b.last_index + 1
    if problems:
        raise FormatError("Some rows couldn't be read, so nothing was imported.", problems)
    if not workouts:
        raise FormatError("No workouts found in this file.")
    return ParsedFile(
        sha256=hashlib.sha256(content).hexdigest(), weight_unit=WEIGHT_COLUMNS[weight_col],
        distance_unit=DISTANCE_COLUMNS[distance_col], rows=rows, workouts=list(workouts.values()),
    )


# Classifying against what's already imported.

@dataclass
class Plan:
    parsed: ParsedFile
    new: list[ParsedWorkout]
    skipped: list[ParsedWorkout]
    conflicting: list[ParsedWorkout]
    hashes: dict[str, str]
    mappings: dict[str, uuid.UUID]  # saved title -> exercise id

    @property
    def needed_titles(self) -> list[str]:
        """Titles in workouts that would be added, in first-seen order."""
        seen: dict[str, None] = {}
        for w in self.new:
            for b in w.blocks:
                seen.setdefault(b.title, None)
        return list(seen)

    @property
    def unresolved(self) -> list[str]:
        return [t for t in self.needed_titles if t not in self.mappings]


def plan(session: Session, user: User, parsed: ParsedFile) -> Plan:
    hashes = {w.key: content_hash(w, parsed.weight_unit, parsed.distance_unit) for w in parsed.workouts}
    existing = dict(session.execute(select(Workout.import_key, Workout.import_hash).where(
        Workout.user_id == user.id, Workout.import_key.in_(list(hashes)))).all())
    new, skipped, conflicting = [], [], []
    for w in parsed.workouts:
        if w.key not in existing:
            new.append(w)
        elif existing[w.key] == hashes[w.key]:
            skipped.append(w)
        else:
            conflicting.append(w)
    mappings = dict(session.execute(select(HevyTitleMapping.hevy_title, HevyTitleMapping.exercise_id).where(
        HevyTitleMapping.user_id == user.id)).all())
    return Plan(parsed, new, skipped, conflicting, hashes, mappings)


def infer_logging_type(sets: list[ParsedSet]) -> str:
    if any(s.distance is not None for s in sets):
        return "distance_duration"
    if any(s.weight is not None for s in sets) and any(s.reps is not None for s in sets):
        return "weight_reps"
    if any(s.reps is not None for s in sets):
        return "bodyweight_reps"
    if any(s.duration_seconds is not None for s in sets):
        return "duration"
    return "weight_reps"


def infer_equipment(title: str) -> str:
    t = title.lower()
    for word, eq in (("barbell", "barbell"), ("dumbbell", "dumbbell"), ("machine", "machine"),
                     ("cable", "cable"), ("bodyweight", "bodyweight")):
        if word in t:
            return eq
    return "other"


def counts(ws: list[ParsedWorkout]) -> dict:
    return {"workouts": len(ws), "sets": sum(w.set_count for w in ws)}


def preview(session: Session, user: User, parsed: ParsedFile) -> dict:
    p = plan(session, user, parsed)
    library = list(session.scalars(select(UserExercise).where(UserExercise.user_id == user.id)))
    names = {ex.id: ex.name for ex in library}
    sets_by_title: dict[str, list[ParsedSet]] = {}
    for w in parsed.workouts:
        for b in w.blocks:
            sets_by_title.setdefault(b.title, []).extend(b.sets)
    titles = []
    for t in p.needed_titles:
        mapped = p.mappings.get(t)
        entry = {"title": t, "sets": len(sets_by_title[t]),
                 "mapped_to": {"id": str(mapped), "name": names.get(mapped, "")} if mapped else None}
        if mapped is None:
            mine = sorted(((ex, catalog.name_score(t, ex.name)) for ex in library if not ex.archived),
                          key=lambda x: (-x[1], x[0].name.lower()))
            entry.update(
                suggestions=[catalog_summary(e, s) for e, s in catalog.search(t, 3)],
                user_matches=[{"id": str(ex.id), "name": ex.name} for ex, s in mine if s > 0.3][:3],
                logging_type=infer_logging_type(sets_by_title[t]),
                equipment=infer_equipment(t),
            )
        titles.append(entry)
    dates = [w.start.date() for w in parsed.workouts]
    return {
        "file_sha256": parsed.sha256, "rows": parsed.rows,
        "weight_unit": parsed.weight_unit, "distance_unit": parsed.distance_unit,
        "first_date": min(dates).isoformat(), "last_date": max(dates).isoformat(),
        "total": counts(parsed.workouts), "new": counts(p.new), "skipped": counts(p.skipped),
        "conflicting": counts(p.conflicting),
        "conflicts": [{"title": w.title, "start": w.start.isoformat(timespec="minutes")} for w in p.conflicting],
        "titles": titles,
        "unresolved": len(p.unresolved),
    }


# Resolutions sent from the review screen, one per unresolved title.

class UseCatalog(BaseModel):
    action: Literal["catalog"]
    catalog_id: str
    # The delts as shown on the review screen; omitted means the suggestion.
    primary_muscles: list[str] | None = None
    secondary_muscles: list[str] | None = None
    confirm_muscles: bool = False


class UseExisting(BaseModel):
    action: Literal["existing"]
    exercise_id: uuid.UUID


class MakeCustom(BaseModel):
    action: Literal["custom"]
    name: str
    equipment: str
    logging_type: str
    primary_muscles: list[str] = []
    secondary_muscles: list[str] = []


Resolution = UseCatalog | UseExisting | MakeCustom


def resolve(session: Session, user: User, title: str, r: Resolution, made: dict[str, UserExercise]) -> uuid.UUID:
    if isinstance(r, UseExisting):
        ex = session.get(UserExercise, r.exercise_id)
        if ex is None or ex.user_id != user.id:
            raise problem("not_found", "Not found", 404)
        return ex.id
    if isinstance(r, UseCatalog):
        return copy_from_catalog(session, user, r.catalog_id, primary=r.primary_muscles,
                                 secondary=r.secondary_muscles, confirmed=r.confirm_muscles).id
    # Two titles made into the same custom exercise in one import share it.
    key = " ".join(r.name.split()).lower()
    if key in made:
        return made[key].id
    ex = create_custom(session, user, name=r.name, equipment=r.equipment, logging_type=r.logging_type,
                       primary=r.primary_muscles, secondary=r.secondary_muscles)
    made[key] = ex
    return ex.id


def run(session: Session, user: User, parsed: ParsedFile, resolutions: dict[str, Resolution]) -> Import:
    """Writes the import inside the caller's transaction; the caller commits.
    Raises before writing anything if a title is still unresolved."""
    p = plan(session, user, parsed)
    missing = [t for t in p.unresolved if t not in resolutions]
    if missing:
        raise problem("unresolved", f"Pick an exercise for: {', '.join(missing)}")

    made: dict[str, UserExercise] = {}
    exercise_for = dict(p.mappings)
    for title in p.unresolved:
        exercise_for[title] = resolve(session, user, title, resolutions[title], made)
        session.add(HevyTitleMapping(id=uuid7(), user_id=user.id, hevy_title=title, exercise_id=exercise_for[title]))

    record = Import(
        id=uuid7(), user_id=user.id, source="hevy", file_sha256=parsed.sha256,
        workouts_added=len(p.new), sets_added=sum(w.set_count for w in p.new),
        workouts_skipped=len(p.skipped), sets_skipped=sum(w.set_count for w in p.skipped),
        workouts_conflicting=len(p.conflicting), sets_conflicting=sum(w.set_count for w in p.conflicting),
    )
    session.add(record)
    session.flush()

    tz = ZoneInfo(user.timezone)
    for w in p.new:
        started = w.start.replace(tzinfo=tz)
        workout = Workout(
            id=uuid7(), user_id=user.id, title=w.title, started_at=started,
            ended_at=w.end.replace(tzinfo=tz) if w.end else None,
            workout_date=workout_date_for(started, user.timezone), notes=w.notes, source="hevy_import",
            import_id=record.id, import_key=w.key, import_hash=p.hashes[w.key],
        )
        for pos, b in enumerate(w.blocks):
            we = WorkoutExercise(id=uuid7(), exercise_id=exercise_for[b.title], position=pos,
                                 superset_group=b.superset_group, notes=b.notes, logged_name=b.title)
            for i, s in enumerate(b.sets):
                we.sets.append(set_row(s, i, parsed.weight_unit, parsed.distance_unit))
            workout.exercises.append(we)
        session.add(workout)
    session.flush()
    return record


def set_row(s: ParsedSet, position: int, weight_unit: str, distance_unit: str) -> Set:
    return Set(
        id=uuid7(), position=position, set_type=s.set_type,
        weight_value=s.weight, weight_unit=weight_unit if s.weight is not None else None,
        weight_kg=to_kg(s.weight, weight_unit) if s.weight is not None else None,
        reps=s.reps, rpe=s.rpe, duration_seconds=s.duration_seconds,
        distance_value=s.distance, distance_unit=distance_unit if s.distance is not None else None,
        distance_m=to_m(s.distance, distance_unit) if s.distance is not None else None,
        completed_at=None,
    )
