"""A user's exercise library: copying catalog entries, custom exercises,
edits, and the muscle-map change log. Shared by the library routes and the
Hevy import."""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import catalog
from app.models import MuscleMapChange, User, UserExercise, uuid7


def problem(code: str, message: str, http: int = status.HTTP_422_UNPROCESSABLE_CONTENT) -> HTTPException:
    return HTTPException(http, {"code": code, "message": message})


def check_muscles(primary: list[str], secondary: list[str]) -> tuple[list[str], list[str]]:
    vocab = catalog.muscle_ids()
    bad = [m for m in primary + secondary if m not in vocab]
    if bad:
        raise problem("unknown_muscle", f"Unknown muscle: {', '.join(bad)}")
    if len(set(primary)) != len(primary) or len(set(secondary)) != len(secondary):
        raise problem("duplicate_muscle", "A muscle is listed twice.")
    if set(primary) & set(secondary):
        raise problem("muscle_both", "A muscle can't be both primary and secondary.")
    return primary, secondary


def check_name(name: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise problem("name_required", "Give the exercise a name.")
    if len(name) > 120:
        raise problem("name_too_long", "Keep the name under 120 characters.")
    return name


def by_name(session: Session, user: User, name: str) -> UserExercise | None:
    return session.scalar(select(UserExercise).where(
        UserExercise.user_id == user.id, func.lower(UserExercise.name) == name.lower()))


def by_catalog(session: Session, user: User, catalog_id: str) -> UserExercise | None:
    return session.scalar(select(UserExercise).where(
        UserExercise.user_id == user.id, UserExercise.catalog_id == catalog_id))


def name_taken(name: str) -> HTTPException:
    return problem("name_taken", f"You already have an exercise named {name}.", status.HTTP_409_CONFLICT)


def check_new_id(id: uuid.UUID | None) -> uuid.UUID:
    """Clients make their own ids for offline sync. They must be UUIDv7."""
    if id is None:
        return uuid7()
    if id.version != 7:
        raise problem("bad_id", "Ids must be UUIDv7.")
    return id


def copy_from_catalog(session: Session, user: User, catalog_id: str, *, id: uuid.UUID | None = None,
                      primary: list[str] | None = None, secondary: list[str] | None = None,
                      confirmed: bool = False) -> UserExercise:
    """The user's copy of a catalog exercise, made the first time it's needed.
    Shoulders become the delts the name suggests, and the copy needs review
    until the user confirms them. primary/secondary override the suggestion
    (the import review screen lets you adjust delts before importing)."""
    existing = by_catalog(session, user, catalog_id)
    if existing is not None:
        return existing
    entry = catalog.by_id().get(catalog_id)
    if entry is None:
        raise problem("unknown_catalog", "That exercise isn't in the catalog.", status.HTTP_404_NOT_FOUND)
    if by_name(session, user, entry["name"]) is not None:
        raise name_taken(entry["name"])
    suggested = catalog.muscles_for(entry)
    if primary is None and secondary is None:
        primary, secondary = suggested.primary, suggested.secondary
    primary, secondary = check_muscles(primary or [], secondary or [])
    ex = UserExercise(
        id=check_new_id(id), user_id=user.id, catalog_id=catalog_id, name=entry["name"],
        equipment=catalog.equipment_for(entry.get("equipment")), logging_type=catalog.logging_type_for(entry),
        primary_muscles=primary, secondary_muscles=secondary,
        needs_review=suggested.shoulders and not confirmed,
    )
    session.add(ex)
    session.flush()
    return ex


def create_custom(session: Session, user: User, *, name: str, equipment: str, logging_type: str,
                  primary: list[str], secondary: list[str], id: uuid.UUID | None = None) -> UserExercise:
    name = check_name(name)
    if equipment not in catalog.EQUIPMENT:
        raise problem("bad_equipment", "Pick an equipment type.")
    if logging_type not in catalog.LOGGING_TYPES:
        raise problem("bad_logging_type", "Pick how this exercise is logged.")
    primary, secondary = check_muscles(primary, secondary)
    if by_name(session, user, name) is not None:
        raise name_taken(name)
    ex = UserExercise(id=check_new_id(id), user_id=user.id, catalog_id=None, name=name,
                      equipment=equipment, logging_type=logging_type,
                      primary_muscles=primary, secondary_muscles=secondary, needs_review=False)
    session.add(ex)
    session.flush()
    return ex


def muscle_map(ex: UserExercise) -> dict:
    return {"primary": list(ex.primary_muscles), "secondary": list(ex.secondary_muscles)}


def set_muscles(session: Session, ex: UserExercise, primary: list[str], secondary: list[str]) -> None:
    """Replaces the muscle map and records the change. Saving the muscles is
    also how a user confirms them, so it clears needs_review."""
    primary, secondary = check_muscles(primary, secondary)
    old = muscle_map(ex)
    new = {"primary": primary, "secondary": secondary}
    if old != new:
        session.add(MuscleMapChange(id=uuid7(), user_id=ex.user_id, exercise_id=ex.id, old_map=old, new_map=new))
        ex.primary_muscles, ex.secondary_muscles = primary, secondary
    ex.needs_review = False


def catalog_summary(entry: dict, score: float | None = None) -> dict:
    m = catalog.muscles_for(entry)
    role = ("primary" if "shoulders" in entry["primaryMuscles"]
            else "secondary" if "shoulders" in entry["secondaryMuscles"] else None)
    return {
        "id": entry["id"], "name": entry["name"], "category": entry.get("category"),
        "equipment": catalog.equipment_for(entry.get("equipment")),
        "logging_type": catalog.logging_type_for(entry),
        "primary_muscles": m.primary, "secondary_muscles": m.secondary, "shoulders": m.shoulders,
        "shoulders_role": role, **({"score": round(score, 3)} if score is not None else {}),
    }


def exercise_out(ex: UserExercise) -> dict:
    return {
        "id": str(ex.id), "name": ex.name, "catalog_id": ex.catalog_id, "equipment": ex.equipment,
        "logging_type": ex.logging_type, "primary_muscles": list(ex.primary_muscles),
        "secondary_muscles": list(ex.secondary_muscles), "needs_review": ex.needs_review,
        "archived": ex.archived,
    }
