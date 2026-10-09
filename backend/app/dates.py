"""Which workout date a moment belongs to. Foodlog's rule: the user's own
timezone, with days rolling over at 4:00 AM, so a 1 AM session counts toward
the day before. Stored on each workout when it's saved."""

import datetime as dt
from zoneinfo import ZoneInfo

ROLLOVER = dt.timedelta(hours=4)


def workout_date_for(moment: dt.datetime, timezone: str) -> dt.date:
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return (moment.astimezone(ZoneInfo(timezone)) - ROLLOVER).date()
