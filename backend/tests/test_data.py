"""Rules that need the database: user isolation, import dedupe, exact
weights, and the muscle-map change log."""

import json
from decimal import Decimal
from pathlib import Path

from sqlalchemy import select

from app.db import get_sessionmaker
from app.models import MuscleMapChange, Set, Workout
from conftest import PARTNER, TRAV

SAMPLE = (Path(__file__).parent / "fixtures" / "hevy-sample.csv").read_bytes()


def resolve_all(client, headers, csv=SAMPLE):
    """Preview, then import with the top catalog match (or a custom exercise) for each title."""
    p = client.post("/api/imports/hevy/preview", headers=headers, files={"file": ("w.csv", csv)}).json()
    res = {}
    for t in p["titles"]:
        if t["mapped_to"]:
            continue
        s = t["suggestions"]
        res[t["title"]] = ({"action": "catalog", "catalog_id": s[0]["id"]} if s else
                           {"action": "custom", "name": t["title"], "equipment": t["equipment"],
                            "logging_type": t["logging_type"]})
    return p, res


def do_import(client, headers, res, csv=SAMPLE):
    return client.post("/api/imports/hevy", headers=headers, files={"file": ("w.csv", csv)},
                       data={"resolutions": json.dumps(res)})


def test_user_b_gets_404_on_user_a_objects(client, db):
    _, res = resolve_all(client, TRAV)
    imp = do_import(client, TRAV, res)
    assert imp.status_code == 201
    workout = client.get("/api/workouts", headers=TRAV).json()["workouts"][0]
    exercise = client.get("/api/exercises", headers=TRAV).json()[0]

    for path in (f"/api/exercises/{exercise['id']}", f"/api/workouts/{workout['id']}",
                 f"/api/imports/{imp.json()['id']}"):
        assert client.get(path, headers=TRAV).status_code == 200
        assert client.get(path, headers=PARTNER).status_code == 404
    assert client.patch(f"/api/exercises/{exercise['id']}", headers=PARTNER,
                        json={"name": "Mine now"}).status_code == 404
    # Lists show nothing of A's, and the import can't use A's exercise either.
    assert client.get("/api/exercises", headers=PARTNER).json() == []
    assert client.get("/api/workouts", headers=PARTNER).json()["workouts"] == []
    assert client.get("/api/imports", headers=PARTNER).json() == []
    _, res_b = resolve_all(client, PARTNER)
    title = next(iter(res_b))
    res_b[title] = {"action": "existing", "exercise_id": exercise["id"]}
    assert do_import(client, PARTNER, res_b).status_code == 404
    # A client-chosen id that's A's can't be taken over by B.
    r = client.post("/api/exercises", headers=PARTNER, json={
        "id": exercise["id"], "name": "Sneaky", "equipment": "other", "logging_type": "weight_reps"})
    assert r.status_code == 409
    assert client.get(f"/api/exercises/{exercise['id']}", headers=TRAV).json()["name"] == exercise["name"]


def test_reimporting_the_same_file_adds_nothing(client, db):
    p, res = resolve_all(client, TRAV)
    assert p["new"] == {"workouts": 2, "sets": 8}
    first = do_import(client, TRAV, res).json()
    assert first["added"] == {"workouts": 2, "sets": 8}

    p2, res2 = resolve_all(client, TRAV)
    assert p2["unresolved"] == 0 and res2 == {}  # every title remembered: no questions
    second = do_import(client, TRAV, {}).json()
    assert second["added"] == {"workouts": 0, "sets": 0}
    assert second["skipped"] == {"workouts": 2, "sets": 8}
    assert second["conflicting"] == {"workouts": 0, "sets": 0}
    with get_sessionmaker()() as s:
        assert len(s.scalars(select(Workout)).all()) == 2
        assert len(s.scalars(select(Set)).all()) == 8


def test_changed_workout_is_a_conflict_and_never_overwritten(client, db):
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    changed = SAMPLE.replace(b'"normal",50,15', b'"normal",55,15')
    r = do_import(client, TRAV, {}, changed).json()
    assert r["added"]["workouts"] == 0 and r["conflicting"] == {"workouts": 1, "sets": 7}
    with get_sessionmaker()() as s:
        assert Decimal("55") not in s.scalars(select(Set.weight_value)).all()


def test_import_is_atomic_until_every_title_is_resolved(client, db):
    _, res = resolve_all(client, TRAV)
    res.pop(next(iter(res)))
    r = do_import(client, TRAV, res)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unresolved"
    assert client.get("/api/exercises", headers=TRAV).json() == []
    assert client.get("/api/workouts", headers=TRAV).json()["workouts"] == []


def test_lb_entered_value_is_kept_exactly(client, db):
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    with get_sessionmaker()() as s:
        row = s.scalars(select(Set).where(Set.weight_value == Decimal("137.5"))).first()
    assert (row.weight_value, row.weight_unit, row.weight_kg) == (Decimal("137.5"), "lb", Decimal("62.3690"))
    w = client.get("/api/workouts", headers=TRAV).json()["workouts"]
    push = client.get(f"/api/workouts/{w[-1]['id']}", headers=TRAV).json()
    s = push["exercises"][0]["sets"][1]
    assert (s["weight_value"], s["weight_unit"], s["rpe"]) == ("137.5", "lb", "8.5")


def test_import_uses_local_time_and_4am_rule(client, db):
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    late = client.get("/api/workouts", headers=TRAV).json()["workouts"][0]
    assert late["title"] == "Late night"
    assert late["started_at"] == "2026-10-05T08:30:00+00:00"  # 1:30 AM PDT
    assert late["workout_date"] == "2026-10-04"


def test_muscle_map_change_log(client, db):
    ex = client.post("/api/exercises", headers=TRAV, json={"catalog_id": "Side_Lateral_Raise"}).json()
    assert ex["needs_review"] is True and ex["primary_muscles"] == ["side_delts"]

    r = client.patch(f"/api/exercises/{ex['id']}", headers=TRAV,
                     json={"primary_muscles": ["side_delts"], "secondary_muscles": ["traps"]})
    assert r.status_code == 200
    body = r.json()
    assert body["needs_review"] is False
    assert len(body["muscle_history"]) == 1
    h = body["muscle_history"][0]
    assert h["old"] == {"primary": ["side_delts"], "secondary": []}
    assert h["new"] == {"primary": ["side_delts"], "secondary": ["traps"]}
    assert h["changed_at"]

    # Confirming without a change clears review but writes no row; renaming writes none either.
    client.patch(f"/api/exercises/{ex['id']}", headers=TRAV,
                 json={"primary_muscles": ["side_delts"], "secondary_muscles": ["traps"], "name": "Lateral raise"})
    with get_sessionmaker()() as s:
        assert len(s.scalars(select(MuscleMapChange)).all()) == 1
    assert client.patch(f"/api/exercises/{ex['id']}", headers=TRAV,
                        json={"primary_muscles": ["shoulders"], "secondary_muscles": []}).status_code == 422
