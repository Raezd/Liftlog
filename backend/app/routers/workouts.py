"""Workouts: history (read-only) and the upload of a finished workout.

A workout runs on the phone and reaches the server once, finished, as one
object under its client-made UUIDv7 (PUT /api/workouts/{id}). The upload is
idempotent: the same content again changes nothing and answers 200, different
content under the same id is 409 and never overwrites, and another user's id
is 404. Once stored, a finished workout is immutable in Postgres (0007).

A stored workout can then be edited (POST /api/workouts/{id}/edit) or
deleted (DELETE /api/workouts/{id}), only with a connection and only through
edit_finished_workout(), which writes the change log (0009). An edit names
the edit_revision it started from; a stale one is 409 and writes nothing.
A delete is soft: every read leaves the workout out, and an upload under its
id is 410 so the phone drops it.
"""

import datetime as dt
import hashlib
import json
import uuid
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query, Response, status
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy import exists, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.dates import workout_date_for
from app.library import check_new_id, problem
from app.models import (
    Routine, RoutineExercise, RoutineVersion, Set, User, UserExercise, Workout, WorkoutChange, WorkoutExercise,
    uuid7,
)
from app.routers.routines import SetIn, check_text, group_runs
from app.routers.routines import make_set as make_target
from app.units import M_PER, to_kg, to_m
from app.users import CurrentUser, DbSession, not_found

router = APIRouter(prefix="/api/workouts")


def _num(v):
    return None if v is None else format(v.normalize(), "f")


def _iso(t: dt.datetime | None) -> str | None:
    return t.isoformat() if t else None


def workout_out(w: Workout, names: dict[uuid.UUID, str], version: RoutineVersion | None = None,
                routine_name: str | None = None, edited_at: dt.datetime | None = None) -> dict:
    """A workout with its exercises and sets. Display uses each exercise's
    current name; logged_name is what it was called then. `version` is the
    routine version it started from, named by its routine and save date.
    `edited_at` is its last edit, if any."""
    return {
        "id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat(),
        "started_at": w.started_at.isoformat(), "ended_at": _iso(w.ended_at),
        "notes": w.notes, "source": w.source,
        "edit_revision": w.edit_revision, "edited_at": _iso(edited_at),
        "routine_version_id": str(w.routine_version_id) if w.routine_version_id else None,
        "routine_id": str(version.routine_id) if version else None,
        "routine_name": routine_name,
        "routine_version_number": version.number if version else None,
        "routine_version_created_at": version.created_at.isoformat() if version else None,
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
    them, or just `ids`). The phone caches all of these for offline use.
    Deleted workouts are never included."""
    stmt = (select(Workout, RoutineVersion, Routine.name)
            .outerjoin(RoutineVersion, RoutineVersion.id == Workout.routine_version_id)
            .outerjoin(Routine, Routine.id == RoutineVersion.routine_id)
            .where(Workout.user_id == user.id, Workout.deleted_at.is_(None))
            .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets))
            .order_by(Workout.started_at.desc()))
    if ids is not None:
        stmt = stmt.where(Workout.id.in_(ids))
    rows = session.execute(stmt).all()
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.user_id == user.id)).all())
    edited = dict(session.execute(
        select(WorkoutChange.workout_id, func.max(WorkoutChange.changed_at))
        .where(WorkoutChange.user_id == user.id, WorkoutChange.reason == "edit")
        .group_by(WorkoutChange.workout_id)).all())
    return [workout_out(w, names, v, rname, edited.get(w.id)) for w, v, rname in rows]


@router.get("")
def list_workouts(user: CurrentUser, session: DbSession, before: dt.datetime | None = None,
                  limit: int = Query(50, ge=1, le=200)) -> dict:
    """Newest first. Pass the last started_at as `before` for the next page."""
    exercises = (select(func.count()).where(WorkoutExercise.workout_id == Workout.id)
                 .correlate(Workout).scalar_subquery())
    sets = (select(func.count()).select_from(Set).join(WorkoutExercise)
            .where(WorkoutExercise.workout_id == Workout.id).correlate(Workout).scalar_subquery())
    stmt = select(Workout, exercises, sets).where(Workout.user_id == user.id, Workout.deleted_at.is_(None))
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
    # Ranges are checked in check_sets(), which names the exercise and set.
    id: uuid.UUID
    set_type: SetType = "normal"
    weight_value: Decimal | None = Field(None, allow_inf_nan=False)
    weight_unit: Literal["lb", "kg"] | None = None
    reps: int | None = None
    rpe: Decimal | None = Field(None, allow_inf_nan=False)
    duration_seconds: int | None = None
    distance_value: Decimal | None = Field(None, allow_inf_nan=False)
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


class VersionExerciseUp(BaseModel):
    exercise_id: uuid.UUID
    superset_group: int | None = Field(None, ge=0, le=1000)
    notes: str = Field("", max_length=2000)
    rest_seconds: int | None = Field(None, ge=0, le=3600)
    sets: list[SetIn] = Field([], max_length=50)


class VersionUp(BaseModel):
    """The routine version a workout started from, as the phone snapshotted
    it. Used only to recreate that version if it was pruned meanwhile."""
    id: uuid.UUID
    routine_id: uuid.UUID
    number: int = Field(ge=1)
    superset_rests: dict[str, int] = {}
    exercises: list[VersionExerciseUp] = Field([], max_length=60)


class WorkoutUp(BaseModel):
    title: str = Field(max_length=200)
    notes: str = Field("", max_length=5000)
    # From the phone's clock. workout_date is computed here from started_at.
    started_at: AwareDatetime
    ended_at: AwareDatetime
    routine_version_id: uuid.UUID | None = None
    exercises: list[ExerciseUp] = Field([], max_length=100)
    # The started-from version's content, for recreating it (not part of the hash).
    routine_version: VersionUp | None = None


def upload_hash(body: WorkoutUp) -> str:
    content = body.model_dump(mode="json", exclude={"routine_version"})
    canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def already_there(session: Session, user: User, w: Workout, digest: str, response: Response) -> dict:
    """An upload under an id that exists: a retry if it's the caller's with
    the same content, otherwise a conflict (or 404 if it's someone else's,
    410 if it was deleted). upload_hash is the first upload's and edits never
    change it, so a retry of that upload after an edit is still a no-op."""
    if w.user_id != user.id:
        raise not_found()
    if w.deleted_at is not None:
        raise problem("workout_deleted", "This workout was deleted.", status.HTTP_410_GONE)
    if w.upload_hash != digest:
        raise problem("workout_conflict", "A different workout was already saved under this id.",
                      status.HTTP_409_CONFLICT)
    response.status_code = status.HTTP_200_OK
    return full_workouts(session, user, [w.id])[0]


MAX_WEIGHT = Decimal("9999.99")
MAX_REPS = 999
MAX_DURATION = 86_400
MAX_DISTANCE_M = Decimal(1_000_000)
CENT = Decimal("0.01")
MILLI = Decimal("0.001")


def set_names(sets: list[SetUp]) -> list[str]:
    """Each set as the phone shows it: warm-ups apart ("warm-up 2"), the
    rest numbered from 1 in order ("set 3")."""
    out, warm, work = [], 0, 0
    for s in sets:
        if s.set_type == "warmup":
            warm += 1
            out.append(f"warm-up {warm}")
        else:
            work += 1
            out.append(f"set {work}")
    return out


def _shown(v: Decimal) -> str:
    return f" {format(v.normalize(), 'f')}" if v.adjusted() < 9 else ""


def set_problem(s: SetUp) -> str | None:
    """The first thing wrong with a set's values, in plain words, or None."""
    w = s.weight_value
    if (w is None) != (s.weight_unit is None):
        return "the weight needs a unit"
    if w is not None:
        if w < 0:
            return "the weight can't be negative"
        if w > MAX_WEIGHT:
            return f"the weight{_shown(w)} {s.weight_unit} is over the limit of 9999.99"
        if w != w.quantize(CENT):
            return f"the weight{_shown(w)} has more than two decimal places"
    if s.reps is not None and not 0 <= s.reps <= MAX_REPS:
        return "reps must be a whole number from 0 to 999"
    if s.rpe is not None and (not 6 <= s.rpe <= 10 or (s.rpe * 2) % 1 != 0):
        return "RPE goes from 6 to 10 in half steps"
    if s.duration_seconds is not None and not 0 <= s.duration_seconds <= MAX_DURATION:
        return "the time must be between 0 and 24 hours"
    d = s.distance_value
    if (d is None) != (s.distance_unit is None):
        return "the distance needs a unit"
    # Every unit is at least a meter, so a huge value is refused before converting.
    if d is not None and (d < 0 or d > MAX_DISTANCE_M or d * M_PER[s.distance_unit] > MAX_DISTANCE_M):
        return "the distance must be between 0 and 1,000 km"
    if d is not None and d != d.quantize(MILLI):
        return "the distance has more than three decimal places"
    return None


def check_sets(body: "WorkoutUp", names: dict[uuid.UUID, str]) -> None:
    """Refuses the whole upload (422, nothing written) at the first bad set,
    naming the exercise and the set as the phone numbers it."""
    for e in body.exercises:
        for s, label in zip(e.sets, set_names(e.sets)):
            why = set_problem(s)
            if why:
                raise problem("bad_set", f"{names.get(e.exercise_id, 'An exercise')}, {label}: {why}.")


def make_set(s: SetUp, position: int) -> Set:
    return Set(
        id=check_new_id(s.id), position=position, set_type=s.set_type,
        weight_value=s.weight_value, weight_unit=s.weight_unit,
        weight_kg=to_kg(s.weight_value, s.weight_unit) if s.weight_value is not None else None,
        reps=s.reps, rpe=s.rpe, duration_seconds=s.duration_seconds,
        distance_value=s.distance_value, distance_unit=s.distance_unit,
        distance_m=to_m(s.distance_value, s.distance_unit) if s.distance_value is not None else None,
        completed_at=s.completed_at,
    )


def recreate_version(session: Session, user: User, version_id: uuid.UUID, rv: VersionUp | None) -> bool:
    """The routine was edited elsewhere while this workout was offline, and
    the version it started from was pruned before anything used it. Puts that
    version back under its original id, from the phone's snapshot, as an
    older version (not current, no parent), so the workout keeps its link.
    False (store the workout unlinked) when the phone has no snapshot or the
    routine is gone. Someone else's routine or exercise is 404."""
    if rv is None or rv.id != version_id:
        return False
    routine = session.get(Routine, rv.routine_id)
    if routine is None:
        return False
    if routine.user_id != user.id:
        raise not_found()
    mine = set(session.scalars(select(UserExercise.id).where(
        UserExercise.user_id == user.id, UserExercise.id.in_({e.exercise_id for e in rv.exercises}))))
    if any(e.exercise_id not in mine for e in rv.exercises):
        raise not_found()
    taken = session.scalar(select(exists().where(
        RoutineVersion.routine_id == routine.id, RoutineVersion.number == rv.number)))
    number = rv.number if not taken else (session.scalar(select(func.max(RoutineVersion.number)).where(
        RoutineVersion.routine_id == routine.id)) or 0) + 1
    groups = group_runs([e.superset_group for e in rv.exercises], strict=False)
    rests = {str(g): rv.superset_rests[str(e.superset_group)] for e, g in zip(rv.exercises, groups)
             if g is not None and str(e.superset_group) in rv.superset_rests}
    # Fresh ids for its exercises and sets: nothing refers to them.
    v = RoutineVersion(id=version_id, user_id=user.id, routine_id=routine.id, number=number,
                       parent_version_id=None, superset_rests=rests)
    v.exercises = [
        RoutineExercise(exercise_id=e.exercise_id, position=i, superset_group=g, notes=e.notes.strip(),
                        rest_seconds=e.rest_seconds, sets=[make_target(s.model_copy(update={"id": None}), k)
                                                           for k, s in enumerate(e.sets)])
        for i, (e, g) in enumerate(zip(rv.exercises, groups))
    ]
    session.add(v)
    session.flush()
    return True


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
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.id.in_(mine))).all())
    check_sets(body, names)
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
        if v is None and not recreate_version(session, user, version_id, body.routine_version):
            version_id = None

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


# ---------- edit and delete ----------

class WorkoutEdit(BaseModel):
    """The whole edited workout. Start is the user's own wall-clock time in
    their timezone; the end is start plus duration. Exercise and set ids are
    kept from the workout, or new UUIDv7s for added ones. Sets' completed_at
    comes from the stored set with that id (none for added sets)."""
    base_revision: int
    title: str = Field(max_length=200)
    notes: str = Field("", max_length=5000)
    start_date: dt.date
    start_time: dt.time
    duration_minutes: int
    exercises: list[ExerciseUp] = Field([], max_length=100)


def locked_workout(session: Session, user: User, workout_id: uuid.UUID) -> Workout:
    """The caller's workout, locked until commit so edits and deletes take
    turns. Someone else's, a deleted one, or none at all is 404."""
    w = session.scalar(select(Workout).where(Workout.id == workout_id).with_for_update()
                       .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets)))
    if w is None or w.user_id != user.id or w.deleted_at is not None:
        raise not_found()
    return w


def _key(v: Decimal | None) -> str | None:
    return None if v is None else format(v.normalize(), "f")


def content_key(title, notes, started_at, ended_at, exercises) -> tuple:
    """What an edit can change, for telling a real edit from an identical
    save. `exercises` is (id, exercise_id, group, notes, rest, sets) with
    sets as SetUp or Set rows. Text compares as the save would store it,
    and groups after renumbering."""
    groups = group_runs([e[2] for e in exercises], strict=False)
    return (" ".join(title.split()), notes.strip(), started_at, ended_at, tuple(
        (e[0], e[1], g, e[3].strip(), e[4], tuple(
            (s.id, s.set_type, _key(s.weight_value), s.weight_unit, s.reps, _key(s.rpe), s.duration_seconds,
             _key(s.distance_value), s.distance_unit) for s in e[5]))
        for e, g in zip(exercises, groups)))


def edit_times(w: Workout, body: WorkoutEdit, user: User) -> tuple[dt.datetime, dt.datetime]:
    """New started_at and ended_at. Unchanged to the minute keeps the stored
    value, seconds and all, so a save with no time edit changes no time."""
    zone = ZoneInfo(user.timezone)
    if body.start_date.year < 1970:
        raise problem("bad_times", "Pick a start date from 1970 on.")
    start = dt.datetime.combine(body.start_date, body.start_time.replace(second=0, microsecond=0), tzinfo=zone)
    if w.started_at.astimezone(zone).replace(second=0, microsecond=0) == start:
        start = w.started_at
    if body.duration_minutes <= 0:
        raise problem("bad_times", "The workout needs to last at least a minute.")
    now = dt.datetime.now(dt.timezone.utc)
    if start > now or body.duration_minutes > (now - start).total_seconds() / 60:
        raise problem("bad_times", "The workout can't end in the future.")
    old_minutes = int((w.ended_at - w.started_at).total_seconds() // 60) if w.ended_at else None
    if start == w.started_at and old_minutes == body.duration_minutes:
        return start, w.ended_at
    return start, start + dt.timedelta(minutes=body.duration_minutes)


@router.post("/{workout_id}/edit")
def edit_workout(workout_id: uuid.UUID, body: WorkoutEdit, user: CurrentUser, session: DbSession) -> dict:
    """Saves an edited workout through edit_finished_workout(), one change
    log row with the before and after. 409 edit_conflict when the workout
    changed since base_revision; 422 with a plain reason for bad values; an
    identical save writes nothing. Nothing is written on any refusal."""
    w = locked_workout(session, user, workout_id)
    if body.base_revision != w.edit_revision:
        raise problem("edit_conflict", "This workout was changed somewhere else.", status.HTTP_409_CONFLICT)
    title = check_text(body.title, "workout")
    if not body.exercises:
        raise problem("no_exercises", "A workout needs at least one exercise. To remove it all, delete the workout.")
    mine = set(session.scalars(select(UserExercise.id).where(
        UserExercise.user_id == user.id, UserExercise.id.in_({e.exercise_id for e in body.exercises}))))
    if any(e.exercise_id not in mine for e in body.exercises):
        raise not_found()
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.id.in_(mine))).all())
    for e in body.exercises:
        if not e.sets:
            raise problem("no_sets", f"{names[e.exercise_id]} has no sets. Add a set or remove the exercise.")
    check_sets(body, names)
    started_at, ended_at = edit_times(w, body, user)

    old_exercises = {e.id: e for e in w.exercises}
    old_sets = {s.id: s for e in w.exercises for s in e.sets}
    ex_ids = [e.id for e in body.exercises]
    set_ids = [s.id for e in body.exercises for s in e.sets]
    if len(set(ex_ids)) != len(ex_ids) or len(set(set_ids)) != len(set_ids):
        raise problem("duplicate_id", "Each exercise and set needs its own id.")
    new_ex = [i for i in ex_ids if i not in old_exercises]
    new_sets = [i for i in set_ids if i not in old_sets]
    for i in new_ex + new_sets:
        check_new_id(i)
    if ((new_ex and session.scalar(select(exists().where(WorkoutExercise.id.in_(new_ex)))))
            or (new_sets and session.scalar(select(exists().where(Set.id.in_(new_sets)))))):
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)

    notes = body.notes.strip()
    before = content_key(w.title, w.notes, w.started_at, w.ended_at, [
        (e.id, e.exercise_id, e.superset_group, e.notes, e.rest_seconds, e.sets) for e in w.exercises])
    after = content_key(title, notes, started_at, ended_at, [
        (e.id, e.exercise_id, e.superset_group, e.notes, e.rest_seconds, e.sets) for e in body.exercises])
    if before == after:
        session.rollback()
        return full_workouts(session, user, [w.id])[0]

    groups = group_runs([e.superset_group for e in body.exercises], strict=False)
    workout_date = (w.workout_date if started_at == w.started_at
                    else workout_date_for(started_at, user.timezone))

    def logged(e: ExerciseUp) -> str:
        old = old_exercises.get(e.id)
        return old.logged_name if old is not None and old.exercise_id == e.exercise_id else names[e.exercise_id]

    def set_doc(s: SetUp, k: int) -> dict:
        row = make_set(s, k)
        old = old_sets.get(s.id)
        return {
            "id": str(s.id), "position": k, "set_type": s.set_type,
            "weight_value": _num(row.weight_value), "weight_unit": row.weight_unit, "weight_kg": _num(row.weight_kg),
            "reps": s.reps, "rpe": _num(s.rpe), "duration_seconds": s.duration_seconds,
            "distance_value": _num(row.distance_value), "distance_unit": row.distance_unit,
            "distance_m": _num(row.distance_m), "completed_at": _iso(old.completed_at) if old else None,
        }

    doc = {
        "title": title, "notes": notes, "started_at": started_at.isoformat(), "ended_at": ended_at.isoformat(),
        "workout_date": workout_date.isoformat(),
        "exercises": [{
            "id": str(e.id), "exercise_id": str(e.exercise_id), "position": pos, "superset_group": g,
            "notes": e.notes.strip(), "logged_name": logged(e), "rest_seconds": e.rest_seconds,
            "sets": [set_doc(s, k) for k, s in enumerate(e.sets)],
        } for pos, (e, g) in enumerate(zip(body.exercises, groups))],
    }
    session.execute(text("SELECT edit_finished_workout(:c, :w, 'edit', :a)"),
                    {"c": uuid7(), "w": w.id, "a": json.dumps(doc)})
    session.commit()
    session.expire_all()
    return full_workouts(session, user, [w.id])[0]


@router.delete("/{workout_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workout(workout_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    """Soft delete through edit_finished_workout(), with a change log row.
    The workout disappears from every read; there's no undo."""
    w = locked_workout(session, user, workout_id)
    now = dt.datetime.now(dt.timezone.utc)
    session.execute(text("SELECT edit_finished_workout(:c, :w, 'delete', :a)"),
                    {"c": uuid7(), "w": w.id, "a": json.dumps({"deleted_at": now.isoformat()})})
    session.commit()
