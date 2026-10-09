"""Hevy import: preview (parse and show what needs resolving), then import
(everything resolved, one transaction). The CSV is never stored."""

import json
import uuid

from fastapi import APIRouter, File, Form, UploadFile, status
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import hevy
from app.library import problem
from app.models import Import
from app.users import CurrentUser, DbSession, owned

router = APIRouter(prefix="/api/imports")

Resolutions = TypeAdapter(dict[str, hevy.Resolution])


async def _read(file: UploadFile) -> hevy.ParsedFile:
    content = await file.read(hevy.MAX_BYTES + 1)
    try:
        return hevy.parse(content)
    except hevy.FormatError as e:
        raise problem("bad_file", str(e) + ("\n" + "\n".join(e.problems) if e.problems else ""))


def import_out(r: Import) -> dict:
    return {
        "id": str(r.id), "source": r.source, "file_sha256": r.file_sha256, "created_at": r.created_at.isoformat(),
        "added": {"workouts": r.workouts_added, "sets": r.sets_added},
        "skipped": {"workouts": r.workouts_skipped, "sets": r.sets_skipped},
        "conflicting": {"workouts": r.workouts_conflicting, "sets": r.sets_conflicting},
    }


@router.post("/hevy/preview")
async def hevy_preview(user: CurrentUser, session: DbSession, file: UploadFile = File(...)) -> dict:
    parsed = await _read(file)
    return hevy.preview(session, user, parsed)


@router.post("/hevy", status_code=status.HTTP_201_CREATED)
async def hevy_import(user: CurrentUser, session: DbSession, file: UploadFile = File(...),
                      resolutions: str = Form("{}")) -> dict:
    parsed = await _read(file)
    try:
        chosen = Resolutions.validate_python(json.loads(resolutions))
    except (ValueError, ValidationError):
        raise problem("bad_resolutions", "Something went wrong with your choices. Start the import again.")
    try:
        record = hevy.run(session, user, parsed, chosen)
        session.commit()
    except IntegrityError:
        # Another import of the same workouts landed first. Nothing from this one was kept.
        session.rollback()
        raise problem("busy", "Another import just ran. Try again.", status.HTTP_409_CONFLICT)
    except Exception:
        session.rollback()
        raise
    session.refresh(record)
    return import_out(record)


@router.get("")
def list_imports(user: CurrentUser, session: DbSession) -> list[dict]:
    rows = session.scalars(select(Import).where(Import.user_id == user.id).order_by(Import.created_at.desc()))
    return [import_out(r) for r in rows]


@router.get("/{import_id}")
def get_import(import_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    return import_out(owned(session, Import, import_id, user))
