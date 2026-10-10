"""Folders (programs) and routines (days), with immutable versions.

Every save of a routine's content writes a new version and moves the
routine's pointer to it; versions are never changed (a trigger enforces it),
so workouts that started from them (Spec 5) keep what they used. A save names
the version it was edited from, and if that's no longer current the save is
refused with 409 and nothing is written. Otherwise, in the same transaction,
the version it replaced is deleted unless a workout references it: only the
current version and versions workouts used are kept.

A routine or folder that no workout has used can be deleted. Once used, it can
only be archived.
"""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.orm import Session, selectinload

from app.library import check_new_id, problem
from app.models import (
    Routine, RoutineExercise, RoutineFolder, RoutineSet, RoutineVersion, User, UserExercise, Workout,
    WorkoutExercise,
)
from app.units import to_kg, to_m
from app.users import CurrentUser, DbSession, not_found, owned

router = APIRouter(prefix="/api")

SetType = Literal["normal", "warmup", "drop", "failure"]
MAX_SUPERSET = 3


# ---------- input ----------

class SetIn(BaseModel):
    id: uuid.UUID | None = None
    set_type: SetType = "normal"
    # A fixed number is min = max. Send just one and it's used for both.
    reps_min: int | None = Field(None, ge=0, le=1000)
    reps_max: int | None = Field(None, ge=0, le=1000)
    weight_value: Decimal | None = Field(None, ge=0, le=10000)
    weight_unit: Literal["lb", "kg"] | None = None
    rpe: Decimal | None = None
    duration_seconds: int | None = Field(None, ge=0, le=86400)
    distance_value: Decimal | None = Field(None, ge=0, le=100000)
    distance_unit: Literal["mi", "km", "m"] | None = None


class ExerciseIn(BaseModel):
    id: uuid.UUID | None = None
    exercise_id: uuid.UUID
    # Exercises with the same number, next to each other, are a superset.
    superset_group: int | None = Field(None, ge=0, le=1000)
    notes: str = Field("", max_length=2000)
    rest_seconds: int | None = Field(None, ge=0, le=3600)
    sets: list[SetIn] = Field([], max_length=50)


class VersionIn(BaseModel):
    id: uuid.UUID | None = None
    exercises: list[ExerciseIn] = Field([], max_length=60)
    # Superset group (as sent, as a string) -> rest seconds after each round.
    superset_rests: dict[str, int] = {}


def check_text(name: str, what: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise problem("name_required", f"Give the {what} a name.")
    if len(name) > 120:
        raise problem("name_too_long", "Keep the name under 120 characters.")
    return name


def group_runs(groups: list[int | None], strict: bool) -> list[int | None]:
    """Superset groups renumbered 0, 1, 2... in order. A group is a run of
    adjacent exercises sharing a number; a run of one is no superset.
    strict (the editor): a split group or more than three is an error.
    Otherwise (copied from a workout) runs are split into threes."""
    out: list[int | None] = [None] * len(groups)
    seen: set[int] = set()
    n, i = 0, 0
    while i < len(groups):
        g = groups[i]
        j = i
        while j + 1 < len(groups) and g is not None and groups[j + 1] == g:
            j += 1
        if g is not None:
            if strict and g in seen:
                raise problem("superset_split", "Exercises in a superset need to be next to each other.")
            seen.add(g)
            size = j - i + 1
            if strict and size > MAX_SUPERSET:
                raise problem("superset_too_big", "A superset can have up to three exercises.")
            for start in range(i, j + 1, MAX_SUPERSET):
                chunk = range(start, min(start + MAX_SUPERSET, j + 1))
                if len(chunk) > 1:
                    for k in chunk:
                        out[k] = n
                    n += 1
        i = j + 1
    return out


def check_rpe(rpe: Decimal | None) -> Decimal | None:
    if rpe is None:
        return None
    if not (6 <= rpe <= 10) or (rpe * 2) % 1 != 0:
        raise problem("bad_rpe", "RPE goes from 6 to 10 in half steps.")
    return rpe


def make_set(s: SetIn, position: int) -> RoutineSet:
    lo, hi = s.reps_min, s.reps_max
    if lo is None:
        lo = hi
    if hi is None:
        hi = lo
    if lo is not None and hi is not None and hi < lo:
        raise problem("bad_reps", "The rep range goes from low to high.")
    if (s.weight_value is None) != (s.weight_unit is None):
        raise problem("bad_weight", "A weight needs a unit.")
    if (s.distance_value is None) != (s.distance_unit is None):
        raise problem("bad_distance", "A distance needs a unit.")
    return RoutineSet(
        id=check_new_id(s.id), position=position, set_type=s.set_type, reps_min=lo, reps_max=hi,
        weight_value=s.weight_value, weight_unit=s.weight_unit,
        weight_kg=to_kg(s.weight_value, s.weight_unit) if s.weight_value is not None else None,
        rpe=check_rpe(s.rpe), duration_seconds=s.duration_seconds,
        distance_value=s.distance_value, distance_unit=s.distance_unit,
        distance_m=to_m(s.distance_value, s.distance_unit) if s.distance_value is not None else None,
    )


def ids_taken(session: Session, body: VersionIn) -> bool:
    ex_ids = [e.id for e in body.exercises if e.id]
    set_ids = [s.id for e in body.exercises for s in e.sets if s.id]
    return bool(
        (body.id and session.get(RoutineVersion, body.id) is not None)
        or (ex_ids and session.scalar(select(exists().where(RoutineExercise.id.in_(ex_ids)))))
        or (set_ids and session.scalar(select(exists().where(RoutineSet.id.in_(set_ids))))))


def write_version(session: Session, user: User, routine: Routine, body: VersionIn,
                  parent: uuid.UUID | None, strict: bool = True) -> RoutineVersion:
    """A new version from the given content, made current."""
    mine = set(session.scalars(select(UserExercise.id).where(
        UserExercise.user_id == user.id, UserExercise.id.in_({e.exercise_id for e in body.exercises}))))
    if any(e.exercise_id not in mine for e in body.exercises):
        raise not_found()
    if ids_taken(session, body):
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
    groups = group_runs([e.superset_group for e in body.exercises], strict)
    rests: dict[str, int] = {}
    for e, g in zip(body.exercises, groups):
        rest = body.superset_rests.get(str(e.superset_group)) if e.superset_group is not None else None
        if g is not None and rest is not None:
            if not 0 <= rest <= 3600:
                raise problem("bad_rest", "Rest time is up to an hour.")
            rests[str(g)] = rest
    number = (session.scalar(select(func.max(RoutineVersion.number)).where(
        RoutineVersion.routine_id == routine.id)) or 0) + 1
    v = RoutineVersion(id=check_new_id(body.id), user_id=user.id, routine_id=routine.id, number=number,
                       parent_version_id=parent, superset_rests=rests)
    v.exercises = [
        RoutineExercise(id=check_new_id(e.id), exercise_id=e.exercise_id, position=i, superset_group=g,
                        notes=e.notes.strip(), rest_seconds=e.rest_seconds,
                        sets=[make_set(s, k) for k, s in enumerate(e.sets)])
        for i, (e, g) in enumerate(zip(body.exercises, groups))
    ]
    session.add(v)
    session.flush()
    routine.current_version_id = v.id
    session.flush()
    return v


def copy_content(v: RoutineVersion) -> VersionIn:
    """A version's content as input for a new one (new ids)."""
    return VersionIn(
        superset_rests=dict(v.superset_rests),
        exercises=[ExerciseIn(
            exercise_id=e.exercise_id, superset_group=e.superset_group, notes=e.notes, rest_seconds=e.rest_seconds,
            sets=[SetIn(set_type=s.set_type, reps_min=s.reps_min, reps_max=s.reps_max, weight_value=s.weight_value,
                        weight_unit=s.weight_unit, rpe=s.rpe, duration_seconds=s.duration_seconds,
                        distance_value=s.distance_value, distance_unit=s.distance_unit) for s in e.sets],
        ) for e in v.exercises],
    )


# ---------- output ----------

def _num(v):
    return None if v is None else format(v.normalize(), "f")


def load_version(session: Session, version_id: uuid.UUID) -> RoutineVersion:
    return session.scalar(select(RoutineVersion).where(RoutineVersion.id == version_id).options(
        selectinload(RoutineVersion.exercises).selectinload(RoutineExercise.sets)).execution_options(
        populate_existing=True))


def version_out(session: Session, v: RoutineVersion) -> dict:
    exs = {e.id: e for e in session.scalars(select(UserExercise).where(
        UserExercise.id.in_([e.exercise_id for e in v.exercises])))}
    return {
        "id": str(v.id), "routine_id": str(v.routine_id), "number": v.number,
        "parent_version_id": str(v.parent_version_id) if v.parent_version_id else None,
        "created_at": v.created_at.isoformat(), "superset_rests": v.superset_rests,
        "exercises": [{
            "id": str(e.id), "exercise_id": str(e.exercise_id), "name": exs[e.exercise_id].name,
            "logging_type": exs[e.exercise_id].logging_type, "equipment": exs[e.exercise_id].equipment,
            "position": e.position, "superset_group": e.superset_group, "notes": e.notes,
            "rest_seconds": e.rest_seconds,
            "sets": [{
                "id": str(s.id), "position": s.position, "set_type": s.set_type,
                "reps_min": s.reps_min, "reps_max": s.reps_max,
                "weight_value": _num(s.weight_value), "weight_unit": s.weight_unit, "weight_kg": _num(s.weight_kg),
                "rpe": _num(s.rpe), "duration_seconds": s.duration_seconds,
                "distance_value": _num(s.distance_value), "distance_unit": s.distance_unit,
                "distance_m": _num(s.distance_m),
            } for s in e.sets],
        } for e in v.exercises],
    }


def prune(session: Session, version_id: uuid.UUID | None) -> None:
    """Deletes a replaced version unless a workout references it."""
    if version_id is None:
        return
    session.execute(delete(RoutineVersion).where(
        RoutineVersion.id == version_id,
        ~exists().where(Workout.routine_version_id == RoutineVersion.id)).execution_options(
        synchronize_session=False))
    session.expire_all()


def used_routines(session: Session, user: User) -> set[uuid.UUID]:
    """Routines some workout started from. These can't be deleted."""
    return set(session.scalars(select(RoutineVersion.routine_id).distinct().join(
        Workout, Workout.routine_version_id == RoutineVersion.id).where(RoutineVersion.user_id == user.id)))


def routine_out(session: Session, r: Routine, used: bool) -> dict:
    return {
        "id": str(r.id), "name": r.name, "folder_id": str(r.folder_id) if r.folder_id else None,
        "position": r.position, "archived": r.archived, "used": used,
        "current_version": version_out(session, load_version(session, r.current_version_id)),
    }


def routine_detail(session: Session, user: User, r: Routine) -> dict:
    return routine_out(session, r, r.id in used_routines(session, user))


def next_position(session: Session, model, user: User, **where) -> int:
    stmt = select(func.max(model.position)).where(model.user_id == user.id)
    for k, v in where.items():
        stmt = stmt.where(getattr(model, k).is_(None) if v is None else getattr(model, k) == v)
    return (session.scalar(stmt) or 0) + 1


def make_room_after(session: Session, model, user: User, position: int, **where) -> int:
    """Shifts everything after `position` down one and returns the free slot."""
    stmt = update(model).where(model.user_id == user.id, model.position > position)
    for k, v in where.items():
        stmt = stmt.where(getattr(model, k).is_(None) if v is None else getattr(model, k) == v)
    session.execute(stmt.values(position=model.position + 1))
    return position + 1


def claim(session: Session, model, id: uuid.UUID | None, user: User):
    """A client-chosen id: the caller's existing row (a retry), None if free,
    or 409 if someone else has it."""
    if id is None:
        return None
    row = session.get(model, id)
    if row is not None and row.user_id != user.id:
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
    return row


# ---------- the routines page ----------

@router.get("/routines")
def list_routines(user: CurrentUser, session: DbSession, archived: bool = False) -> dict:
    """Folders in order with their routines in order, then routines in no
    folder. archived=true also includes archived folders and routines."""
    folders = list(session.scalars(select(RoutineFolder).where(RoutineFolder.user_id == user.id)
                                   .order_by(RoutineFolder.position, RoutineFolder.created_at)))
    routines = list(session.scalars(select(Routine).where(Routine.user_id == user.id)
                                    .order_by(Routine.position, Routine.created_at)))
    used = used_routines(session, user)
    used_folders = {r.folder_id for r in routines if r.id in used}
    if not archived:
        folders = [f for f in folders if not f.archived]
        routines = [r for r in routines if not r.archived]
    # A short summary per routine: exercise names and counts from the current version.
    rows = session.execute(
        select(RoutineExercise.version_id, UserExercise.name, func.count(RoutineSet.id))
        .join(UserExercise, UserExercise.id == RoutineExercise.exercise_id)
        .outerjoin(RoutineSet, RoutineSet.routine_exercise_id == RoutineExercise.id)
        .where(RoutineExercise.version_id.in_([r.current_version_id for r in routines]))
        .group_by(RoutineExercise.id, RoutineExercise.version_id, UserExercise.name, RoutineExercise.position)
        .order_by(RoutineExercise.position)).all()
    names: dict[uuid.UUID, list[str]] = {}
    sets: dict[uuid.UUID, int] = {}
    for vid, name, n in rows:
        names.setdefault(vid, []).append(name)
        sets[vid] = sets.get(vid, 0) + n

    def summary(r: Routine) -> dict:
        return {
            "id": str(r.id), "name": r.name, "folder_id": str(r.folder_id) if r.folder_id else None,
            "position": r.position, "archived": r.archived, "used": r.id in used,
            "current_version_id": str(r.current_version_id),
            "exercise_names": names.get(r.current_version_id, []), "set_count": sets.get(r.current_version_id, 0),
        }

    return {
        "folders": [{
            "id": str(f.id), "name": f.name, "position": f.position, "archived": f.archived,
            "used": f.id in used_folders,
            "routines": [summary(r) for r in routines if r.folder_id == f.id],
        } for f in folders],
        "routines": [summary(r) for r in routines if r.folder_id is None],
    }


class LayoutGroup(BaseModel):
    folder_id: uuid.UUID | None = None
    routine_ids: list[uuid.UUID] = Field([], max_length=500)


class Layout(BaseModel):
    folders: list[uuid.UUID] = Field([], max_length=500)
    groups: list[LayoutGroup] = Field([], max_length=501)


@router.put("/routines/layout", status_code=status.HTTP_204_NO_CONTENT)
def set_layout(body: Layout, user: CurrentUser, session: DbSession) -> None:
    """Saves the order of folders, and which folder each routine is in and in what order."""
    for i, fid in enumerate(body.folders):
        owned(session, RoutineFolder, fid, user).position = i + 1
    for g in body.groups:
        if g.folder_id is not None:
            owned(session, RoutineFolder, g.folder_id, user)
        for i, rid in enumerate(g.routine_ids):
            r = owned(session, Routine, rid, user)
            r.folder_id, r.position = g.folder_id, i + 1
    session.commit()


# ---------- folders ----------

class FolderIn(BaseModel):
    id: uuid.UUID | None = None
    name: str = Field(max_length=200)


def folder_out(f: RoutineFolder) -> dict:
    return {"id": str(f.id), "name": f.name, "position": f.position, "archived": f.archived}


@router.post("/folders", status_code=status.HTTP_201_CREATED)
def create_folder(body: FolderIn, user: CurrentUser, session: DbSession, response: Response) -> dict:
    existing = claim(session, RoutineFolder, body.id, user)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return folder_out(existing)
    f = RoutineFolder(id=check_new_id(body.id), user_id=user.id, name=check_text(body.name, "folder"),
                      position=next_position(session, RoutineFolder, user))
    session.add(f)
    session.commit()
    return folder_out(f)


class FolderEdit(BaseModel):
    name: str | None = Field(None, max_length=200)
    archived: bool | None = None


@router.patch("/folders/{folder_id}")
def edit_folder(folder_id: uuid.UUID, body: FolderEdit, user: CurrentUser, session: DbSession) -> dict:
    f = owned(session, RoutineFolder, folder_id, user)
    if body.name is not None:
        f.name = check_text(body.name, "folder")
    if body.archived is not None:
        f.archived = body.archived
    session.commit()
    return folder_out(f)


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(folder_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    """Deletes the folder and its routines, only if no workout used any of them."""
    f = owned(session, RoutineFolder, folder_id, user)
    inside = set(session.scalars(select(Routine.id).where(Routine.folder_id == f.id)))
    if inside & used_routines(session, user):
        raise problem("in_use", "A workout used a routine in this folder, so it can only be archived.",
                      status.HTTP_409_CONFLICT)
    session.execute(delete(Routine).where(Routine.folder_id == f.id, Routine.user_id == user.id))
    session.delete(f)
    session.commit()


class DuplicateIn(BaseModel):
    id: uuid.UUID | None = None


def duplicate(session: Session, user: User, r: Routine, *, folder_id: uuid.UUID | None, name: str,
              position: int, id: uuid.UUID | None = None) -> Routine:
    copy = Routine(id=check_new_id(id), user_id=user.id, folder_id=folder_id, name=name, position=position)
    session.add(copy)
    session.flush()
    write_version(session, user, copy, copy_content(load_version(session, r.current_version_id)), parent=None)
    return copy


def copy_name(name: str) -> str:
    return f"{name} copy"[:120]


@router.post("/folders/{folder_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_folder(folder_id: uuid.UUID, body: DuplicateIn, user: CurrentUser, session: DbSession) -> dict:
    """A copy of the folder, right after it, with a copy of each routine that isn't archived."""
    f = owned(session, RoutineFolder, folder_id, user)
    if claim(session, RoutineFolder, body.id, user) is not None:
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
    new = RoutineFolder(id=check_new_id(body.id), user_id=user.id, name=copy_name(f.name),
                        position=make_room_after(session, RoutineFolder, user, f.position))
    session.add(new)
    session.flush()
    routines = session.scalars(select(Routine).where(Routine.folder_id == f.id, ~Routine.archived)
                               .order_by(Routine.position, Routine.created_at))
    for i, r in enumerate(list(routines)):
        duplicate(session, user, r, folder_id=new.id, name=r.name, position=i + 1)
    session.commit()
    return folder_out(new)


# ---------- routines ----------

class RoutineIn(BaseModel):
    id: uuid.UUID | None = None
    name: str = Field(max_length=200)
    folder_id: uuid.UUID | None = None
    version: VersionIn = VersionIn()


@router.post("/routines", status_code=status.HTTP_201_CREATED)
def create_routine(body: RoutineIn, user: CurrentUser, session: DbSession, response: Response) -> dict:
    existing = claim(session, Routine, body.id, user)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return routine_detail(session, user, existing)
    if body.folder_id is not None:
        owned(session, RoutineFolder, body.folder_id, user)
    r = Routine(id=check_new_id(body.id), user_id=user.id, folder_id=body.folder_id,
                name=check_text(body.name, "routine"),
                position=next_position(session, Routine, user, folder_id=body.folder_id))
    session.add(r)
    session.flush()
    write_version(session, user, r, body.version, parent=None)
    session.commit()
    return routine_detail(session, user, r)


@router.get("/routines/{routine_id}")
def get_routine(routine_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    return routine_detail(session, user, owned(session, Routine, routine_id, user))


class RoutineEdit(BaseModel):
    name: str | None = Field(None, max_length=200)
    archived: bool | None = None
    # Send folder_id (null for none) to move it; it goes to the end of that folder.
    folder_id: uuid.UUID | None = None


@router.patch("/routines/{routine_id}")
def edit_routine(routine_id: uuid.UUID, body: RoutineEdit, user: CurrentUser, session: DbSession) -> dict:
    r = owned(session, Routine, routine_id, user)
    if body.name is not None:
        r.name = check_text(body.name, "routine")
    if "folder_id" in body.model_fields_set and body.folder_id != r.folder_id:
        if body.folder_id is not None:
            owned(session, RoutineFolder, body.folder_id, user)
        r.position = next_position(session, Routine, user, folder_id=body.folder_id)
        r.folder_id = body.folder_id
    if body.archived is not None:
        r.archived = body.archived
        # Bringing a routine back brings its folder back too, or it would stay hidden.
        if not r.archived and r.folder_id is not None:
            owned(session, RoutineFolder, r.folder_id, user).archived = False
    session.commit()
    return routine_detail(session, user, r)


@router.delete("/routines/{routine_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_routine(routine_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    r = owned(session, Routine, routine_id, user)
    if r.id in used_routines(session, user):
        raise problem("in_use", "A workout used this routine, so it can only be archived.", status.HTTP_409_CONFLICT)
    session.execute(delete(Routine).where(Routine.id == r.id))
    session.commit()


@router.post("/routines/{routine_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_routine(routine_id: uuid.UUID, body: DuplicateIn, user: CurrentUser, session: DbSession) -> dict:
    """A copy right after the original, in the same folder."""
    r = owned(session, Routine, routine_id, user)
    if claim(session, Routine, body.id, user) is not None:
        raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
    pos = make_room_after(session, Routine, user, r.position, folder_id=r.folder_id)
    copy = duplicate(session, user, r, folder_id=r.folder_id, name=copy_name(r.name), position=pos, id=body.id)
    session.commit()
    return routine_detail(session, user, copy)


# ---------- versions ----------

class SaveIn(VersionIn):
    # The version the edit started from. Must still be current.
    parent_version_id: uuid.UUID
    name: str | None = Field(None, max_length=200)


@router.post("/routines/{routine_id}/versions", status_code=status.HTTP_201_CREATED)
def save_version(routine_id: uuid.UUID, body: SaveIn, user: CurrentUser, session: DbSession,
                 response: Response) -> dict:
    """Saves the editor's content as a new version. 409 version_conflict if
    the routine was saved elsewhere since this edit started."""
    # Lock the routine row so two saves from the same parent can't both win.
    r = session.scalar(select(Routine).where(Routine.id == routine_id).with_for_update())
    if r is None or r.user_id != user.id:
        raise not_found()
    existing = claim(session, RoutineVersion, body.id, user)
    if existing is not None:
        if existing.routine_id != r.id:
            raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
        response.status_code = status.HTTP_200_OK
        return routine_detail(session, user, r)
    if body.parent_version_id != r.current_version_id:
        raise problem("version_conflict", "This routine was changed somewhere else. Reload it and try again.",
                      status.HTTP_409_CONFLICT)
    if body.name is not None:
        r.name = check_text(body.name, "routine")
    previous = r.current_version_id
    write_version(session, user, r, body, parent=previous)
    prune(session, previous)
    session.commit()
    return routine_detail(session, user, r)


@router.get("/routines/{routine_id}/versions")
def list_versions(routine_id: uuid.UUID, user: CurrentUser, session: DbSession) -> list[dict]:
    r = owned(session, Routine, routine_id, user)
    vs = session.scalars(select(RoutineVersion).where(RoutineVersion.routine_id == r.id)
                         .order_by(RoutineVersion.number.desc())).all()
    # The caller's workouts that started from each version, newest first.
    used: dict[uuid.UUID, list[dict]] = {}
    for w in session.scalars(select(Workout).where(
            Workout.user_id == user.id, Workout.routine_version_id.in_([v.id for v in vs]))
            .order_by(Workout.started_at.desc())):
        used.setdefault(w.routine_version_id, []).append(
            {"id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat()})
    return [{"id": str(v.id), "number": v.number, "created_at": v.created_at.isoformat(),
             "current": v.id == r.current_version_id, "workouts": used.get(v.id, [])} for v in vs]


@router.get("/routines/{routine_id}/versions/{version_id}")
def get_version(routine_id: uuid.UUID, version_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    r = owned(session, Routine, routine_id, user)
    v = session.get(RoutineVersion, version_id)
    if v is None or v.routine_id != r.id or v.user_id != user.id:
        raise not_found()
    return version_out(session, load_version(session, v.id))


# ---------- save a workout as a routine ----------

class FromWorkoutIn(BaseModel):
    id: uuid.UUID | None = None
    workout_id: uuid.UUID
    name: str = Field(max_length=200)
    # Pick a folder, name a new one, or neither for no folder.
    folder_id: uuid.UUID | None = None
    new_folder_name: str | None = Field(None, max_length=200)


@router.post("/routines/from-workout", status_code=status.HTTP_201_CREATED)
def from_workout(body: FromWorkoutIn, user: CurrentUser, session: DbSession, response: Response) -> dict:
    """A new routine from a past workout: exercises, order, supersets, notes,
    set types, and each set's actual weight and reps (also duration and
    distance) as fixed targets. RPE isn't copied."""
    existing = claim(session, Routine, body.id, user)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return routine_detail(session, user, existing)
    w = session.scalar(select(Workout).where(Workout.id == body.workout_id, Workout.user_id == user.id)
                       .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets)))
    if w is None:
        raise not_found()
    name = check_text(body.name, "routine")
    folder_id = body.folder_id
    if body.new_folder_name is not None and body.new_folder_name.strip():
        f = RoutineFolder(id=check_new_id(None), user_id=user.id, name=check_text(body.new_folder_name, "folder"),
                          position=next_position(session, RoutineFolder, user))
        session.add(f)
        session.flush()
        folder_id = f.id
    elif folder_id is not None:
        owned(session, RoutineFolder, folder_id, user)
    r = Routine(id=check_new_id(body.id), user_id=user.id, folder_id=folder_id, name=name,
                position=next_position(session, Routine, user, folder_id=folder_id))
    session.add(r)
    session.flush()
    content = VersionIn(exercises=[ExerciseIn(
        exercise_id=e.exercise_id, superset_group=e.superset_group, notes=e.notes,
        sets=[SetIn(set_type=s.set_type, reps_min=s.reps, reps_max=s.reps, weight_value=s.weight_value,
                    weight_unit=s.weight_unit, duration_seconds=s.duration_seconds,
                    distance_value=s.distance_value, distance_unit=s.distance_unit) for s in e.sets],
    ) for e in w.exercises])
    write_version(session, user, r, content, parent=None, strict=False)
    session.commit()
    return routine_detail(session, user, r)
