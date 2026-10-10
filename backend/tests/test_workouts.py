"""Workout upload and immutability: the PUT is idempotent (same content is a
no-op, different content is 409, another user's id is 404), workout_date
comes from started_at at upload with the 4 AM rule, finished workouts can't
be changed in Postgres except through edit_finished_workout(), which writes
the change log, and a Hevy re-import still works with the triggers on."""

import datetime as dt
import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.db import get_sessionmaker
from app.models import uuid7
from conftest import PARTNER, TRAV
from test_data import SAMPLE, do_import, resolve_all


def bench(client, headers=TRAV):
    return client.post("/api/exercises", headers=headers, json={"catalog_id": "Barbell_Bench_Press_-_Medium_Grip"}).json()


def payload(exercise_id, *, started="2026-10-09T17:00:00Z", reps=5, version=None, title="Push"):
    """A finished workout as the phone sends it, with fresh ids."""
    return {
        "title": title, "notes": "", "started_at": started,
        "ended_at": (dt.datetime.fromisoformat(started) + dt.timedelta(hours=1)).isoformat(),
        "routine_version_id": version,
        "exercises": [{
            "id": str(uuid7()), "exercise_id": exercise_id, "superset_group": None, "notes": "", "rest_seconds": 150,
            "sets": [
                {"id": str(uuid7()), "set_type": "warmup", "weight_value": "95", "weight_unit": "lb", "reps": 8,
                 "completed_at": started},
                {"id": str(uuid7()), "set_type": "normal", "weight_value": "137.5", "weight_unit": "lb", "reps": reps,
                 "rpe": "8.5", "completed_at": started},
            ],
        }],
    }


def upload(client, body, headers=TRAV, id=None):
    wid = id or str(uuid7())
    return wid, client.put(f"/api/workouts/{wid}", headers=headers, json=body)


def counts():
    with get_sessionmaker()() as s:
        return tuple(s.execute(text(f"SELECT count(*) FROM {t}")).scalar_one()
                     for t in ("workouts", "workout_exercises", "sets"))


def test_upload_is_idempotent_and_never_overwrites(client, db):
    ex = bench(client)
    body = payload(ex["id"])
    wid, first = upload(client, body)
    assert first.status_code == 201
    w = first.json()
    assert (w["source"], w["routine_version_id"]) == ("liftlog", None)
    assert [s["weight_value"] for s in w["exercises"][0]["sets"]] == ["95", "137.5"]
    assert w["exercises"][0]["rest_seconds"] == 150
    assert counts() == (1, 1, 2)

    # The same upload again (a retry): success, nothing changes.
    _, again = upload(client, body, id=wid)
    assert again.status_code == 200 and again.json() == w
    assert counts() == (1, 1, 2)

    # Different content under the same id: 409, and the stored workout stays.
    changed = json.loads(json.dumps(body))
    changed["exercises"][0]["sets"][1]["reps"] = 6
    _, conflict = upload(client, changed, id=wid)
    assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "workout_conflict"
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json() == w
    assert counts() == (1, 1, 2)

    # Someone else's id is a 404, whatever the content, and nothing of hers lands.
    her = bench(client, PARTNER)
    for b in (body, payload(her["id"])):
        assert upload(client, b, PARTNER, id=wid)[1].status_code == 404
    assert client.get(f"/api/workouts/{wid}", headers=PARTNER).status_code == 404
    assert counts() == (1, 1, 2)
    # Nor can she log his exercise, or reuse his set ids under a new workout.
    assert upload(client, payload(ex["id"]), PARTNER)[1].status_code == 404
    taken = payload(her["id"])
    taken["exercises"][0]["sets"][0]["id"] = body["exercises"][0]["sets"][0]["id"]
    assert upload(client, taken, PARTNER)[1].status_code == 409
    assert client.get("/api/workouts", headers=PARTNER).json()["workouts"] == []


def test_a_retry_with_trailing_zero_lb_and_microsecond_times_is_still_the_same(client, db):
    """The server stores 137.5 and microseconds as it normalizes them; a lost
    response's retry still matches, because the comparison is upload to upload."""
    ex = bench(client)
    body = payload(ex["id"], started="2026-10-09T17:00:00.123456Z")
    body["ended_at"] = "2026-10-09T18:00:00.987654+00:00"
    body["exercises"][0]["sets"][1]["weight_value"] = "137.50"
    body["exercises"][0]["sets"][1]["completed_at"] = "2026-10-09T17:20:31.000789Z"
    wid, first = upload(client, body)
    assert first.status_code == 201
    stored = first.json()["exercises"][0]["sets"][1]
    assert (stored["weight_value"], stored["weight_kg"]) == ("137.5", "62.369")
    for _ in range(3):
        assert upload(client, body, id=wid)[1].status_code == 200
    assert counts() == (1, 1, 2)


@pytest.mark.parametrize("started, expected", [
    ("2026-10-10T10:30:00+00:00", "2026-10-09"),   # 3:30 AM in Los Angeles: the day before
    ("2026-10-10T11:00:00+00:00", "2026-10-10"),   # 4:00 AM
    ("2026-11-01T11:30:00+00:00", "2026-10-31"),   # 3:30 AM after DST ends
    ("2026-10-10T03:30:00+00:00", "2026-10-09"),   # 8:30 PM the evening before, in UTC it's the next day
])
def test_workout_date_comes_from_started_at_at_upload(client, db, started, expected):
    ex = bench(client)
    _, r = upload(client, payload(ex["id"], started=started))
    assert r.status_code == 201
    assert r.json()["workout_date"] == expected


def sql(statement, **params):
    with get_sessionmaker()() as s:
        s.execute(text(statement), params)
        s.commit()


def test_finished_workouts_are_immutable_in_postgres(client, db):
    ex = bench(client)
    wid, r = upload(client, payload(ex["id"]))
    we = r.json()["exercises"][0]
    set_id = we["sets"][0]["id"]
    for statement in (
        "UPDATE workouts SET title = 'Changed' WHERE id = :w",
        "DELETE FROM workouts WHERE id = :w",
        "UPDATE workout_exercises SET notes = 'Changed' WHERE id = :e",
        "DELETE FROM workout_exercises WHERE id = :e",
        "UPDATE sets SET reps = 99 WHERE id = :s",
        "DELETE FROM sets WHERE id = :s",
        "INSERT INTO sets (id, workout_exercise_id, position, set_type) VALUES (gen_random_uuid(), :e, 5, 'normal')",
        "INSERT INTO workout_exercises (id, workout_id, exercise_id, position, logged_name) "
        "VALUES (gen_random_uuid(), :w, :x, 5, 'Sneaky')",
    ):
        with pytest.raises(DBAPIError, match="finished workouts are immutable"):
            sql(statement, w=wid, e=we["id"], s=set_id, x=ex["id"])
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json() == r.json()


def test_the_change_log_function_edits_and_records(client, db):
    ex = bench(client)
    wid, r = upload(client, payload(ex["id"]))
    before = r.json()
    with get_sessionmaker()() as s:
        snap = s.execute(text("SELECT workout_snapshot(:w)"), {"w": wid}).scalar_one()
        snap["title"] = "Push (fixed)"
        snap["exercises"][0]["sets"][1]["reps"] = 6
        change = str(uuid7())
        assert str(s.execute(text("SELECT edit_finished_workout(:c, :w, 'Wrong reps', :a)"),
                             {"c": change, "w": wid, "a": json.dumps(snap)}).scalar_one()) == change
        # The function's permission ends with it, even in the same transaction.
        with pytest.raises(DBAPIError, match="immutable"):
            with s.begin_nested():
                s.execute(text("UPDATE sets SET reps = 99 WHERE id = :s"), {"s": before["exercises"][0]["sets"][1]["id"]})
        s.commit()

    after = client.get(f"/api/workouts/{wid}", headers=TRAV).json()
    assert after["title"] == "Push (fixed)"
    assert [x["reps"] for x in after["exercises"][0]["sets"]] == [8, 6]
    assert after["exercises"][0]["sets"][0]["id"] == before["exercises"][0]["sets"][0]["id"]
    with get_sessionmaker()() as s:
        rows = s.execute(text("SELECT id, user_id, reason, before, after FROM workout_changes")).all()
    assert len(rows) == 1
    row = rows[0]
    assert (str(row.id), row.reason) == (change, "Wrong reps")
    assert (row.before["title"], row.after["title"]) == ("Push", "Push (fixed)")
    assert row.before["exercises"][0]["sets"][1]["reps"] == 5
    assert row.after["exercises"][0]["sets"][1]["reps"] == 6
    # Still immutable afterward.
    with pytest.raises(DBAPIError, match="immutable"):
        sql("UPDATE workouts SET title = 'Again' WHERE id = :w", w=wid)


def test_hevy_reimport_works_with_the_triggers_on(client, db):
    # The first export has only the Push workout; the next one has both.
    lines = SAMPLE.split(b"\n")
    first = b"\n".join(line for line in lines if not line.startswith(b'"Late night"'))
    _, res = resolve_all(client, TRAV, first)
    assert do_import(client, TRAV, res, first).json()["added"] == {"workouts": 1, "sets": 7}
    _, res = resolve_all(client, TRAV)
    r = do_import(client, TRAV, res).json()
    assert (r["added"], r["skipped"]) == ({"workouts": 1, "sets": 1}, {"workouts": 1, "sets": 7})
    again = do_import(client, TRAV, {}).json()
    assert (again["added"], again["skipped"]) == ({"workouts": 0, "sets": 0}, {"workouts": 2, "sets": 8})
    assert counts() == (2, 5, 8)
    # And the imported workouts are finished, so they're locked too.
    with pytest.raises(DBAPIError, match="immutable"):
        sql("UPDATE sets SET reps = 1")


def test_a_version_a_synced_workout_used_survives_edits_and_unused_ones_are_pruned(client, db):
    ex = bench(client)
    r = client.post("/api/routines", headers=TRAV, json={"name": "Day 1", "version": {"exercises": [{
        "exercise_id": ex["id"], "rest_seconds": 120, "sets": [{"reps_min": 5}]}]}}).json()
    v1 = r["current_version"]["id"]
    wid, up = upload(client, payload(ex["id"], version=v1))
    assert (up.json()["routine_version_id"], up.json()["routine_id"]) == (v1, r["id"])

    def save(parent):
        return client.post(f"/api/routines/{r['id']}/versions", headers=TRAV, json={
            "parent_version_id": parent, "exercises": [{"exercise_id": ex["id"], "sets": [{"reps_min": 6}]}]}
        ).json()["current_version"]["id"]

    v2 = save(v1)
    v3 = save(v2)
    kept = [v["id"] for v in client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()]
    assert kept == [v3, v1]  # v1 stays for the workout; v2 was never used, so it's gone
    assert client.get(f"/api/routines/{r['id']}/versions/{v1}", headers=TRAV).status_code == 200
    assert client.get(f"/api/routines/{r['id']}/versions/{v2}", headers=TRAV).status_code == 404
    assert client.delete(f"/api/routines/{r['id']}", headers=TRAV).json()["detail"]["code"] == "in_use"

    # A workout that started from a version pruned while it was offline still uploads, unlinked.
    _, late = upload(client, payload(ex["id"], version=v2))
    assert late.status_code == 201 and late.json()["routine_version_id"] is None
    # Her upload can't point at his version.
    her = bench(client, PARTNER)
    assert upload(client, payload(her["id"], version=v3), PARTNER)[1].status_code == 404


def test_offline_copy_has_everything_and_only_the_callers(client, db):
    ex = bench(client)
    r = client.post("/api/routines", headers=TRAV, json={"name": "Day 1", "version": {"exercises": [{
        "exercise_id": ex["id"], "sets": [{"reps_min": 5}]}]}}).json()
    upload(client, payload(ex["id"], version=r["current_version"]["id"]))
    mine = client.get("/api/offline", headers=TRAV).json()
    assert mine["me"]["login"] == "trav@example.com"
    assert [e["id"] for e in mine["exercises"]] == [ex["id"]]
    assert mine["versions"][r["id"]] == r["current_version"]
    assert mine["routines"]["routines"][0]["id"] == r["id"]
    assert [len(w["exercises"][0]["sets"]) for w in mine["workouts"]] == [2]
    hers = client.get("/api/offline", headers=PARTNER).json()
    assert hers["me"]["login"] == "partner@example.com"
    assert (hers["exercises"], hers["versions"], hers["workouts"]) == ([], {}, [])


def routine_with_snapshot(client, ex, name="Day 1"):
    r = client.post("/api/routines", headers=TRAV, json={"name": name, "version": {
        "exercises": [{"exercise_id": ex["id"], "rest_seconds": 120, "notes": "Pause reps",
                       "sets": [{"set_type": "warmup", "reps_min": 10, "weight_value": "95", "weight_unit": "lb"},
                                {"reps_min": 5, "reps_max": 8, "weight_value": "185", "weight_unit": "lb"}]}]}}).json()
    return r, r["current_version"]  # the phone's snapshot is GET /api/routines/{id}'s current_version


def with_version(ex_id, snapshot):
    body = payload(ex_id, version=snapshot["id"])
    body["routine_version"] = snapshot
    return body


def test_a_version_pruned_while_offline_is_recreated_under_its_id(client, db):
    ex = bench(client)
    r, v1 = routine_with_snapshot(client, ex)
    # Edited on desktop while the workout is offline: v1 is pruned.
    v2 = client.post(f"/api/routines/{r['id']}/versions", headers=TRAV, json={
        "parent_version_id": v1["id"], "exercises": [{"exercise_id": ex["id"], "sets": [{"reps_min": 6}]}]}).json()["current_version"]
    assert client.get(f"/api/routines/{r['id']}/versions/{v1['id']}", headers=TRAV).status_code == 404

    body = with_version(ex["id"], v1)
    wid, up = upload(client, body)
    assert up.status_code == 201
    assert (up.json()["routine_version_id"], up.json()["routine_id"]) == (v1["id"], r["id"])
    back = client.get(f"/api/routines/{r['id']}/versions/{v1['id']}", headers=TRAV).json()
    assert (back["number"], back["parent_version_id"]) == (1, None)
    e = back["exercises"][0]
    assert (e["exercise_id"], e["rest_seconds"], e["notes"]) == (ex["id"], 120, "Pause reps")
    assert [(s["set_type"], s["reps_min"], s["reps_max"], s["weight_value"]) for s in e["sets"]] == [
        ("warmup", 10, 10, "95"), ("normal", 5, 8, "185")]
    versions = client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()
    assert [(v["id"], v["current"]) for v in versions] == [(v2["id"], True), (v1["id"], False)]
    assert client.get(f"/api/routines/{r['id']}", headers=TRAV).json()["current_version"]["id"] == v2["id"]
    # A retry is still the same upload, and makes nothing new.
    assert upload(client, body, id=wid)[1].status_code == 200
    assert len(client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()) == 2


def test_naming_someone_elses_routine_or_version_is_404_and_recreates_nothing(client, db):
    ex = bench(client)
    r, v1 = routine_with_snapshot(client, ex)
    her = bench(client, PARTNER)
    # His routine, under a version id that doesn't exist.
    fake = {**v1, "id": str(uuid7())}
    assert upload(client, with_version(her["id"], fake), PARTNER)[1].status_code == 404
    # His existing version.
    assert upload(client, with_version(her["id"], v1), PARTNER)[1].status_code == 404
    with get_sessionmaker()() as s:
        assert s.execute(text("SELECT count(*) FROM routine_versions")).scalar_one() == 1
    assert client.get("/api/workouts", headers=PARTNER).json()["workouts"] == []


def test_a_workout_whose_routine_was_deleted_lands_without_a_link(client, db):
    ex = bench(client)
    r, v1 = routine_with_snapshot(client, ex)
    assert client.delete(f"/api/routines/{r['id']}", headers=TRAV).status_code == 204
    _, up = upload(client, with_version(ex["id"], v1))
    assert up.status_code == 201
    assert (up.json()["routine_version_id"], up.json()["routine_id"]) == (None, None)
    with get_sessionmaker()() as s:
        assert s.execute(text("SELECT count(*) FROM routine_versions")).scalar_one() == 0


@pytest.mark.parametrize("field,value,reason", [
    ("weight_value", "225265", "Barbell Bench Press - Medium Grip, set 1: the weight 225265 lb is over the limit of 9999.99."),
    ("weight_value", "10000", "Barbell Bench Press - Medium Grip, set 1: the weight 10000 lb is over the limit of 9999.99."),
    ("weight_value", "-5", "Barbell Bench Press - Medium Grip, set 1: the weight can't be negative."),
    ("weight_value", "137.555", "Barbell Bench Press - Medium Grip, set 1: the weight 137.555 has more than two decimal places."),
    ("reps", 1000, "Barbell Bench Press - Medium Grip, set 1: reps must be a whole number from 0 to 999."),
    ("reps", -1, "Barbell Bench Press - Medium Grip, set 1: reps must be a whole number from 0 to 999."),
])
def test_bad_set_values_are_refused_with_a_reason_and_nothing_is_written(client, db, field, value, reason):
    ex = bench(client)
    body = payload(ex["id"])
    # The working set, numbered 1 because the warm-up before it isn't counted.
    body["exercises"][0]["sets"][1][field] = value
    wid, r = upload(client, body)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "bad_set", "message": reason}
    assert counts() == (0, 0, 0)
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).status_code == 404
    # The limits themselves are fine.
    body["exercises"][0]["sets"][1].update(weight_value="9999.99", reps=999)
    assert upload(client, body, id=wid)[1].status_code == 201
