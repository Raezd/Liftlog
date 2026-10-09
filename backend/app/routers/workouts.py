"""Workouts: history (read-only) and the upload of a finished workout.

A workout runs on the phone and reaches the server once, finished, as one
object under its client-made UUIDv7 (PUT /api/workouts/{id}). The upload is
idempotent: the same content again changes nothing and answers 200, different
content under the same id is 409 and never overwrites, and another user's id
is 404. Once stored, a finished workout is immutable in Postgres (0007).
"""

import datetime as dt
import hashlib
import json
import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Query, Response, status
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.dates import workout_date_for
from app.library import check_new_id, problem
from app.models import RoutineVersion, Set, User, UserExercise, Workout, WorkoutExercise
from app.routers.routines import check_rpe, check_text, group_runs
from app.units import to_kg, to_m
from app.users import CurrentUser, DbSession, not_found

router = APIRouter(prefix="/api/workouts")


def _num(v):
    return None if v is None else format(v.normalize(), "f")


def _iso(t: dt.datetime | None) -> str | None:
    return t.isoformat() if t else None


def workout_out(w: Workout, names: dict[uuid.UUID, str], routine_id: uuid.UUID | None) -> dict:
    """A workout with its exercises and sets. Display uses each exercise's
    current name; logged_name is what it was called then."""
    return {
        "id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat(),
        "started_at": w.started_at.isoformat(), "ended_at": _iso(w.ended_at),
        "notes": w.notes, "source": w.source,
        "routine_version_id": str(w.routine_version_id) if w.routine_version_id else None,
        "routine_id": str(routine_id) if routine_id else None,
        "exercises": [{
            "id": str(e.id), "exercise_id": str(e.exercise_id), "name": names.get(e.exercise_id, e.logged_name),
            "logged_name": e.logged_name, "position": e.position, "superset_group": e.superset_group,
            "notes": e.notes, "rest_seconds": e.rest_seconds,
            "sets": [{
                "id": str(s.id), "position": s.position, "set_type": s.set_type,
                "weight_value": _num(s.weight_value), "weight_unit": s.weight_unit, "weight_kg": _num(s.weight_kg),
                "reps": s.reps, "rpe": _num(s.rpe), "duration_seconds": s.duration_seconds,
                "distance_value": _num(s.distance_value), "distance_unit": s.distance_unit,
                "distance_m": _num(s.distance_m), "completed_at": _iso(s.completed_at),
            } for s in e.sets],
        } for e in w.exercises],
    }


def full_workouts(session: Session, user: User, ids: list[uuid.UUID] | None = None) -> list[dict]:
    """The caller's workouts, newest first, with everything in them (all of
    them, or just `ids`). The phone caches all of these for offline use."""
    stmt = (select(Workout, RoutineVersion.routine_id)
            .outerjoin(RoutineVersion, RoutineVersion.id == Workout.routine_version_id)
            .where(Workout.user_id == user.id)
            .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets))
            .order_by(Workout.started_at.desc()))
    if ids is not None:
        stmt = stmt.where(Workout.id.in_(ids))
    rows = session.execute(stmt).all()
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.user_id == user.id)).all())
    return [workout_out(w, names, rid) for w, rid in rows]


@router.get("")
def list_workouts(user: CurrentUser, session: DbSession, before: dt.datetime | None = None,
                  limit: int = Query(50, ge=1, le=200)) -> dict:
    """Newest first. Pass the last started_at as `before` for the next page."""
    exercises = (select(func.count()).where(WorkoutExercise.workout_id == Workout.id)
                 .correlate(Workout).scalar_subquery())
    sets = (select(func.count()).select_from(Set).join(WorkoutExercise)
            .where(WorkoutExercise.workout_id == Workout.id).correlate(Workout).scalar_subquery())
    stmt = select(Workout, exercises, sets).where(Workout.user_id == user.id)
    if before is not None:
        stmt = stmt.where(Workout.started_at < before)
    rows = session.execute(stmt.order_by(Workout.started_at.desc()).limit(limit + 1)).all()
    return {
        "workouts": [{
            "id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat(),
            "started_at": w.started_at.isoformat(), "ended_at": _iso(w.ended_at),
            "source": w.source, "exercise_count": ne, "set_count": ns,
        } for w, ne, ns in rows[:limit]],
        "more": len(rows) > limit,
    }


@router.get("/{workout_id}")
def get_workout(workout_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    found = full_workouts(session, user, [workout_id])
    if not found:
        raise not_found()
    return found[0]


# ---------- upload ----------

SetType = Literal["normal", "warmup", "drop", "failure"]


class SetUp(BaseModel):
    id: uuid.UUID
    set_type: SetType = "normal"
    weight_value: Decimal | None = Field(None, ge=0, le=10000)
    weight_unit: Literal["lb", "kg"] | None = None
    reps: int | None = Field(None, ge=0, le=10000)
    rpe: Decimal | None = None
    duration_seconds: int | None = Field(None, ge=0, le=172800)
    distance_value: Decimal | None = Field(None, ge=0, le=100000)
    distance_unit: Literal["mi", "km", "m"] | None = None
    completed_at: AwareDatetime | None = None


class ExerciseUp(BaseModel):
    id: uuid.UUID
    exercise_id: uuid.UUID
    # Adjacent exercises sharing a number are a superset.
    superset_group: int | None = Field(None, ge=0, le=1000)
    notes: str = Field("", max_length=2000)
    rest_seconds: int | None = Field(None, ge=0, le=3600)
    sets: list[SetUp] = Field([], max_length=100)


class WorkoutUp(BaseModel):
    title: str = Field(max_length=200)
    notes: str = Field("", max_length=5000)
    # From the phone's clock. workout_date is computed here from started_at.
    started_at: AwareDatetime
    ended_at: AwareDatetime
    routine_version_id: uuid.UUID | None = None
    exercises: list[ExerciseUp] = Field([], max_length=100)


def upload_hash(body: WorkoutUp) -> str:
    canonical = json.dumps(body.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def already_there(session: Session, user: User, w: Workout, digest: str, response: Response) -> dict:
    """An upload under an id that exists: a retry if it's the caller's with
    the same content, otherwise a conflict (or 404 if it's someone else's)."""
    if w.user_id != user.id:
        raise not_found()
    if w.upload_hash != digest:
        raise problem("workout_conflict", "A different workout was already saved under this id.",
                      status.HTTP_409_CONFLICT)
    response.status_code = status.HTTP_200_OK
    return full_workouts(session, user, [w.id])[0]


def make_set(s: SetUp, position: int) -> Set:
    if (s.weight_value is None) != (s.weight_unit is None):
        raise problem("bad_weight", "A weight needs a unit.")
    if (s.distance_value is None) != (s.distance_unit is None):
        raise problem("bad_distance", "A distance needs a unit.")
    return Set(
        id=check_new_id(s.id), position=position, set_type=s.set_type,
        weight_value=s.weight_value, weight_unit=s.weight_unit,
        weight_kg=to_kg(s.weight_value, s.weight_unit) if s.weight_value is not None else None,
        reps=s.reps, rpe=check_rpe(s.rpe), duration_seconds=s.duration_seconds,
        distance_value=s.distance_value, distance_unit=s.distance_unit,
        distance_m=to_m(s.distance_value, s.distance_unit) if s.distance_value is not None else None,
        completed_at=s.completed_at,
    )


@router.put("/{workout_id}", status_code=status.HTTP_201_CREATED)
def upload_workout(workout_id: uuid.UUID, body: WorkoutUp, user: CurrentUser, session: DbSession,
                   response: Response) -> dict:
    """Stores a finished workout from the phone, all at once. 201 when new,
    200 when it's already here with the same content, 409 workout_conflict
    when the id holds different content, 404 when the id is someone else's."""
    digest = upload_hash(body)
    existing = session.get(Workout, workout_id)
    if existing is not None:
        return already_there(session, user, existing, digest, response)
    check_new_id(workout_id)
    title = check_text(body.title, "workout")
    if body.ended_at < body.started_at:
        raise problem("bad_times", "The workout ends before it starts.")

    mine = set(session.scalars(select(UserExercise.id).where(
        UserExercise.user_id == user.id, UserExercise.id.in_({e.exercise_id for e in body.exercises}))))
    if any(e.exercise_id not in mine for e in body.exercises):
        raise not_found()
    ex_ids = [e.id for e in body.exercises]
    set_ids = [s.id for e in body.exercises for s in e.sets]
    if len(set(ex_ids)) != len(ex_ids) or len(set(set_ids)) != len(set_ids):
        raise problem("duplicate_id", "Each exercise and set needs its own id.")
    if ((ex_ids and session.scalar(select(exists().where(WorkoutExercise.id.in_(ex_ids)))))
            or (set_ids and session.scalar(select(exists().where(Set.id.in_(set_ids)))))):
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)

    version_id = body.routine_version_id
    if version_id is not None:
        v = session.get(RoutineVersion, version_id)
        if v is not None and v.user_id != user.id:
            raise not_found()
        # The routine was edited elsewhere while this workout was offline, and
        # the version it started from was pruned before anything used it.
        # Store the workout anyway, without the link (see HANDOFF.md).
        if v is None:
            version_id = None

    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.id.in_(mine))).all())
    groups = group_runs([e.superset_group for e in body.exercises], strict=False)
    w = Workout(
        id=workout_id, user_id=user.id, title=title, started_at=body.started_at, ended_at=body.ended_at,
        workout_date=workout_date_for(body.started_at, user.timezone), notes=body.notes.strip(),
        source="liftlog", routine_version_id=version_id, upload_hash=digest,
    )
    for pos, (e, g) in enumerate(zip(body.exercises, groups)):
        w.exercises.append(WorkoutExercise(
            id=check_new_id(e.id), exercise_id=e.exercise_id, position=pos, superset_group=g,
            notes=e.notes.strip(), logged_name=names[e.exercise_id], rest_seconds=e.rest_seconds,
            sets=[make_set(s, k) for k, s in enumerate(e.sets)]))
    session.add(w)
    try:
        session.commit()
    except IntegrityError:
        # Two copies of the same upload at once: the other one landed first.
        session.rollback()
        existing = session.get(Workout, workout_id)
        if existing is None:
            raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
        return already_there(session, user, existing, digest, response)
    return full_workouts(session, user, [w.id])[0]
