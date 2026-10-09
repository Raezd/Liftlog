"""Workout history, read-only. Editing finished workouts comes later and
goes through workout_changes."""

import datetime as dt
import uuid

from fastapi import APIRouter, Query
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.models import Set, UserExercise, Workout, WorkoutExercise
from app.users import CurrentUser, DbSession, not_found

router = APIRouter(prefix="/api/workouts")


def _num(v):
    return None if v is None else format(v.normalize(), "f")


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
            "started_at": w.started_at.isoformat(), "ended_at": w.ended_at.isoformat() if w.ended_at else None,
            "source": w.source, "exercise_count": ne, "set_count": ns,
        } for w, ne, ns in rows[:limit]],
        "more": len(rows) > limit,
    }


@router.get("/{workout_id}")
def get_workout(workout_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    w = session.scalar(select(Workout).where(Workout.id == workout_id, Workout.user_id == user.id)
                       .options(selectinload(Workout.exercises).selectinload(WorkoutExercise.sets)))
    if w is None:
        raise not_found()
    # Display uses each exercise's current name; logged_name is what it was called then.
    names = dict(session.execute(select(UserExercise.id, UserExercise.name).where(
        UserExercise.id.in_([e.exercise_id for e in w.exercises]))).all())
    return {
        "id": str(w.id), "title": w.title, "workout_date": w.workout_date.isoformat(),
        "started_at": w.started_at.isoformat(), "ended_at": w.ended_at.isoformat() if w.ended_at else None,
        "notes": w.notes, "source": w.source,
        "exercises": [{
            "id": str(e.id), "exercise_id": str(e.exercise_id), "name": names.get(e.exercise_id, e.logged_name),
            "logged_name": e.logged_name, "position": e.position, "superset_group": e.superset_group,
            "notes": e.notes,
            "sets": [{
                "id": str(s.id), "position": s.position, "set_type": s.set_type,
                "weight_value": _num(s.weight_value), "weight_unit": s.weight_unit, "weight_kg": _num(s.weight_kg),
                "reps": s.reps, "rpe": _num(s.rpe), "duration_seconds": s.duration_seconds,
                "distance_value": _num(s.distance_value), "distance_unit": s.distance_unit,
                "distance_m": _num(s.distance_m),
            } for s in e.sets],
        } for e in w.exercises],
    }
