"""Pure rules: the workout date, unit normalization, and set type mapping."""

import datetime as dt
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from app import hevy
from app.dates import workout_date_for
from app.units import to_kg, to_m

LA = "America/Los_Angeles"


def local(*args, fold=0):
    return dt.datetime(*args, tzinfo=ZoneInfo(LA), fold=fold)


@pytest.mark.parametrize("moment, expected", [
    (local(2026, 10, 9, 18, 0), dt.date(2026, 10, 9)),
    (local(2026, 10, 10, 3, 59), dt.date(2026, 10, 9)),   # before 4 AM: the day before
    (local(2026, 10, 10, 4, 0), dt.date(2026, 10, 10)),
    # DST ends Nov 1, 2026: 1:00 to 1:59 happens twice. Both count as Oct 31.
    (local(2026, 11, 1, 1, 30, fold=0), dt.date(2026, 10, 31)),
    (local(2026, 11, 1, 1, 30, fold=1), dt.date(2026, 10, 31)),
    (local(2026, 11, 1, 3, 59), dt.date(2026, 10, 31)),
    (local(2026, 11, 1, 4, 0), dt.date(2026, 11, 1)),
    # DST starts Mar 8, 2026: 2:00 to 2:59 never happens. 4 AM is still the line.
    (local(2026, 3, 8, 3, 59), dt.date(2026, 3, 7)),
    (local(2026, 3, 8, 4, 0), dt.date(2026, 3, 8)),
])
def test_workout_date_4am_rollover(moment, expected):
    assert workout_date_for(moment, LA) == expected


def test_workout_date_uses_the_users_timezone_not_utc():
    # 11:30 UTC on Nov 1 is 3:30 AM in Los Angeles (after fall back): still Oct 31.
    assert workout_date_for(dt.datetime(2026, 11, 1, 11, 30, tzinfo=dt.UTC), LA) == dt.date(2026, 10, 31)
    assert workout_date_for(dt.datetime(2026, 11, 1, 12, 0, tzinfo=dt.UTC), LA) == dt.date(2026, 11, 1)
    assert workout_date_for(dt.datetime(2026, 11, 1, 12, 0, tzinfo=dt.UTC), "Europe/London") == dt.date(2026, 11, 1)


def test_workout_date_rejects_naive_times():
    with pytest.raises(ValueError):
        workout_date_for(dt.datetime(2026, 10, 9, 18, 0), LA)


def test_unit_normalization():
    assert to_kg(Decimal("137.5"), "lb") == Decimal("62.3690")
    assert to_kg(Decimal("100"), "kg") == Decimal("100.0000")
    assert to_kg(Decimal("45"), "lb") == Decimal("20.4117")
    assert to_m(Decimal("1.06"), "mi") == Decimal("1705.905")


@pytest.mark.parametrize("hevy_type, ours", [
    ("normal", "normal"), ("warmup", "warmup"), ("dropset", "drop"), ("failure", "failure"), ("Warmup", "warmup"),
])
def test_set_type_mapping(hevy_type, ours):
    assert hevy.map_set_type(hevy_type) == ours


def test_unknown_set_type_rejects_the_file():
    with pytest.raises(ValueError):
        hevy.map_set_type("superset")
    bad = open(__file__.replace("test_rules.py", "fixtures/hevy-sample.csv"), "rb").read().replace(b'"dropset"', b'"mystery"')
    with pytest.raises(hevy.FormatError) as e:
        hevy.parse(bad)
    assert "mystery" in e.value.problems[0]


def test_sample_parses_into_blocks():
    p = hevy.parse(open(__file__.replace("test_rules.py", "fixtures/hevy-sample.csv"), "rb").read())
    assert p.weight_unit == "lb" and p.distance_unit == "mi" and p.rows == 8
    push = p.workouts[0]
    assert [b.title for b in push.blocks] == [
        "Bench Press (Barbell)", "Lateral Raise (Dumbbell)", "Triceps Extension (Machine)", "Treadmill"]
    assert [s.set_type for s in push.blocks[0].sets] == ["warmup", "normal", "failure"]
    assert [s.set_type for s in push.blocks[1].sets] == ["normal", "drop"]
    assert [b.superset_group for b in push.blocks] == [None, 0, 0, None]
    assert push.blocks[0].sets[1].rpe == Decimal("8.5")
    assert push.notes == "Felt strong"
    assert p.workouts[1].blocks[0].notes == "Line one\nline two"
