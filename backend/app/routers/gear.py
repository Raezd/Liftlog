"""Bars, plate sets, and plates (Settings, Bars and plates). Editing needs a
connection; the phone reads its cached copy for plate math. Every change
answers with the caller's whole gear, so the page and the copy stay simple."""

import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, status
from pydantic import BaseModel, Field

from app.gear import ensure_seeded, gear_out, new_bar, new_plate, plate_name
from app.library import problem
from app.models import Bar, Plate, PlateSet
from app.units import to_kg
from app.users import CurrentUser, DbSession, owned

router = APIRouter(prefix="/api/gear")


def check_name(name: str, what: str) -> str:
    name = " ".join(name.split())
    if not name:
        raise problem("name_required", f"Give the {what} a name.")
    return name


def check_weight(v: Decimal, zero_ok: bool) -> Decimal:
    if not v.is_finite() or v < 0 or (v == 0 and not zero_ok) or v > 2000:
        raise problem("bad_weight", "Enter a weight from 0 to 2,000." if zero_ok else "Enter a weight above 0.")
    # At most hundredths, so plate math (frontend lib/plates.ts) stays in whole hundredths.
    if v.normalize().as_tuple().exponent < -2:
        raise problem("bad_weight", "Use at most two decimal places.")
    return v.normalize() if v != 0 else Decimal(0)


def check_pairs(n: int | None) -> int | None:
    if n is not None and not 1 <= n <= 99:
        raise problem("bad_pairs", "Pairs should be 1 to 99, or unlimited.")
    return n


@router.get("")
def get_gear(user: CurrentUser, session: DbSession) -> dict:
    ensure_seeded(session, user)
    return gear_out(session, user)


class Defaults(BaseModel):
    bar_id: uuid.UUID | None = None
    plate_set_id: uuid.UUID | None = None


@router.patch("/defaults")
def set_defaults(body: Defaults, user: CurrentUser, session: DbSession) -> dict:
    ensure_seeded(session, user)
    if body.bar_id is not None:
        user.default_bar_id = owned(session, Bar, body.bar_id, user).id
    if body.plate_set_id is not None:
        user.default_plate_set_id = owned(session, PlateSet, body.plate_set_id, user).id
    session.commit()
    return gear_out(session, user)


# ---------- bars ----------

class BarIn(BaseModel):
    name: str = Field(max_length=80)
    weight_value: Decimal
    weight_unit: Literal["lb", "kg"]


class BarEdit(BaseModel):
    name: str | None = Field(None, max_length=80)
    weight_value: Decimal | None = None
    weight_unit: Literal["lb", "kg"] | None = None


@router.post("/bars", status_code=status.HTTP_201_CREATED)
def add_bar(body: BarIn, user: CurrentUser, session: DbSession) -> dict:
    ensure_seeded(session, user)
    session.add(new_bar(user, check_name(body.name, "bar"), check_weight(body.weight_value, True), body.weight_unit))
    session.commit()
    return gear_out(session, user)


@router.patch("/bars/{bar_id}")
def edit_bar(bar_id: uuid.UUID, body: BarEdit, user: CurrentUser, session: DbSession) -> dict:
    bar = owned(session, Bar, bar_id, user)
    if body.name is not None:
        bar.name = check_name(body.name, "bar")
    if body.weight_value is not None or body.weight_unit is not None:
        bar.weight_value = check_weight(body.weight_value if body.weight_value is not None else bar.weight_value, True)
        bar.weight_unit = body.weight_unit or bar.weight_unit
        bar.weight_kg = to_kg(bar.weight_value, bar.weight_unit)
    session.commit()
    return gear_out(session, user)


@router.delete("/bars/{bar_id}")
def delete_bar(bar_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    """Exercises that used it go back to the default (ON DELETE SET NULL)."""
    bar = owned(session, Bar, bar_id, user)
    if user.default_bar_id == bar.id:
        raise problem("is_default", "This is your default bar. Pick another default first.", status.HTTP_409_CONFLICT)
    session.delete(bar)
    session.commit()
    return gear_out(session, user)


# ---------- plate sets ----------

class SetIn(BaseModel):
    name: str = Field(max_length=80)


@router.post("/plate-sets", status_code=status.HTTP_201_CREATED)
def add_plate_set(body: SetIn, user: CurrentUser, session: DbSession) -> dict:
    ensure_seeded(session, user)
    session.add(PlateSet(user_id=user.id, name=check_name(body.name, "plate set")))
    session.commit()
    return gear_out(session, user)


@router.patch("/plate-sets/{set_id}")
def rename_plate_set(set_id: uuid.UUID, body: SetIn, user: CurrentUser, session: DbSession) -> dict:
    owned(session, PlateSet, set_id, user).name = check_name(body.name, "plate set")
    session.commit()
    return gear_out(session, user)


@router.delete("/plate-sets/{set_id}")
def delete_plate_set(set_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    """Deletes its plates too. Exercises that used it go back to the default."""
    ps = owned(session, PlateSet, set_id, user)
    if user.default_plate_set_id == ps.id:
        raise problem("is_default", "This is your default plate set. Pick another default first.",
                      status.HTTP_409_CONFLICT)
    session.delete(ps)
    session.commit()
    return gear_out(session, user)


# ---------- plates ----------

class PlateIn(BaseModel):
    name: str | None = Field(None, max_length=80)
    weight_value: Decimal
    weight_unit: Literal["lb", "kg"]
    pair_count: int | None = None


class PlateEdit(BaseModel):
    name: str | None = Field(None, max_length=80)
    weight_value: Decimal | None = None
    weight_unit: Literal["lb", "kg"] | None = None
    enabled: bool | None = None
    # Send null for unlimited. Leave it out to keep it.
    pair_count: int | None = None


@router.post("/plate-sets/{set_id}/plates", status_code=status.HTTP_201_CREATED)
def add_plate(set_id: uuid.UUID, body: PlateIn, user: CurrentUser, session: DbSession) -> dict:
    ps = owned(session, PlateSet, set_id, user)
    value = check_weight(body.weight_value, False)
    name = check_name(body.name, "plate") if body.name and body.name.strip() else None
    session.add(new_plate(user, ps.id, value, body.weight_unit, name, check_pairs(body.pair_count)))
    session.commit()
    return gear_out(session, user)


@router.patch("/plates/{plate_id}")
def edit_plate(plate_id: uuid.UUID, body: PlateEdit, user: CurrentUser, session: DbSession) -> dict:
    p = owned(session, Plate, plate_id, user)
    if body.weight_value is not None or body.weight_unit is not None:
        # A plate still named after its weight follows the new weight.
        auto = p.name == plate_name(p.weight_value, p.weight_unit)
        p.weight_value = check_weight(body.weight_value if body.weight_value is not None else p.weight_value, False)
        p.weight_unit = body.weight_unit or p.weight_unit
        p.weight_kg = to_kg(p.weight_value, p.weight_unit)
        if auto and body.name is None:
            p.name = plate_name(p.weight_value, p.weight_unit)
    if body.name is not None:
        p.name = check_name(body.name, "plate") if body.name.strip() else plate_name(p.weight_value, p.weight_unit)
    if body.enabled is not None:
        p.enabled = body.enabled
    if "pair_count" in body.model_fields_set:
        p.pair_count = check_pairs(body.pair_count)
    session.commit()
    return gear_out(session, user)


@router.delete("/plates/{plate_id}")
def delete_plate(plate_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    session.delete(owned(session, Plate, plate_id, user))
    session.commit()
    return gear_out(session, user)


def check_exercise_gear(session, user, bar_id: uuid.UUID | None, plate_set_id: uuid.UUID | None) -> None:
    """An exercise can only point at the caller's own gear (404 otherwise)."""
    if bar_id is not None:
        owned(session, Bar, bar_id, user)
    if plate_set_id is not None:
        owned(session, PlateSet, plate_set_id, user)

