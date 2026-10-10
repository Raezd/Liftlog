"""Routines: saving makes a new version and prunes the one it replaced unless
a workout used it, stale saves conflict, save as routine copies sets without
RPE, used routines can't be deleted, and folders and routines are private."""

import pytest
from sqlalchemy import text, update
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import get_sessionmaker
from app.models import RoutineSet
from conftest import PARTNER, TRAV
from test_data import do_import, resolve_all
from test_workouts import payload, upload


def bench(client, headers=TRAV):
    return client.post("/api/exercises", headers=headers, json={"catalog_id": "Barbell_Bench_Press_-_Medium_Grip"}).json()


def make_routine(client, ex, name="Day 1", **extra):
    return client.post("/api/routines", headers=TRAV, json={"name": name, **extra, "version": {"exercises": [{
        "exercise_id": ex["id"], "rest_seconds": 120,
        "sets": [{"set_type": "warmup", "reps_min": 10, "weight_value": "95", "weight_unit": "lb"},
                 {"reps_min": 5, "weight_value": "185", "weight_unit": "lb"}]}]}}).json()


def edit(client, r, parent, reps_max=12):
    return client.post(f"/api/routines/{r['id']}/versions", headers=TRAV, json={
        "parent_version_id": parent, "exercises": [{
            "exercise_id": r["current_version"]["exercises"][0]["exercise_id"], "rest_seconds": 150,
            "sets": [{"set_type": "warmup", "reps_min": 10, "weight_value": "95", "weight_unit": "lb"},
                     {"reps_min": 8, "reps_max": reps_max, "weight_value": "175", "weight_unit": "lb"}]}]})


def started_from(client, version_id):
    """Uploads a finished workout that started from this version."""
    ex = client.get("/api/exercises", headers=TRAV).json()[0]
    assert upload(client, payload(ex["id"], version=version_id))[1].status_code == 201


def version_rows(routine_id):
    with get_sessionmaker()() as s:
        return s.execute(text("SELECT id::text FROM routine_versions WHERE routine_id = :r ORDER BY number"),
                         {"r": routine_id}).scalars().all()


def test_saving_prunes_the_previous_version_when_no_workout_used_it(client, db):
    r = make_routine(client, bench(client))
    v1 = r["current_version"]
    assert v1["number"] == 1
    assert v1["exercises"][0]["sets"][0]["reps_max"] == 10  # one number is a fixed target

    s = edit(client, r, v1["id"])
    assert s.status_code == 201
    v2 = s.json()["current_version"]
    # parent_version_id still records what the edit was based on, though v1 is gone.
    assert (v2["number"], v2["parent_version_id"]) == (2, v1["id"])
    assert (v2["exercises"][0]["sets"][1]["reps_min"], v2["exercises"][0]["sets"][1]["reps_max"]) == (8, 12)
    assert version_rows(r["id"]) == [v2["id"]]
    assert client.get(f"/api/routines/{r['id']}/versions/{v1['id']}", headers=TRAV).status_code == 404
    with get_sessionmaker()() as session:  # its exercises and sets went with it
        assert session.execute(text("SELECT count(*) FROM routine_exercises WHERE version_id = :v"),
                               {"v": v1["id"]}).scalar_one() == 0

    # Several more saves still leave one version.
    parent = v2["id"]
    for n in range(9, 13):
        parent = edit(client, r, parent, reps_max=n).json()["current_version"]["id"]
    assert version_rows(r["id"]) == [parent]
    versions = client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()
    assert [(v["number"], v["current"]) for v in versions] == [(6, True)]

    # And the database itself refuses to change a version.
    with get_sessionmaker()() as session, pytest.raises(DBAPIError, match="immutable"):
        session.execute(update(RoutineSet).values(reps_min=1))
        session.commit()


def test_stale_save_is_a_conflict_even_when_its_parent_was_pruned(client, db):
    r = make_routine(client, bench(client))
    v1 = r["current_version"]["id"]
    v2 = edit(client, r, v1).json()["current_version"]
    assert version_rows(r["id"]) == [v2["id"]]  # v1 is pruned
    stale = edit(client, r, v1, reps_max=15)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "version_conflict"
    # Nothing written, nothing pruned.
    assert client.get(f"/api/routines/{r['id']}", headers=TRAV).json()["current_version"] == v2
    assert version_rows(r["id"]) == [v2["id"]]


def test_a_version_a_workout_used_survives_saves_and_postgres_wont_delete_it(client, db):
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    r = make_routine(client, bench(client))
    v1 = r["current_version"]
    started_from(client, v1["id"])

    v2 = edit(client, r, v1["id"]).json()["current_version"]
    v3 = edit(client, r, v2["id"]).json()["current_version"]
    # v1 is kept because a workout used it; v2 wasn't, so it's gone.
    assert version_rows(r["id"]) == [v1["id"], v3["id"]]
    assert client.get(f"/api/routines/{r['id']}/versions/{v1['id']}", headers=TRAV).json() == v1
    versions = client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()
    assert [(v["number"], v["current"]) for v in versions] == [(3, True), (1, False)]

    with get_sessionmaker()() as session, pytest.raises(IntegrityError):
        session.execute(text("DELETE FROM routine_versions WHERE id = :v"), {"v": v1["id"]})
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


def test_used_routines_and_folders_only_archive_and_postgres_refuses_deletes(client, db):
    ex = bench(client)
    f = client.post("/api/folders", headers=TRAV, json={"name": "Upper/Lower"}).json()
    r = make_routine(client, ex, "Upper", folder_id=f["id"])
    _, res = resolve_all(client, TRAV)
    do_import(client, TRAV, res)
    started_from(client, r["current_version"]["id"])
    # The used version is no longer current after this edit; it still counts.
    edit(client, r, r["current_version"]["id"])

    assert client.delete(f"/api/routines/{r['id']}", headers=TRAV).json()["detail"]["code"] == "in_use"
    assert client.delete(f"/api/folders/{f['id']}", headers=TRAV).json()["detail"]["code"] == "in_use"
    # Past the API, Postgres refuses too (workouts.routine_version_id is ON DELETE RESTRICT).
    for sql, arg in (("DELETE FROM routines WHERE id = :x", r["id"]),
                     ("DELETE FROM routines WHERE folder_id = :x", f["id"])):
        with get_sessionmaker()() as session, pytest.raises(IntegrityError):
            session.execute(text(sql), {"x": arg})
            session.commit()
    assert len(version_rows(r["id"])) == 2

    assert client.patch(f"/api/routines/{r['id']}", headers=TRAV, json={"archived": True}).status_code == 200
    assert client.get("/api/routines", headers=TRAV).json()["folders"][0]["routines"] == []
    assert client.get("/api/routines?archived=true", headers=TRAV).json()["folders"][0]["routines"][0]["archived"]

    # An unused copy deletes, and so does an unused folder.
    copy = client.post(f"/api/routines/{r['id']}/duplicate", headers=TRAV, json={}).json()
    assert copy["name"] == "Upper copy" and copy["current_version"]["number"] == 1
    assert client.delete(f"/api/routines/{copy['id']}", headers=TRAV).status_code == 204
    empty = client.post("/api/folders", headers=TRAV, json={"name": "Empty"}).json()
    make_routine(client, ex, "Unused", folder_id=empty["id"])
    assert client.delete(f"/api/folders/{empty['id']}", headers=TRAV).status_code == 204


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


def test_versions_list_the_callers_workouts_and_another_users_version_is_404(client, db):
    ex = bench(client)
    r = make_routine(client, ex)
    v1 = r["current_version"]["id"]
    first = payload(ex["id"], version=v1, started="2026-10-01T17:00:00Z", title="First")
    second = payload(ex["id"], version=v1, started="2026-10-08T17:00:00Z", title="Second")
    w1 = upload(client, first)[1].json()
    w2 = upload(client, second)[1].json()
    # The workout names its routine and the version's save date.
    assert (w2["routine_name"], w2["routine_version_number"]) == ("Day 1", 1)
    assert w2["routine_version_created_at"] == r["current_version"]["created_at"]

    # The partner's own workout on her own routine never shows up in Trav's list.
    her_ex = bench(client, PARTNER)
    hers = client.post("/api/routines", headers=PARTNER, json={"name": "Hers", "version": {"exercises": [
        {"exercise_id": her_ex["id"], "sets": [{"reps_min": 5}]}]}}).json()
    assert upload(client, payload(her_ex["id"], version=hers["current_version"]["id"]), headers=PARTNER)[1].status_code == 201

    versions = client.get(f"/api/routines/{r['id']}/versions", headers=TRAV).json()
    assert [[w["id"] for w in v["workouts"]] for v in versions] == [[w2["id"], w1["id"]]]
    assert versions[0]["workouts"][0] == {"id": w2["id"], "title": "Second", "workout_date": "2026-10-08"}

    # Another user's routine, its versions, and one version: 404.
    assert client.get(f"/api/routines/{r['id']}/versions", headers=PARTNER).status_code == 404
    assert client.get(f"/api/routines/{r['id']}/versions/{v1}", headers=PARTNER).status_code == 404
    assert client.get(f"/api/routines/{hers['id']}/versions", headers=TRAV).status_code == 404
