"""The caller: login and settings."""

from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.library import problem
from app.users import CurrentUser, DbSession

router = APIRouter(prefix="/api")


def me_out(user) -> dict:
    return {
        "login": user.login, "id": str(user.id), "display_name": user.display_name, "timezone": user.timezone,
        "weight_unit": user.weight_unit, "distance_unit": user.distance_unit,
        "play_through_silent": user.play_through_silent, "length_unit": user.length_unit,
    }


@router.get("/me")
def me(user: CurrentUser) -> dict:
    """The caller's Tailscale login, as checked by the auth middleware, and their settings."""
    return me_out(user)


class Settings(BaseModel):
    display_name: str | None = Field(None, max_length=60)
    timezone: str | None = Field(None, max_length=64)
    weight_unit: Literal["lb", "kg"] | None = None
    distance_unit: Literal["mi", "km"] | None = None
    play_through_silent: bool | None = None
    length_unit: Literal["in", "cm"] | None = None


@router.patch("/me")
def update_me(body: Settings, user: CurrentUser, session: DbSession) -> dict:
    if body.display_name is not None:
        name = " ".join(body.display_name.split())
        if not name:
            raise problem("name_required", "Enter a name.")
        user.display_name = name
    if body.timezone is not None:
        try:
            ZoneInfo(body.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise problem("bad_timezone", "Pick a timezone from the list.")
        user.timezone = body.timezone
    for f in ("weight_unit", "distance_unit", "play_through_silent", "length_unit"):
        if getattr(body, f) is not None:
            setattr(user, f, getattr(body, f))
    session.commit()
    return me_out(user)
