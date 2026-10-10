"""Editing and deleting finished workouts (Spec 6b): every change goes
through edit_finished_workout() with one change log row, a stale revision is
409, bad values are 422, and nothing is written on any refusal. A deleted
workout is gone from every read and export, its id answers uploads with 410,
and a Hevy re-import never brings it back. Another user's workout is 404."""

import csv
import datetime as dt
import io
import json
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.db import get_sessionmaker
from app.models import uuid7
from conftest import PARTNER, TRAV
from test_data import do_import, resolve_all
from test_workouts import bench, counts, payload, sql, upload

LA = ZoneInfo("America/Los_Angeles")


def edit_body(w: dict) -> dict:
    """The editor's save for a workout as the API returned it, unchanged."""
    start = dt.datetime.fromisoformat(w["started_at"])
    end = dt.datetime.fromisoformat(w["ended_at"])
    local = start.astimezone(LA)
    return {
        "base_revision": w["edit_revision"], "title": w["title"], "notes": w["notes"],
        "start_date": local.date().isoformat(), "start_time": local.strftime("%H:%M"),
        "duration_minutes": int((end - start).total_seconds() // 60),
        "exercises": [{
            "id": e["id"], "exercise_id": e["exercise_id"], "superset_group": e["superset_group"],
            "notes": e["notes"], "rest_seconds": e["rest_seconds"],
            "sets": [{k: s[k] for k in ("id", "set_type", "weight_value", "weight_unit", "reps", "rpe",
                                        "duration_seconds", "distance_value", "distance_unit")}
                     for s in e["sets"]],
        } for e in w["exercises"]],
    }


def edit(client, wid, body, headers=TRAV):
    return client.post(f"/api/workouts/{wid}/edit", headers=headers, json=body)


def changes():
    with get_sessionmaker()() as s:
        return s.execute(text("SELECT workout_id, reason, before, after FROM workout_changes ORDER BY changed_at")).all()


def stored(wid):
    """The workout as Postgres holds it, deleted or not."""
    with get_sessionmaker()() as s:
        return s.execute(text("SELECT workout_snapshot(:w)"), {"w": wid}).scalar_one()


def uploaded(client):
    ex = bench(client)
    body = payload(ex["id"])
    wid, r = upload(client, body)
    assert r.status_code == 201
    return ex, body, wid, r.json()


def test_an_edit_writes_one_change_log_row_and_bumps_the_revision(client, db):
    ex, _, wid, w = uploaded(client)
    assert (w["edit_revision"], w["edited_at"]) == (0, None)
    body = edit_body(w)
    body["title"] = "Push (fixed)"
    body["duration_minutes"] = 45
    body["exercises"][0]["sets"][1]["reps"] = 3
    added = {"id": str(uuid7()), "set_type": "normal", "weight_value": "135", "weight_unit": "lb", "reps": 8}
    body["exercises"][0]["sets"].append(added)
    r = edit(client, wid, body)
    assert r.status_code == 200, r.text
    after = r.json()
    assert (after["title"], after["edit_revision"]) == ("Push (fixed)", 1)
    assert after["edited_at"] is not None
    assert after["ended_at"] == "2026-10-09T17:45:00+00:00"
    sets = after["exercises"][0]["sets"]
    assert [(s["reps"], s["completed_at"] is None) for s in sets] == [(8, False), (3, False), (8, True)]
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json() == after

    rows = changes()
    assert len(rows) == 1
    row = rows[0]
    assert (str(row.workout_id), row.reason) == (wid, "edit")
    assert (row.before["title"], row.before["edit_revision"], len(row.before["exercises"][0]["sets"])) == ("Push", 0, 2)
    assert (row.after["title"], row.after["edit_revision"], len(row.after["exercises"][0]["sets"])) == ("Push (fixed)", 1, 3)
    assert row.after == stored(wid)


def test_an_identical_save_writes_nothing(client, db):
    _, _, wid, w = uploaded(client)
    r = edit(client, wid, edit_body(w))
    assert r.status_code == 200 and r.json() == w
    assert changes() == [] and stored(wid)["edit_revision"] == 0


def test_a_stale_revision_is_409_and_writes_nothing(client, db):
    _, _, wid, w = uploaded(client)
    first = edit_body(w)
    first["title"] = "From the desktop"
    assert edit(client, wid, first).status_code == 200
    second = edit_body(w)  # still based on revision 0
    second["title"] = "From the phone"
    r = edit(client, wid, second)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "edit_conflict"
    assert len(changes()) == 1
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json()["title"] == "From the desktop"


def _bad_weight(b):
    b["exercises"][0]["sets"][1]["weight_value"] = "10000"


def _no_exercises(b):
    b["exercises"] = []


def _zero_duration(b):
    b["duration_minutes"] = 0


def _future_end(b):
    start = dt.datetime.now(LA) - dt.timedelta(minutes=30)
    b["start_date"], b["start_time"] = start.date().isoformat(), start.strftime("%H:%M")
    b["duration_minutes"] = 90


@pytest.mark.parametrize("change, reason", [
    (_bad_weight, "Barbell Bench Press - Medium Grip, set 1: the weight 10000 lb is over the limit of 9999.99."),
    (_no_exercises, "A workout needs at least one exercise. To remove it all, delete the workout."),
    (_zero_duration, "The workout needs to last at least a minute."),
    (_future_end, "The workout can't end in the future."),
])
def test_bad_edits_are_422_with_a_reason_and_write_nothing(client, db, change, reason):
    _, _, wid, w = uploaded(client)
    body = edit_body(w)
    change(body)
    r = edit(client, wid, body)
    assert r.status_code == 422
    assert r.json()["detail"]["message"] == reason
    assert changes() == []
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json() == w


@pytest.mark.parametrize("date, time, expected", [
    ("2026-10-05", "18:30", "2026-10-05"),  # moved into the week before
    ("2026-10-08", "03:30", "2026-10-07"),  # before 4 AM: the day before
    ("2026-10-08", "04:00", "2026-10-08"),
])
def test_a_time_edit_recomputes_the_workout_date(client, db, date, time, expected):
    _, _, wid, w = uploaded(client)
    assert w["workout_date"] == "2026-10-09"
    body = edit_body(w)
    body["start_date"], body["start_time"] = date, time
    r = edit(client, wid, body)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["workout_date"] == expected
    start = dt.datetime.fromisoformat(got["started_at"]).astimezone(LA)
    assert (start.date().isoformat(), start.strftime("%H:%M")) == (date, time)
    assert dt.datetime.fromisoformat(got["ended_at"]) - dt.datetime.fromisoformat(got["started_at"]) == dt.timedelta(hours=1)


def test_a_delete_sets_deleted_at_with_its_log_row_and_hides_it_everywhere(client, db):
    ex, body, wid, w = uploaded(client)
    _, keep = upload(client, payload(ex["id"], started="2026-10-07T17:00:00Z", title="Kept"))
    assert client.delete(f"/api/workouts/{wid}", headers=TRAV).status_code == 204
    snap = stored(wid)
    assert snap["deleted_at"] is not None and snap["edit_revision"] == 1
    [row] = changes()
    assert (str(row.workout_id), row.reason, row.before["deleted_at"]) == (wid, "delete", None)
    assert row.before["exercises"] == snap["exercises"]

    # Gone from the detail page, history, the offline copy (records, volume,
    # prefill, and the calendar all run on it), and both exports.
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).status_code == 404
    assert [x["title"] for x in client.get("/api/workouts", headers=TRAV).json()["workouts"]] == ["Kept"]
    assert [x["title"] for x in client.get("/api/offline", headers=TRAV).json()["workouts"]] == ["Kept"]
    doc = json.loads(client.get("/api/export?format=json", headers=TRAV).content)
    assert [x["title"] for x in doc["workouts"]] == ["Kept"]
    rows = list(csv.DictReader(io.StringIO(client.get("/api/export?format=csv", headers=TRAV).text)))
    assert {r["title"] for r in rows} == {"Kept"}
    for fmt in ("json", "csv"):
        assert client.get(f"/api/workouts/{wid}/export?format={fmt}", headers=TRAV).status_code == 404
    # Deleted again, or edited: 404.
    assert client.delete(f"/api/workouts/{wid}", headers=TRAV).status_code == 404
    assert edit(client, wid, edit_body(w)).status_code == 404

    # An upload under its id is 410, whatever the content, and writes nothing.
    before = counts()
    for b in (body, payload(ex["id"])):
        r = upload(client, b, id=wid)[1]
        assert r.status_code == 410 and r.json()["detail"]["code"] == "workout_deleted"
    assert counts() == before and len(changes()) == 1


def test_retrying_the_first_upload_after_an_edit_is_still_a_no_op(client, db):
    _, body, wid, w = uploaded(client)
    e = edit_body(w)
    e["exercises"][0]["sets"].pop(0)
    edited = edit(client, wid, e).json()
    r = upload(client, body, id=wid)[1]
    assert r.status_code == 200 and r.json() == edited
    assert len(changes()) == 1
    changed = json.loads(json.dumps(body))
    changed["exercises"][0]["sets"][1]["reps"] = 6
    assert upload(client, changed, id=wid)[1].json()["detail"]["code"] == "workout_conflict"
    assert client.get(f"/api/workouts/{wid}", headers=TRAV).json() == edited


def test_a_hevy_reimport_skips_a_deleted_imported_workout(client, db):
    _, res = resolve_all(client, TRAV)
    assert do_import(client, TRAV, res).status_code == 201
    listed = client.get("/api/workouts", headers=TRAV).json()["workouts"]
    gone = listed[0]
    assert client.delete(f"/api/workouts/{gone['id']}", headers=TRAV).status_code == 204
    again = do_import(client, TRAV, {}).json()
    assert again["added"] == {"workouts": 0, "sets": 0}
    assert again["skipped"]["workouts"] == len(listed)
    assert [x["id"] for x in client.get("/api/workouts", headers=TRAV).json()["workouts"]] == [x["id"] for x in listed[1:]]


def test_another_users_workout_is_404_to_edit_and_delete(client, db):
    _, _, wid, w = uploaded(client)
    body = edit_body(w)
    body["title"] = "Hers now"
    assert edit(client, wid, body, PARTNER).status_code == 404
    assert client.delete(f"/api/workouts/{wid}", headers=PARTNER).status_code == 404
    assert changes() == [] and client.get(f"/api/workouts/{wid}", headers=TRAV).json() == w
    # She can edit and delete her own.
    her = bench(client, PARTNER)
    hid, r = upload(client, payload(her["id"]), PARTNER)
    mine = edit_body(r.json())
    mine["title"] = "Mine"
    assert edit(client, hid, mine, PARTNER).json()["title"] == "Mine"
    assert client.delete(f"/api/workouts/{hid}", headers=PARTNER).status_code == 204


def test_deleted_at_and_edit_revision_change_only_through_the_function(client, db):
    _, _, wid, _ = uploaded(client)
    for statement in ("UPDATE workouts SET deleted_at = now() WHERE id = :w",
                      "UPDATE workouts SET edit_revision = 5 WHERE id = :w"):
        with pytest.raises(DBAPIError, match="immutable|edit_finished_workout"):
            sql(statement, w=wid)
    # Even the transaction that creates a workout can't start it deleted.
    with pytest.raises(DBAPIError, match="starts unedited"):
        sql("INSERT INTO workouts (id, user_id, title, started_at, workout_date, source, deleted_at) "
            "SELECT gen_random_uuid(), user_id, 'x', now(), current_date, 'liftlog', now() FROM workouts LIMIT 1")
    assert stored(wid)["deleted_at"] is None
