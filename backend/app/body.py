"""Body measurements: each user's sites, and check-ins holding a value per
site plus optional body fat.

The first time a user opens Body (GET /api/body), the phone fetches its
offline copy, or they export, they get the standard sites (STANDARD_SITES),
once. After that they add custom sites and rename or archive any of them. A
site with values can't be deleted, only archived.

Values keep what was typed and its unit, plus normalized cm. Changes over
time are computed on the phone (frontend/app/src/lib/body.ts).
"""

from __future__ import annotations

import datetime as dt
from decimal import ROUND_HALF_EVEN, Decimal

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, selectinload

from app.dates import workout_date_for
from app.library import problem
from app.models import MeasureCheckin, MeasureSite, MeasureValue, User, uuid7

# Name, paired. From docs/v1-scope.md, in the order the Body tab lists them.
STANDARD_SITES = (
    ("Waist", False), ("Chest", False), ("Hips", False), ("Neck", False),
    ("Arms", True), ("Forearms", True), ("Thighs", True), ("Calves", True),
)

# Exact by definition (1959).
CM_PER = {"cm": Decimal(1), "in": Decimal("2.54")}
MIN_CM, MAX_CM = Decimal(1), Decimal(300)
BODY_FAT_METHODS = ("calipers", "smart_scale", "dexa", "navy_tape", "visual", "other")


def to_cm(value: Decimal, unit: str) -> Decimal:
    return (value * CM_PER[unit]).quantize(Decimal("0.0001"), ROUND_HALF_EVEN)


def num(v: Decimal | None) -> str | None:
    return None if v is None else format(v.normalize(), "f")


def today_for(user: User) -> dt.date:
    """Today by the user's timezone and the 4 AM rollover, like workouts."""
    return workout_date_for(dt.datetime.now(dt.timezone.utc), user.timezone)


def ensure_sites(session: Session, user: User) -> None:
    """Copies the standard sites in once per user, and commits. Locks the
    user row so two first requests at once can't both seed."""
    if user.body_seeded:
        return
    session.refresh(user, with_for_update=True)
    if not user.body_seeded:
        taken = {n.lower() for n in session.scalars(select(MeasureSite.name).where(MeasureSite.user_id == user.id))}
        start = session.scalar(select(func.coalesce(func.max(MeasureSite.position) + 1, 0))
                               .where(MeasureSite.user_id == user.id))
        session.add_all(MeasureSite(id=uuid7(), user_id=user.id, name=name, paired=paired, position=start + i)
                        for i, (name, paired) in enumerate(STANDARD_SITES) if name.lower() not in taken)
        user.body_seeded = True
    session.commit()


def site_label(site: MeasureSite, side: str | None) -> str:
    return f"{site.name}, {side}" if side else site.name


def check_value(label: str, value: Decimal, unit: str) -> Decimal:
    """The value as it will be stored, or a 422 naming the site."""
    if not value.is_finite():
        raise problem("bad_value", f"{label}: enter a number.")
    if value.normalize().as_tuple().exponent < -2:
        raise problem("bad_value", f"{label}: use at most two decimal places.")
    if not MIN_CM <= to_cm(value, unit) <= MAX_CM:
        low, high = ("1", "300") if unit == "cm" else ("0.4", "118.11")
        raise problem("bad_value", f"{label}: {num(value)} {unit} is out of range. Enter {low} to {high} {unit}.")
    return value.normalize()


def check_body_fat(pct: Decimal | None, method: str | None) -> tuple[Decimal | None, str | None]:
    if pct is None:
        if method is not None:
            raise problem("bad_body_fat", "Enter a body fat percentage, or clear the method.")
        return None, None
    if not pct.is_finite() or not Decimal(1) <= pct <= Decimal(75):
        raise problem("bad_body_fat", "Body fat should be 1 to 75 percent.")
    if pct.normalize().as_tuple().exponent < -2:
        raise problem("bad_body_fat", "Body fat: use at most two decimal places.")
    if method is None:
        raise problem("bad_body_fat", "Pick how body fat was measured.")
    if method not in BODY_FAT_METHODS:
        raise problem("bad_body_fat", "Pick how body fat was measured from the list.")
    return pct.normalize(), method


def check_date(user: User, date: dt.date | None) -> dt.date:
    today = today_for(user)
    if date is None:
        return today
    if date > today:
        raise problem("bad_date", "A check-in can't be in the future.")
    return date


def site_has_values(session: Session, site_id) -> bool:
    return bool(session.scalar(select(exists().where(MeasureValue.site_id == site_id))))


def site_out(s: MeasureSite, used: set) -> dict:
    return {"id": str(s.id), "name": s.name, "paired": s.paired, "archived": s.archived, "position": s.position,
            "has_values": s.id in used}


def value_out(v: MeasureValue) -> dict:
    return {"id": str(v.id), "site_id": str(v.site_id), "side": v.side, "value": num(v.value), "unit": v.unit,
            "value_cm": num(v.value_cm)}


def checkin_out(c: MeasureCheckin) -> dict:
    return {"id": str(c.id), "date": c.date.isoformat(), "body_fat_pct": num(c.body_fat_pct),
            "body_fat_method": c.body_fat_method, "notes": c.notes, "created_at": c.created_at.isoformat(),
            "values": [value_out(v) for v in c.values]}


def body_out(session: Session, user: User) -> dict:
    """Every site (archived too) and every check-in, newest first, as the phone caches it."""
    sites = session.scalars(select(MeasureSite).where(MeasureSite.user_id == user.id)
                            .order_by(MeasureSite.position, MeasureSite.id)).all()
    checkins = session.scalars(select(MeasureCheckin).where(MeasureCheckin.user_id == user.id)
                               .order_by(MeasureCheckin.date.desc()).options(selectinload(MeasureCheckin.values))).all()
    used = {v.site_id for c in checkins for v in c.values}
    return {
        "length_unit": user.length_unit,
        "sites": [site_out(s, used) for s in sites],
        "checkins": [checkin_out(c) for c in checkins],
    }
