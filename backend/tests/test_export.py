"""Export: every export is the caller's own (another user's workout is 404,
and full history holds only the caller's data), and the CSV round-trips:
exporting a history and importing it with the Hevy importer into a new user
gives the same workouts and sets."""

import csv
import io
import json

from app.models import uuid7
from conftest import PARTNER, TRAV
from test_data import do_import, resolve_all
from test_workouts import bench, payload, upload


def custom_resolutions(client, headers, data: bytes) -> dict:
    """Every title becomes a custom exercise with that exact name."""
    p = client.post("/api/imports/hevy/preview", headers=headers, files={"file": ("w.csv", data)}).json()
    return {t["title"]: {"action": "custom", "name": t["title"], "equipment": t["equipment"],
                         "logging_type": t["logging_type"]} for t in p["titles"] if not t["mapped_to"]}


def exported(client, headers, fmt, path="/api/export"):
    r = client.get(f"{path}?format={fmt}", headers=headers)
    assert r.status_code == 200, r.text
    return r


def give_everything(client, headers, who):
    """A workout, an exercise, a folder with a routine, a custom bar and plate set, and measurements."""
    ex = bench(client, headers)
    wid, r = upload(client, payload(ex["id"], title=f"{who} workout"), headers=headers)
    assert r.status_code == 201
    folder = client.post("/api/folders", headers=headers, json={"name": f"{who} folder"}).json()
    assert client.post("/api/routines", headers=headers, json={"name": f"{who} day", "folder_id": folder["id"], "version": {
        "exercises": [{"exercise_id": ex["id"], "sets": [{"reps_min": 5, "weight_value": "135", "weight_unit": "lb"}]}]}}).status_code == 201
    assert client.post("/api/gear/bars", headers=headers, json={
        "name": f"{who} sled", "weight_value": "75", "weight_unit": "lb"}).status_code == 201
    assert client.post("/api/gear/plate-sets", headers=headers, json={"name": f"{who} plates"}).status_code == 201
    sites = client.post("/api/body/sites", headers=headers, json={"name": f"{who} wrist", "paired": False}).json()["sites"]
    wrist = next(s for s in sites if s["name"] == f"{who} wrist")
    assert client.post("/api/body/checkins", headers=headers, json={
        "date": "2026-10-08", "body_fat_pct": "21.5", "body_fat_method": "calipers", "notes": f"{who} notes",
        "values": [{"site_id": wrist["id"], "value": "6.75", "unit": "in"}]}).status_code == 201
    return wid


def test_exports_are_private(client, db):
    _, res = resolve_all(client, TRAV)
    assert do_import(client, TRAV, res).status_code == 201
    trav_wid = give_everything(client, TRAV, "Trav")
    partner_wid = give_everything(client, PARTNER, "Partner")

    for fmt in ("json", "csv"):
        assert client.get(f"/api/workouts/{trav_wid}/export?format={fmt}", headers=PARTNER).status_code == 404
        assert client.get(f"/api/workouts/{partner_wid}/export?format={fmt}", headers=TRAV).status_code == 404
        mine = exported(client, TRAV, fmt, f"/api/workouts/{trav_wid}/export")
        assert mine.headers["content-disposition"] == f'attachment; filename="liftlog-workout-2026-10-09.{fmt}"'

    trav = exported(client, TRAV, "json").json()
    doc = exported(client, PARTNER, "json").json()
    assert doc["schema_version"] == 2 and doc["user"]["login"] == "partner@example.com"
    # Partner's own data is there, and nothing of Trav's.
    assert [w["id"] for w in doc["workouts"]] == [partner_wid]
    assert len(doc["exercises"]) == 1
    assert {e["id"] for e in doc["exercises"]}.isdisjoint({e["id"] for e in trav["exercises"]})
    assert [f["name"] for f in doc["routines"]["folders"]] == ["Partner folder"]
    assert [r["name"] for f in doc["routines"]["folders"] for r in f["routines"]] == ["Partner day"]
    assert doc["routines"]["routines"] == []
    assert set(doc["routine_versions"]).isdisjoint(trav["routine_versions"]) and len(doc["routine_versions"]) == 1
    names = lambda g: {b["name"] for b in g["bars"]} | {s["name"] for s in g["plate_sets"]}
    assert {"Partner sled", "Partner plates"} <= names(doc["gear"])
    assert not {"Trav sled", "Trav plates"} & names(doc["gear"])
    ids = lambda g: {b["id"] for b in g["bars"]} | {s["id"] for s in g["plate_sets"]}
    assert ids(doc["gear"]).isdisjoint(ids(trav["gear"]))
    # Measurements: every stored field, and only the caller's.
    m, tm = doc["measurements"], trav["measurements"]
    assert {s["id"] for s in m["sites"]}.isdisjoint({s["id"] for s in tm["sites"]})
    assert "Partner wrist" in {s["name"] for s in m["sites"]} and "Trav wrist" not in {s["name"] for s in m["sites"]}
    (c,) = m["checkins"]
    wrist = next(s for s in m["sites"] if s["name"] == "Partner wrist")
    assert set(wrist) == {"id", "name", "paired", "archived", "position", "created_at"}
    assert c["id"] != tm["checkins"][0]["id"] and c["notes"] == "Partner notes"
    assert (c["date"], c["body_fat_pct"], c["body_fat_method"]) == ("2026-10-08", "21.5", "calipers")
    assert [{k: v for k, v in x.items() if k != "id"} for x in c["values"]] == [
        {"site_id": wrist["id"], "side": None, "value": "6.75", "unit": "in", "value_cm": "17.145"}]
    assert doc["user"]["length_unit"] == "in"
    rows = list(csv.DictReader(io.StringIO(exported(client, PARTNER, "csv").text)))
    assert {r["title"] for r in rows} == {"Partner workout"}


def comparable(doc: dict) -> list:
    """What a CSV can carry: workouts, exercises by name, and sets."""
    names = {e["id"]: e["name"] for e in doc["exercises"]}
    return sorted([
        w["title"], w["started_at"], w["ended_at"], w["notes"], w["workout_date"],
        [[names[e["exercise_id"]], e["superset_group"], e["notes"],
          [[s["set_type"], s["weight_value"], s["weight_unit"], s["reps"], s["rpe"], s["duration_seconds"],
            s["distance_value"], s["distance_unit"]] for s in e["sets"]]] for e in w["exercises"]],
    ] for w in doc["workouts"])


def test_csv_round_trips_through_the_hevy_importer(client, db):
    _, res = resolve_all(client, TRAV)
    assert do_import(client, TRAV, res).status_code == 201
    # A workout from the app, with what the CSV has to keep: a superset, a drop
    # set, an exact 137.5, RPE, notes with a line break, and the same exercise twice.
    ex = bench(client)
    row = client.post("/api/exercises", headers=TRAV, json={"catalog_id": "Bent_Over_Barbell_Row"}).json()
    body = payload(ex["id"], started="2026-10-09T17:00:00+00:00", title="Upper, \"heavy\"")
    body["notes"] = "Good day\nslept well"
    sets = lambda *ws: [{"id": str(uuid7()), "set_type": t, "weight_value": w, "weight_unit": "lb", "reps": 8,
                         "rpe": None, "completed_at": body["started_at"]} for t, w in ws]
    body["exercises"] += [
        {"id": str(uuid7()), "exercise_id": row["id"], "superset_group": 0, "notes": "", "rest_seconds": 90,
         "sets": sets(("normal", "135"), ("drop", "95"))},
        {"id": str(uuid7()), "exercise_id": ex["id"], "superset_group": 0, "notes": "Close grip", "rest_seconds": 90,
         "sets": sets(("normal", "115"))},
    ]
    assert upload(client, body)[1].status_code == 201

    data = exported(client, TRAV, "csv").content
    assert data.splitlines()[0] == (b'"title","start_time","end_time","description","exercise_title","superset_id",'
                                    b'"exercise_notes","set_index","set_type","weight_lbs","reps","distance_miles",'
                                    b'"duration_seconds","rpe"')
    imp = do_import(client, PARTNER, custom_resolutions(client, PARTNER, data), csv=data)
    assert imp.status_code == 201, imp.text
    assert imp.json()["added"] == {"workouts": 3, "sets": 13}

    before = comparable(exported(client, TRAV, "json").json())
    after = comparable(exported(client, PARTNER, "json").json())
    assert after == before
    assert any(w[0] == 'Upper, "heavy"' and w[3] == "Good day\nslept well" for w in after)
    # Importing it again adds nothing.
    again = do_import(client, PARTNER, {}, csv=data).json()
    assert again["added"] == {"workouts": 0, "sets": 0}
