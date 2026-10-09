"""Routines: saving makes a new version and leaves the old one alone, save
as routine copies sets without RPE, and folders and routines are private."""

import pytest
from sqlalchemy import text, update
from sqlalchemy.exc import DBAPIError

from app.db import get_sessionmaker
from app.models import RoutineSet
from conftest import PARTNER, TRAV
from test_data import do_import, resolve_all


def bench(client, headers=TRAV):
    return client.post("/api/exercises", headers=headers, json={"catalog_id": "Barbell_Bench_Press_-_Medium_Grip"}).json()


def test_saving_makes_a_new_version_and_keeps_the_old_one(client, db):
    ex = bench(client)
    r = client.post("/api/routines", headers=TRAV, json={"name": "Day 1", "version": {"exercises": [{
        "exercise_id": ex["id"], "rest_seconds": 120,
        "sets": [{"set_type": "warmup", "reps_min": 10, "weight_value": "95", "weight_unit": "lb"},
                 {"reps_min": 5, "weight_value": "185", "weight_unit": "lb"}]}]}}).json()
    v1 = r["current_version"]
    assert v1["number"] == 1
    assert v1["exercises"][0]["sets"][0]["reps_max"] == 10  # one number is a fixed target

    edited = {"parent_version_id": v1["id"], "exercises": [{
        "exercise_id": ex["id"], "rest_seconds": 150,
        "sets": [{"set_type": "warmup", "reps_min": 10, "weight_value": "95", "weight_unit": "lb"},
                 {"reps_min": 8, "reps_max": 12, "weight_value": "175", "weight_unit": "lb"}]}]}
    s = client.post(f"/api/routines/{r['id']}/versions", headers=TRAV, json=edited)
    assert s.status_code == 201
    v2 = s.json()["current_version"]
    assert (v2["number"], v2["parent_version_id"]) == (2, v1["id"])
    assert (v2["exercises"][0]["sets"][1]["reps_min"], v2["exercises"][0]["sets"][1]["reps_max"]) == (8, 12)

    # The old version reads back exactly as it was.
    old = client.get(f"/api/routines/{r['id']}/versions/{v1['id']}", headers=TRAV).json()
    assert old == v1
    versions = client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()
    assert [(v["number"], v["current"]) for v in versions] == [(2, True), (1, False)]

    # Saving from a stale parent is a conflict and writes nothing.
    stale = client.post(f"/api/routines/{r['id']}/versions", headers=TRAV, json={**edited, "exercises": []})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "version_conflict"
    assert client.get(f"/api/routines/{r['id']}", headers=TRAV).json()["current_version"] == v2

    # And the database itself refuses to change a version.
    with get_sessionmaker()() as session, pytest.raises(DBAPIError, match="immutable"):
        session.execute(update(RoutineSet).values(reps_min=1))
        session.commit()


def test_superset_rules(client, db):
    ex = bench(client)
    others = [client.post("/api/exercises", headers=TRAV, json={
        "name": f"Move {i}", "equipment": "other", "logging_type": "weight_reps"}).json() for i in range(4)]
    ids = [ex["id"]] + [o["id"] for o in others]

    def save(groups):
        return client.post("/api/routines", headers=TRAV, json={"name": "S", "version": {
            "superset_rests": {"7": 90},
            "exercises": [{"exercise_id": i, "superset_group": g} for i, g in zip(ids, groups)]}})

    assert save([7, 7, 7, 7, None]).json()["detail"]["code"] == "superset_too_big"
    assert save([7, None, 7, None, None]).json()["detail"]["code"] == "superset_split"
    v = save([None, 7, 7, 3, None]).json()["current_version"]
    # Renumbered in order; a lone exercise isn't a superset; the rest follows its group.
    assert [e["superset_group"] for e in v["exercises"]] == [None, 0, 0, None, None]
    assert v["superset_rests"] == {"0": 90}


def test_save_as_routine_copies_sets_and_skips_rpe(client, db):
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    workouts = client.get("/api/workouts", headers=TRAV).json()["workouts"]
    push_id = workouts[-1]["id"]
    w = client.get(f"/api/workouts/{push_id}", headers=TRAV).json()
    assert any(s["rpe"] for e in w["exercises"] for s in e["sets"])  # the sample has RPE to skip

    r = client.post("/api/routines/from-workout", headers=TRAV, json={
        "workout_id": push_id, "name": w["title"], "new_folder_name": "PPL"})
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == w["title"] and body["folder_id"]
    v = body["current_version"]
    assert [e["exercise_id"] for e in v["exercises"]] == [e["exercise_id"] for e in w["exercises"]]
    assert [e["notes"] for e in v["exercises"]] == [e["notes"] for e in w["exercises"]]
    assert [e["superset_group"] is None for e in v["exercises"]] == [e["superset_group"] is None for e in w["exercises"]]
    for we, re in zip(w["exercises"], v["exercises"]):
        assert len(re["sets"]) == len(we["sets"])
        for ws, rs in zip(we["sets"], re["sets"]):
            assert rs["set_type"] == ws["set_type"]
            assert (rs["weight_value"], rs["weight_unit"]) == (ws["weight_value"], ws["weight_unit"])
            assert rs["reps_min"] == rs["reps_max"] == ws["reps"]
            assert (rs["duration_seconds"], rs["distance_value"]) == (ws["duration_seconds"], ws["distance_value"])
            assert rs["rpe"] is None
    folders = client.get("/api/routines", headers=TRAV).json()["folders"]
    assert [(f["name"], [x["name"] for x in f["routines"]]) for f in folders] == [("PPL", [w["title"]])]


def test_unused_routines_delete_and_used_ones_only_archive(client, db):
    ex = bench(client)
    f = client.post("/api/folders", headers=TRAV, json={"name": "Upper/Lower"}).json()
    r = client.post("/api/routines", headers=TRAV, json={
        "name": "Upper", "folder_id": f["id"], "version": {"exercises": [{"exercise_id": ex["id"]}]}}).json()
    # Spec 5 links workouts to the version they started from. Fake one here.
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    with get_sessionmaker()() as s:
        s.execute(text("UPDATE workouts SET routine_version_id = :v WHERE id = (SELECT id FROM workouts LIMIT 1)"),
                  {"v": r["current_version"]["id"]})
        s.commit()
    assert client.delete(f"/api/routines/{r['id']}", headers=TRAV).json()["detail"]["code"] == "in_use"
    assert client.delete(f"/api/folders/{f['id']}", headers=TRAV).json()["detail"]["code"] == "in_use"
    assert client.patch(f"/api/routines/{r['id']}", headers=TRAV, json={"archived": True}).status_code == 200
    assert client.get("/api/routines", headers=TRAV).json()["folders"][0]["routines"] == []
    assert client.get("/api/routines?archived=true", headers=TRAV).json()["folders"][0]["routines"][0]["archived"]

    copy = client.post(f"/api/routines/{r['id']}/duplicate", headers=TRAV, json={}).json()
    assert copy["name"] == "Upper copy" and copy["current_version"]["number"] == 1
    assert client.delete(f"/api/routines/{copy['id']}", headers=TRAV).status_code == 204


def test_folders_and_routines_are_private(client, db):
    ex = bench(client)
    f = client.post("/api/folders", headers=TRAV, json={"name": "PPL"}).json()
    r = client.post("/api/routines", headers=TRAV, json={
        "name": "Push", "folder_id": f["id"], "version": {"exercises": [{"exercise_id": ex["id"], "sets": [{}]}]}}).json()
    v = r["current_version"]["id"]

    for path in (f"/api/routines/{r['id']}", f"/api/routines/{r['id']}/versions",
                 f"/api/routines/{r['id']}/versions/{v}"):
        assert client.get(path, headers=TRAV).status_code == 200
        assert client.get(path, headers=PARTNER).status_code == 404
    assert client.get("/api/routines?archived=true", headers=PARTNER).json() == {"folders": [], "routines": []}
    for method, path, body in (
        ("PATCH", f"/api/routines/{r['id']}", {"name": "Mine"}),
        ("PATCH", f"/api/folders/{f['id']}", {"name": "Mine"}),
        ("DELETE", f"/api/routines/{r['id']}", None),
        ("DELETE", f"/api/folders/{f['id']}", None),
        ("POST", f"/api/routines/{r['id']}/duplicate", {}),
        ("POST", f"/api/folders/{f['id']}/duplicate", {}),
        ("POST", f"/api/routines/{r['id']}/versions", {"parent_version_id": v, "exercises": []}),
        ("PUT", "/api/routines/layout", {"folders": [f["id"]]}),
        ("PUT", "/api/routines/layout", {"groups": [{"folder_id": None, "routine_ids": [r["id"]]}]}),
    ):
        assert client.request(method, path, headers=PARTNER, json=body).status_code == 404, (method, path)

    # She can make her own, but not in his folder, with his exercise, or from his workout.
    mine = client.post("/api/folders", headers=PARTNER, json={"name": "Hers"})
    assert mine.status_code == 201
    assert client.post("/api/routines", headers=PARTNER, json={"name": "X", "folder_id": f["id"]}).status_code == 404
    assert client.post("/api/routines", headers=PARTNER, json={
        "name": "X", "version": {"exercises": [{"exercise_id": ex["id"]}]}}).status_code == 404
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    wid = client.get("/api/workouts", headers=TRAV).json()["workouts"][0]["id"]
    assert client.post("/api/routines/from-workout", headers=PARTNER,
                       json={"workout_id": wid, "name": "X"}).status_code == 404
    # His ids can't be taken over.
    assert client.post("/api/routines", headers=PARTNER, json={"id": r["id"], "name": "X"}).status_code == 409
    assert client.post("/api/folders", headers=PARTNER, json={"id": f["id"], "name": "X"}).status_code == 409
    her = client.post("/api/routines", headers=PARTNER, json={"name": "Legs", "folder_id": mine.json()["id"]})
    assert her.status_code == 201
    assert client.post("/api/routines", headers=PARTNER, json={"name": "Y", "version": {
        "id": v, "exercises": []}}).status_code == 409
    her_ex = bench(client, PARTNER)
    assert client.post("/api/routines", headers=PARTNER, json={"name": "Y", "version": {"exercises": [{
        "id": r["current_version"]["exercises"][0]["id"], "exercise_id": her_ex["id"]}]}}).status_code == 409

    # His view is unchanged, hers has only her own.
    assert [x["name"] for x in client.get("/api/routines", headers=TRAV).json()["folders"]] == ["PPL"]
    hers = client.get("/api/routines", headers=PARTNER).json()
    assert [(x["name"], [y["name"] for y in x["routines"]]) for x in hers["folders"]] == [("Hers", ["Legs"])]
