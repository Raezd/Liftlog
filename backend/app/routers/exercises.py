"""Muscles, the catalog, and the caller's exercise library."""

import uuid
from typing import Literal

from fastapi import APIRouter, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app import catalog
from app.library import (
    catalog_summary, copy_from_catalog, create_custom, exercise_out, problem, set_muscles, by_name, check_name,
)
from app.models import Muscle, MuscleMapChange, UserExercise
from app.users import CurrentUser, DbSession, not_found, owned

router = APIRouter(prefix="/api")

Equipment = Literal["barbell", "dumbbell", "machine", "cable", "bodyweight", "other"]
LoggingType = Literal["weight_reps", "bodyweight_reps", "weighted_bodyweight", "assisted_bodyweight",
                      "duration", "distance_duration"]


@router.get("/muscles")
def muscles(session: DbSession) -> list[dict]:
    return [{"id": m.id, "label": m.label} for m in session.scalars(select(Muscle).order_by(Muscle.sort))]


@router.get("/catalog")
def catalog_search(q: str = "", limit: int = Query(20, ge=1, le=50)) -> list[dict]:
    return [catalog_summary(e) for e, _ in catalog.search(q, limit)]


@router.get("/catalog/{catalog_id}")
def catalog_entry(catalog_id: str) -> dict:
    entry = catalog.by_id().get(catalog_id)
    if entry is None:
        raise not_found()
    return {**catalog_summary(entry), "instructions": entry.get("instructions") or []}


@router.get("/exercises")
def list_exercises(user: CurrentUser, session: DbSession, q: str = "", needs_review: bool = False,
                   archived: bool = False) -> list[dict]:
    stmt = select(UserExercise).where(UserExercise.user_id == user.id, UserExercise.archived == archived)
    if needs_review:
        stmt = stmt.where(UserExercise.needs_review)
    rows = list(session.scalars(stmt))
    if q.strip():
        scored = [(ex, catalog.name_score(q, ex.name)) for ex in rows]
        rows = [ex for ex, s in sorted(scored, key=lambda x: (-x[1], x[0].name.lower())) if s > 0.3]
    else:
        rows.sort(key=lambda ex: ex.name.lower())
    return [exercise_out(ex) for ex in rows]


class NewExercise(BaseModel):
    id: uuid.UUID | None = None
    catalog_id: str | None = None
    name: str | None = Field(None, max_length=200)
    equipment: Equipment | None = None
    logging_type: LoggingType | None = None
    primary_muscles: list[str] = []
    secondary_muscles: list[str] = []


@router.post("/exercises", status_code=status.HTTP_201_CREATED)
def add_exercise(body: NewExercise, user: CurrentUser, session: DbSession, response: Response) -> dict:
    """From the catalog (catalog_id) or custom (name, equipment, logging_type,
    muscles). Adding a catalog exercise you already have returns your copy."""
    if body.id is not None:
        existing = session.get(UserExercise, body.id)
        if existing is not None:
            if existing.user_id != user.id:
                raise problem("id_taken", "That id is already in use.", status.HTTP_409_CONFLICT)
            response.status_code = status.HTTP_200_OK
            return exercise_out(existing)
    if body.catalog_id:
        ex = copy_from_catalog(session, user, body.catalog_id, id=body.id)
    else:
        if body.name is None or body.equipment is None or body.logging_type is None:
            raise problem("missing_fields", "A custom exercise needs a name, equipment, and logging type.")
        ex = create_custom(session, user, name=body.name, equipment=body.equipment, logging_type=body.logging_type,
                           primary=body.primary_muscles, secondary=body.secondary_muscles, id=body.id)
    session.commit()
    return exercise_out(ex)


@router.get("/exercises/{exercise_id}")
def get_exercise(exercise_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    ex = owned(session, UserExercise, exercise_id, user)
    history = session.scalars(select(MuscleMapChange).where(MuscleMapChange.exercise_id == ex.id)
                              .order_by(MuscleMapChange.changed_at.desc()))
    return {
        **exercise_out(ex),
        "muscle_history": [{"changed_at": h.changed_at.isoformat(), "old": h.old_map, "new": h.new_map}
                           for h in history],
    }


class ExerciseEdit(BaseModel):
    name: str | None = Field(None, max_length=200)
    equipment: Equipment | None = None
    logging_type: LoggingType | None = None
    # Send both lists to change the muscles. Saving them confirms them.
    primary_muscles: list[str] | None = None
    secondary_muscles: list[str] | None = None
    archived: bool | None = None


@router.patch("/exercises/{exercise_id}")
def edit_exercise(exercise_id: uuid.UUID, body: ExerciseEdit, user: CurrentUser, session: DbSession) -> dict:
    ex = owned(session, UserExercise, exercise_id, user)
    if body.name is not None:
        name = check_name(body.name)
        other = by_name(session, user, name)
        if other is not None and other.id != ex.id:
            raise problem("name_taken", f"You already have an exercise named {name}.", status.HTTP_409_CONFLICT)
        ex.name = name
    if body.equipment is not None:
        ex.equipment = body.equipment
    if body.logging_type is not None:
        ex.logging_type = body.logging_type
    if (body.primary_muscles is None) != (body.secondary_muscles is None):
        raise problem("muscles_pair", "Send primary and secondary muscles together.")
    if body.primary_muscles is not None:
        set_muscles(session, ex, body.primary_muscles, body.secondary_muscles or [])
    if body.archived is not None:
        ex.archived = body.archived
    session.commit()
    return get_exercise(exercise_id, user, session)
