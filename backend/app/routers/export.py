"""Export: one workout or the caller's full history, as JSON or CSV, as a
file download. Browser only (the Android app points to the browser).

- JSON is the lossless backup (SCHEMA_VERSION): the workouts with every
  stored field (weights as entered plus unit plus kg, ids, routine version
  links, timezone-aware timestamps), plus the caller's exercises, current
  routines, gear, and body measurements (every site, archived too, and every
  check-in with its values as entered plus unit plus cm). One workout exports the same document with just that
  workout in it.
- CSV is the portable copy, in Hevy's workout export layout (see app/hevy.py
  for the columns, checked against a real export): one row per set, newest
  workout first, text quoted and numbers bare, weights in the user's weight
  unit and distances in their distance unit, times in the user's timezone as
  "6 Oct 2026, 16:19" with no offset, line breaks in notes as a literal \\n.
  Workouts only. Liftlog's own Hevy importer reads it back.

Everything is scoped to the caller; another user's workout is 404. Workouts
still waiting on a phone appear once they upload.
"""

import datetime as dt
import json
import uuid
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Response
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.body import body_out, ensure_sites
from app.gear import ensure_seeded, gear_out
from app.library import exercise_out
from app.models import MeasureSite, RoutineVersion, User, UserExercise, Workout, WorkoutExercise
from app.routers.offline import current_versions
from app.routers.routines import list_routines
from app.units import KG_PER, M_PER
from app.users import CurrentUser, DbSession, not_found

router = APIRouter(prefix="/api")

# 2: measurements and the length unit.
SCHEMA_VERSION = 2
Format = Literal["json", "csv"]

HEVY_TEXT = ("title", "start_time", "end_time", "description", "exercise_title")
SET_TYPES = {"normal": "normal", "warmup": "warmup", "drop": "dropset", "failure": "failure"}
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _num(v: Decimal | None) -> str | None:
    return None if v is None else format(v.normalize(), "f")


def _iso(t: dt.datetime | None) -> str | None:
    return t.isoformat() if t else None


def load_workouts(session: Session, user: User, workout_id: uuid.UUID | None = None) -> list[tuple[Workout, uuid.UUID | None]]:
    stmt = (select(Workout, RoutineVersion.routine_id)
            .outerjoin(RoutineVersion, RoutineVersion.id == Workout.routine_version_id)
            .where(Workout.user_id == user.id, Workout.deleted_at.is_(None))
            .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets))
            .order_by(Workout.started_at.desc()))
    if workout_id is not None:
        stmt = stmt.where(Workout.id == workout_id)
    return [(w, rid) for w, rid in session.execute(stmt).all()]


def workout_doc(w: Workout, routine_id: uuid.UUID | None) -> dict:
    """Every stored field of a workout, its exercises, and its sets."""
    return {
        "id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat(),
        "started_at": _iso(w.started_at), "ended_at": _iso(w.ended_at), "notes": w.notes, "source": w.source,
        "routine_version_id": str(w.routine_version_id) if w.routine_version_id else None,
        "routine_id": str(routine_id) if routine_id else None,
        "import_id": str(w.import_id) if w.import_id else None, "import_key": w.import_key,
        "import_hash": w.import_hash, "upload_hash": w.upload_hash, "created_at": _iso(w.created_at),
        "exercises": [{
            "id": str(e.id), "exercise_id": str(e.exercise_id), "position": e.position,
            "superset_group": e.superset_group, "notes": e.notes, "logged_name": e.logged_name,
            "rest_seconds": e.rest_seconds,
            "sets": [{
                "id": str(s.id), "position": s.position, "set_type": s.set_type,
                "weight_value": _num(s.weight_value), "weight_unit": s.weight_unit, "weight_kg": _num(s.weight_kg),
                "reps": s.reps, "rpe": _num(s.rpe), "duration_seconds": s.duration_seconds,
                "distance_value": _num(s.distance_value), "distance_unit": s.distance_unit,
                "distance_m": _num(s.distance_m), "completed_at": _iso(s.completed_at),
            } for s in e.sets],
        } for e in w.exercises],
    }


def measurements_doc(session: Session, user: User) -> dict:
    """Every stored field of the caller's sites and check-ins."""
    doc = body_out(session, user)
    created = dict(session.execute(select(MeasureSite.id, MeasureSite.created_at)
                                   .where(MeasureSite.user_id == user.id)).all())
    sites = [{k: v for k, v in s.items() if k != "has_values"} | {"created_at": _iso(created[uuid.UUID(s["id"])])}
             for s in doc["sites"]]
    return {"sites": sites, "checkins": doc["checkins"]}


def json_export(session: Session, user: User, rows, scope: str) -> bytes:
    ensure_seeded(session, user)
    ensure_sites(session, user)
    exercises = session.scalars(select(UserExercise).where(UserExercise.user_id == user.id)
                                .order_by(UserExercise.name))
    doc = {
        "schema": "liftlog-export", "schema_version": SCHEMA_VERSION, "scope": scope,
        "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "user": {
            "id": str(user.id), "login": user.login, "display_name": user.display_name, "timezone": user.timezone,
            "weight_unit": user.weight_unit, "distance_unit": user.distance_unit,
            "play_through_silent": user.play_through_silent, "length_unit": user.length_unit,
            "created_at": _iso(user.created_at),
        },
        "workouts": [workout_doc(w, rid) for w, rid in rows],
        "exercises": [{**exercise_out(e), "created_at": _iso(e.created_at)} for e in exercises],
        # Folders and routines (archived too), and each routine's current version.
        "routines": list_routines(user, session, archived=True),
        "routine_versions": current_versions(session, user),
        "gear": gear_out(session, user),
        "measurements": measurements_doc(session, user),
    }
    return json.dumps(doc, ensure_ascii=False, indent=2).encode()


# ---------- CSV, in Hevy's layout ----------

def hevy_time(t: dt.datetime | None, tz: ZoneInfo) -> str:
    if t is None:
        return ""
    t = t.astimezone(tz)
    return f"{t.day} {MONTHS[t.month - 1]} {t.year}, {t:%H:%M}"


def hevy_notes(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\n", "\\n")


def in_unit(value: Decimal | None, unit: str | None, base: Decimal | None, want: str, per: dict) -> str | None:
    """The value as entered when it's already in `want`, else converted from
    the normalized copy (kg or meters) and rounded to 0.01."""
    if value is None:
        return None
    if unit == want:
        return _num(value)
    return _num((base / per[want]).quantize(Decimal("0.01"), ROUND_HALF_EVEN))


def _cell(v, text: bool) -> str:
    if text:
        return '"' + (v or "").replace('"', '""') + '"'
    return "" if v is None else str(v)


def csv_export(session: Session, user: User, rows) -> bytes:
    weight_col, distance_col = ("weight_lbs" if user.weight_unit == "lb" else "weight_kg",
                                "distance_miles" if user.distance_unit == "mi" else "distance_km")
    columns = ("title", "start_time", "end_time", "description", "exercise_title", "superset_id",
               "exercise_notes", "set_index", "set_type", weight_col, "reps", distance_col,
               "duration_seconds", "rpe")
    text_cols = {*HEVY_TEXT, "exercise_notes", "set_type"}
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.user_id == user.id)).all())
    tz = ZoneInfo(user.timezone)
    lines = [",".join(_cell(c, True) for c in columns)]
    for w, _ in rows:
        for e in w.exercises:
            for k, s in enumerate(e.sets):
                row = {
                    "title": w.title, "start_time": hevy_time(w.started_at, tz), "end_time": hevy_time(w.ended_at, tz),
                    "description": hevy_notes(w.notes), "exercise_title": names.get(e.exercise_id, e.logged_name),
                    "superset_id": e.superset_group, "exercise_notes": hevy_notes(e.notes), "set_index": k,
                    "set_type": SET_TYPES[s.set_type],
                    weight_col: in_unit(s.weight_value, s.weight_unit, s.weight_kg, user.weight_unit, KG_PER),
                    "reps": s.reps,
                    distance_col: in_unit(s.distance_value, s.distance_unit, s.distance_m, user.distance_unit, M_PER),
                    "duration_seconds": s.duration_seconds, "rpe": _num(s.rpe),
                }
                lines.append(",".join(_cell(row[c], c in text_cols) for c in columns))
    # Like Hevy's: newline-separated, no newline after the last row.
    return "\n".join(lines).encode()


def download(body: bytes, fmt: Format, name: str) -> Response:
    media = "application/json" if fmt == "json" else "text/csv; charset=utf-8"
    return Response(body, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{name}.{fmt}"', "Cache-Control": "no-store"})


@router.get("/export")
def export_history(user: CurrentUser, session: DbSession, format: Format = "json") -> Response:
    rows = load_workouts(session, user)
    today = dt.datetime.now(ZoneInfo(user.timezone)).date().isoformat()
    body = json_export(session, user, rows, "history") if format == "json" else csv_export(session, user, rows)
    return download(body, format, f"liftlog-history-{today}")


@router.get("/workouts/{workout_id}/export")
def export_workout(workout_id: uuid.UUID, user: CurrentUser, session: DbSession, format: Format = "json") -> Response:
    rows = load_workouts(session, user, workout_id)
    if not rows:
        raise not_found()
    body = json_export(session, user, rows, "workout") if format == "json" else csv_export(session, user, rows)
    return download(body, format, f"liftlog-workout-{rows[0][0].workout_date.isoformat()}")
