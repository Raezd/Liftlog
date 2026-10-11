"""Everything the phone keeps for offline use, in one request: the caller,
their exercises, folders and routines with each routine's current version,
their full workout history, and their plate math gear (seeded with the
presets on first use), and their body measurements (standard sites seeded on
first use). The phone refreshes its copy whenever it has a
connection. History is small (hundreds of sets a year), so it's never paged."""

from fastapi import APIRouter
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.body import body_out, ensure_sites
from app.gear import ensure_seeded, gear_out
from app.library import exercise_out
from app.models import Routine, RoutineExercise, RoutineVersion, User, UserExercise
from app.routers.me import me_out
from app.routers.routines import list_routines, version_out
from app.routers.workouts import full_workouts
from app.users import CurrentUser, DbSession

router = APIRouter(prefix="/api")


def current_versions(session: Session, user: User) -> dict[str, dict]:
    """Routine id -> its current version, with every exercise and set."""
    current = select(Routine.current_version_id).where(Routine.user_id == user.id)
    versions = session.scalars(select(RoutineVersion).where(RoutineVersion.id.in_(current)).options(
        selectinload(RoutineVersion.exercises).selectinload(RoutineExercise.sets)))
    return {str(v.routine_id): version_out(session, v) for v in versions}


@router.get("/offline")
def offline_copy(user: CurrentUser, session: DbSession) -> dict:
    ensure_seeded(session, user)
    ensure_sites(session, user)
    exercises = session.scalars(select(UserExercise).where(UserExercise.user_id == user.id)
                                .order_by(UserExercise.name))
    return {
        "me": me_out(user),
        "exercises": [exercise_out(e) for e in exercises],
        "routines": list_routines(user, session, archived=True),
        "versions": current_versions(session, user),
        "workouts": full_workouts(session, user),
        "gear": gear_out(session, user),
        "body": body_out(session, user),
    }
