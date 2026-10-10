"""Plate math gear: each user's bars, plate sets, and plates.

The first time a user opens gear (GET /api/gear) or the phone fetches its
offline copy, they get their own copies of the v1 presets: the bars in the
user's weight unit and all three plate sets. Their defaults become the Olympic
barbell and the Olympic plates in their unit. After that it's all theirs to
rename, change, and delete. The math itself runs on the phone
(frontend/app/src/lib/plates.ts).
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models import Bar, Plate, PlateSet, User, uuid7
from app.units import to_kg

# Name, lb, kg. From docs/v1-scope.md. Bar weights vary by maker, so these are starting points.
PRESET_BARS = (
    ("Olympic barbell", "45", "20"),
    ("Women's Olympic barbell", "35", "15"),
    ("Olympic EZ curl bar", "25", "10"),
    ("Hex or trap bar", "45", "20"),
    ("Standard 1-inch bar, 5 ft", "15", "7"),
)
PRESET_PLATES = (
    ("Olympic plates, lb", "lb", ("55", "45", "35", "25", "10", "5", "2.5", "1.25")),
    ("Olympic plates, kg", "kg", ("25", "20", "15", "10", "5", "2.5", "2", "1.5", "1.25", "1", "0.5")),
    ("Standard 1-inch plates, lb", "lb", ("50", "25", "10", "5", "2.5", "1.25")),
)


def num(v: Decimal) -> str:
    return format(v.normalize(), "f")


def plate_name(value: Decimal, unit: str) -> str:
    return f"{num(value)} {unit}"


def new_bar(user: User, name: str, value: Decimal, unit: str) -> Bar:
    return Bar(id=uuid7(), user_id=user.id, name=name, weight_value=value, weight_unit=unit,
               weight_kg=to_kg(value, unit))


def new_plate(user: User, set_id, value: Decimal, unit: str, name: str | None = None,
              pair_count: int | None = None) -> Plate:
    return Plate(id=uuid7(), user_id=user.id, plate_set_id=set_id, name=name or plate_name(value, unit),
                 weight_value=value, weight_unit=unit, weight_kg=to_kg(value, unit), enabled=True,
                 pair_count=pair_count)


def ensure_seeded(session: Session, user: User) -> None:
    """Copies the presets in once per user, and commits. Locks the user row
    so two first requests at once can't both seed."""
    if user.gear_seeded:
        return
    session.refresh(user, with_for_update=True)
    if user.gear_seeded:
        session.commit()
        return
    unit = user.weight_unit
    bars = [new_bar(user, name, Decimal(lb if unit == "lb" else kg), unit) for name, lb, kg in PRESET_BARS]
    session.add_all(bars)
    default_set = None
    for name, plate_unit, weights in PRESET_PLATES:
        ps = PlateSet(id=uuid7(), user_id=user.id, name=name)
        session.add(ps)
        session.flush()
        session.add_all(new_plate(user, ps.id, Decimal(w), plate_unit) for w in weights)
        if default_set is None and name.startswith("Olympic") and plate_unit == unit:
            default_set = ps
    session.flush()
    user.default_bar_id = bars[0].id
    user.default_plate_set_id = default_set.id
    user.gear_seeded = True
    session.commit()


def bar_out(b: Bar) -> dict:
    return {"id": str(b.id), "name": b.name, "weight_value": num(b.weight_value), "weight_unit": b.weight_unit,
            "weight_kg": num(b.weight_kg)}


def plate_out(p: Plate) -> dict:
    return {"id": str(p.id), "name": p.name, "weight_value": num(p.weight_value), "weight_unit": p.weight_unit,
            "weight_kg": num(p.weight_kg), "enabled": p.enabled, "pair_count": p.pair_count}


def gear_out(session: Session, user: User) -> dict:
    """Everything plate math needs, as the phone caches it."""
    bars = session.scalars(select(Bar).where(Bar.user_id == user.id).order_by(func.lower(Bar.name), Bar.id))
    sets = session.scalars(select(PlateSet).where(PlateSet.user_id == user.id)
                           .order_by(func.lower(PlateSet.name), PlateSet.id).options(selectinload(PlateSet.plates)))
    return {
        "default_bar_id": str(user.default_bar_id) if user.default_bar_id else None,
        "default_plate_set_id": str(user.default_plate_set_id) if user.default_plate_set_id else None,
        "bars": [bar_out(b) for b in bars],
        "plate_sets": [{"id": str(s.id), "name": s.name, "plates": [plate_out(p) for p in s.plates]} for s in sets],
    }
