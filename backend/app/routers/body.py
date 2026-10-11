"""Body measurements (the Body tab): sites, check-ins, and their values.
Changes need a connection; the phone reads its cached copy to show them
offline. Every change answers with the caller's whole body doc
(app/body.py, body_out), so the pages and the copy stay simple.

- A check-in is one date (today by default, never in the future) with any
  subset of sites, optional body fat with its method, and notes. One per
  user per date: POST on a date that has one adds to it, and a site (and
  side) entered again replaces its value there. PUT replaces a check-in's
  whole content.
- A bad value is a 422 naming the site, and nothing is written.
- Another user's site or check-in is 404.
"""

import datetime as dt
import uuid
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.body import (
    body_out, check_body_fat, check_date, check_value, ensure_sites, site_has_values, site_label, to_cm,
)
from app.library import problem
from app.models import MeasureCheckin, MeasureSite, MeasureValue, User, uuid7
from app.users import CurrentUser, DbSession, owned

router = APIRouter(prefix="/api/body")


@router.get("")
def get_body(user: CurrentUser, session: DbSession) -> dict:
    ensure_sites(session, user)
    return body_out(session, user)


# ---------- sites ----------

def check_site_name(session, user: User, name: str, site_id: uuid.UUID | None = None) -> str:
    name = " ".join(name.split())
    if not name:
        raise problem("name_required", "Give the site a name.")
    clash = session.scalar(select(MeasureSite.id).where(
        MeasureSite.user_id == user.id, func.lower(MeasureSite.name) == name.lower()))
    if clash is not None and clash != site_id:
        raise problem("name_taken", f"You already have a site named {name}.", status.HTTP_409_CONFLICT)
    return name


class SiteIn(BaseModel):
    name: str = Field(max_length=60)
    paired: bool


class SiteEdit(BaseModel):
    name: str | None = Field(None, max_length=60)
    archived: bool | None = None


@router.post("/sites", status_code=status.HTTP_201_CREATED)
def add_site(body: SiteIn, user: CurrentUser, session: DbSession) -> dict:
    ensure_sites(session, user)
    name = check_site_name(session, user, body.name)
    position = session.scalar(select(func.coalesce(func.max(MeasureSite.position) + 1, 0))
                              .where(MeasureSite.user_id == user.id))
    session.add(MeasureSite(id=uuid7(), user_id=user.id, name=name, paired=body.paired, position=position))
    session.commit()
    return body_out(session, user)


@router.patch("/sites/{site_id}")
def edit_site(site_id: uuid.UUID, body: SiteEdit, user: CurrentUser, session: DbSession) -> dict:
    site = owned(session, MeasureSite, site_id, user)
    if body.name is not None:
        site.name = check_site_name(session, user, body.name, site.id)
    if body.archived is not None:
        site.archived = body.archived
    session.commit()
    return body_out(session, user)


@router.delete("/sites/{site_id}")
def delete_site(site_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    """Only a site with no values. One with values can be archived instead (RESTRICT in Postgres too)."""
    site = owned(session, MeasureSite, site_id, user)
    if site_has_values(session, site.id):
        raise problem("in_use", f"{site.name} has measurements, so it can only be archived.", status.HTTP_409_CONFLICT)
    session.delete(site)
    session.commit()
    return body_out(session, user)


# ---------- check-ins ----------

class ValueIn(BaseModel):
    site_id: uuid.UUID
    side: Literal["left", "right"] | None = None
    value: Decimal
    unit: Literal["in", "cm"]


class CheckinIn(BaseModel):
    date: dt.date | None = None
    body_fat_pct: Decimal | None = None
    body_fat_method: str | None = None
    notes: str | None = Field(None, max_length=2000)
    values: list[ValueIn] = Field(default_factory=list, max_length=100)


def checked_values(session, user: User, values: list[ValueIn]) -> list[MeasureValue]:
    """Every value checked against its site, before anything is written."""
    out, seen = [], set()
    for v in values:
        site = owned(session, MeasureSite, v.site_id, user)
        label = site_label(site, v.side)
        if site.paired and v.side is None:
            raise problem("bad_value", f"{site.name}: pick left or right.")
        if not site.paired and v.side is not None:
            raise problem("bad_value", f"{site.name} doesn't have sides.")
        if (site.id, v.side) in seen:
            raise problem("bad_value", f"{label} is in this check-in twice.")
        seen.add((site.id, v.side))
        value = check_value(label, v.value, v.unit)
        out.append(MeasureValue(id=uuid7(), site_id=site.id, side=v.side, value=value, unit=v.unit,
                                value_cm=to_cm(value, v.unit)))
    return out


def lock(session, user: User) -> None:
    """One check-in write at a time per user, so two saves can't both make a date."""
    session.refresh(user, with_for_update=True)


def on_date(session, user: User, date: dt.date) -> MeasureCheckin | None:
    return session.scalar(select(MeasureCheckin).where(MeasureCheckin.user_id == user.id, MeasureCheckin.date == date))


def must_hold_something(values: list, pct) -> None:
    if not values and pct is None:
        raise problem("empty_checkin", "Enter at least one measurement or body fat.")


@router.post("/checkins")
def add_checkin(body: CheckinIn, response: Response, user: CurrentUser, session: DbSession) -> dict:
    """A new check-in, or more for the one already on that date."""
    date = check_date(user, body.date)
    pct, method = check_body_fat(body.body_fat_pct, body.body_fat_method)
    values = checked_values(session, user, body.values)
    must_hold_something(values, pct)
    lock(session, user)
    c = on_date(session, user, date)
    if c is None:
        c = MeasureCheckin(id=uuid7(), user_id=user.id, date=date, notes=(body.notes or "").strip())
        session.add(c)
        response.status_code = status.HTTP_201_CREATED
    elif body.notes is not None and body.notes.strip():
        c.notes = body.notes.strip()
    if pct is not None:
        c.body_fat_pct, c.body_fat_method = pct, method
    # Entering a site again on this date replaces its value.
    replaced = {(v.site_id, v.side) for v in values}
    c.values = [v for v in c.values if (v.site_id, v.side) not in replaced]
    session.flush()
    c.values.extend(values)
    session.commit()
    return body_out(session, user)


@router.put("/checkins/{checkin_id}")
def replace_checkin(checkin_id: uuid.UUID, body: CheckinIn, user: CurrentUser, session: DbSession) -> dict:
    """The check-in's whole content: date, body fat, notes, and every value."""
    c = owned(session, MeasureCheckin, checkin_id, user)
    date = check_date(user, body.date or c.date)
    pct, method = check_body_fat(body.body_fat_pct, body.body_fat_method)
    values = checked_values(session, user, body.values)
    must_hold_something(values, pct)
    lock(session, user)
    other = on_date(session, user, date)
    if other is not None and other.id != c.id:
        raise problem("date_taken", "There's already a check-in on that date. Open it to add to it.",
                      status.HTTP_409_CONFLICT)
    c.date, c.body_fat_pct, c.body_fat_method, c.notes = date, pct, method, (body.notes or "").strip()
    c.values = []
    session.flush()
    c.values.extend(values)
    session.commit()
    return body_out(session, user)


@router.delete("/checkins/{checkin_id}")
def delete_checkin(checkin_id: uuid.UUID, user: CurrentUser, session: DbSession) -> dict:
    session.delete(owned(session, MeasureCheckin, checkin_id, user))
    session.commit()
    return body_out(session, user)
