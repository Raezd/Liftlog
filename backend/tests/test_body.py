"""Body measurements: isolation, the value and body fat limits (422 and
nothing written), exact entered values with cm beside them, one value per
site per date, and delete versus archive for sites. Changes over time are
computed on the phone and tested there (frontend tests/body.test.ts)."""

import datetime as dt

from sqlalchemy import func, select

from app.db import get_sessionmaker
from app.models import MeasureCheckin, MeasureValue
from conftest import PARTNER, TRAV


def body(client, headers=TRAV) -> dict:
    r = client.get("/api/body", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def site(doc: dict, name: str) -> dict:
    return next(s for s in doc["sites"] if s["name"] == name)


def checkin(client, values, headers=TRAV, **extra):
    return client.post("/api/body/checkins", headers=headers, json={"values": values, **extra})


def val(s: dict, value: str, unit: str = "in", side: str | None = None) -> dict:
    return {"site_id": s["id"], "side": side, "value": value, "unit": unit}


def counts() -> tuple[int, int]:
    with get_sessionmaker()() as s:
        return s.scalar(select(func.count()).select_from(MeasureCheckin)), s.scalar(
            select(func.count()).select_from(MeasureValue))


def test_standard_sites_are_seeded_once(client, db):
    doc = body(client)
    assert [(s["name"], s["paired"]) for s in doc["sites"]] == [
        ("Waist", False), ("Chest", False), ("Hips", False), ("Neck", False),
        ("Arms", True), ("Forearms", True), ("Thighs", True), ("Calves", True)]
    assert doc["length_unit"] == "in" and doc["checkins"] == []
    assert len(body(client)["sites"]) == 8
    assert len(client.get("/api/offline", headers=TRAV).json()["body"]["sites"]) == 8


def test_user_b_gets_404_on_user_a_measurements(client, db):
    trav, partner = body(client, TRAV), body(client, PARTNER)
    assert checkin(client, [val(site(trav, "Waist"), "34")], TRAV).status_code == 201
    assert checkin(client, [val(site(partner, "Waist"), "28")], PARTNER).status_code == 201
    trav = client.post("/api/body/sites", headers=TRAV, json={"name": "Wrist", "paired": False}).json()
    t_site, t_checkin = site(trav, "Wrist"), trav["checkins"][0]
    before = counts()

    # B can't touch A's site or check-in, or use A's site in a check-in of B's.
    assert client.patch(f"/api/body/sites/{t_site['id']}", headers=PARTNER, json={"name": "Mine"}).status_code == 404
    assert client.patch(f"/api/body/sites/{t_site['id']}", headers=PARTNER, json={"archived": True}).status_code == 404
    assert client.delete(f"/api/body/sites/{t_site['id']}", headers=PARTNER).status_code == 404
    edit = {"values": [val(site(partner, "Waist"), "29")]}
    assert client.put(f"/api/body/checkins/{t_checkin['id']}", headers=PARTNER, json=edit).status_code == 404
    assert client.delete(f"/api/body/checkins/{t_checkin['id']}", headers=PARTNER).status_code == 404
    assert checkin(client, [val(t_site, "7")], PARTNER).status_code == 404
    p_checkin = body(client, PARTNER)["checkins"][0]
    assert client.put(f"/api/body/checkins/{p_checkin['id']}", headers=PARTNER,
                      json={"values": [val(t_site, "7")]}).status_code == 404
    assert counts() == before

    # Each sees only their own, in the API and the offline copy.
    for headers, waist, other in ((TRAV, "34", PARTNER), (PARTNER, "28", TRAV)):
        mine, theirs = body(client, headers), body(client, other)
        assert {s["id"] for s in mine["sites"]}.isdisjoint({s["id"] for s in theirs["sites"]})
        assert [[v["value"] for v in c["values"]] for c in mine["checkins"]] == [[waist]]
        assert client.get("/api/offline", headers=headers).json()["body"] == mine
    assert "Wrist" not in {s["name"] for s in body(client, PARTNER)["sites"]}


def test_bad_values_are_refused_and_nothing_is_written(client, db):
    doc = body(client)
    waist, arms = site(doc, "Waist"), site(doc, "Arms")
    assert checkin(client, [val(waist, "34")], date="2026-10-01").status_code == 201
    before, stored = counts(), body(client)["checkins"]
    future = (dt.date.today() + dt.timedelta(days=2)).isoformat()
    good = val(waist, "33.5")

    cases = [
        ({"values": [good, val(arms, "301", "cm", "left")]}, "Arms, left: 301 cm is out of range"),
        ({"values": [good, val(arms, "118.12", "in", "right")]}, "Arms, right: 118.12 in is out of range"),
        ({"values": [good, val(arms, "14.125", "in", "left")]}, "Arms, left: use at most two decimal places."),
        ({"values": [good], "date": future}, "A check-in can't be in the future."),
        ({"values": [good], "body_fat_pct": "76", "body_fat_method": "calipers"}, "Body fat should be 1 to 75 percent."),
        ({"values": [good], "body_fat_pct": "0.5", "body_fat_method": "calipers"}, "Body fat should be 1 to 75 percent."),
        ({"values": [good], "body_fat_pct": "18"}, "Pick how body fat was measured."),
    ]
    for extra, reason in cases:
        for r in (client.post("/api/body/checkins", headers=TRAV, json={"date": "2026-10-01", **extra}),
                  client.post("/api/body/checkins", headers=TRAV, json={"date": "2026-10-02", **extra}),
                  client.put(f"/api/body/checkins/{stored[0]['id']}", headers=TRAV, json=extra)):
            assert r.status_code == 422, (extra, r.text)
            assert r.json()["detail"]["message"].startswith(reason), r.json()
        assert counts() == before
        assert body(client)["checkins"] == stored
    # The edges are fine: 300 cm and 118.11 in.
    assert checkin(client, [val(arms, "300", "cm", "left"), val(arms, "118.11", "in", "right")]).status_code == 201


def test_inches_stay_exact_with_cm_beside_them(client, db):
    doc = body(client)
    r = checkin(client, [val(site(doc, "Waist"), "32.25"), val(site(doc, "Neck"), "38.1", "cm")])
    assert r.status_code == 201
    values = {v["site_id"]: v for v in r.json()["checkins"][0]["values"]}
    assert values[site(doc, "Waist")["id"]] | {"id": None} == {
        "id": None, "site_id": site(doc, "Waist")["id"], "side": None, "value": "32.25", "unit": "in",
        "value_cm": "81.915"}
    assert (values[site(doc, "Neck")["id"]]["value"], values[site(doc, "Neck")["id"]]["unit"]) == ("38.1", "cm")
    # Switching the display unit doesn't touch stored values.
    assert client.patch("/api/me", headers=TRAV, json={"length_unit": "cm"}).json()["length_unit"] == "cm"
    again = body(client)
    assert again["length_unit"] == "cm" and again["checkins"] == r.json()["checkins"]


def test_entering_a_site_again_on_a_date_replaces_it(client, db):
    doc = body(client)
    waist, arms = site(doc, "Waist"), site(doc, "Arms")
    first = checkin(client, [val(waist, "34"), val(arms, "14", side="left")], date="2026-10-05",
                    body_fat_pct="20", body_fat_method="smart_scale")
    assert first.status_code == 201
    second = checkin(client, [val(waist, "33.75"), val(arms, "14.5", side="right")], date="2026-10-05")
    assert second.status_code == 200
    (c,) = second.json()["checkins"]
    got = sorted((v["site_id"], v["side"], v["value"]) for v in c["values"])
    assert got == sorted([(waist["id"], None, "33.75"), (arms["id"], "left", "14"), (arms["id"], "right", "14.5")])
    assert (c["body_fat_pct"], c["body_fat_method"]) == ("20", "smart_scale")
    assert counts() == (1, 3)


def test_moving_a_checkin_onto_another_ones_date_is_refused(client, db):
    waist = site(body(client), "Waist")
    assert checkin(client, [val(waist, "34")], date="2026-10-05").status_code == 201
    other = checkin(client, [val(waist, "33.5")], date="2026-10-06").json()["checkins"][0]
    before, stored = counts(), body(client)["checkins"]
    r = client.put(f"/api/body/checkins/{other['id']}", headers=TRAV,
                   json={"date": "2026-10-05", "values": [val(waist, "33")]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "date_taken"
    # Refused, not merged: both check-ins are as they were.
    assert counts() == before and body(client)["checkins"] == stored


def test_a_checkin_with_no_values_and_no_body_fat_is_refused(client, db):
    waist = site(body(client), "Waist")
    assert checkin(client, [val(waist, "34")], date="2026-10-05").status_code == 201
    before, stored = counts(), body(client)["checkins"]
    for r in (checkin(client, [], date="2026-10-06"),
              checkin(client, [], date="2026-10-06", notes="Just a note"),
              checkin(client, [], date="2026-10-05"),
              client.put(f"/api/body/checkins/{stored[0]['id']}", headers=TRAV, json={"values": [], "notes": "x"})):
        assert r.status_code == 422 and r.json()["detail"]["code"] == "empty_checkin", r.text
    assert counts() == before and body(client)["checkins"] == stored


def test_a_site_with_values_can_be_archived_not_deleted(client, db):
    doc = client.post("/api/body/sites", headers=TRAV, json={"name": "Wrist", "paired": False}).json()
    wrist = site(doc, "Wrist")
    assert checkin(client, [val(wrist, "6.5")]).status_code == 201
    r = client.delete(f"/api/body/sites/{wrist['id']}", headers=TRAV)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "in_use"
    assert site(body(client), "Wrist")["has_values"] is True
    r = client.patch(f"/api/body/sites/{wrist['id']}", headers=TRAV, json={"archived": True})
    assert r.status_code == 200 and site(r.json(), "Wrist")["archived"] is True
    assert counts() == (1, 1)
    # One with no values deletes.
    unused = site(body(client), "Neck")
    r = client.delete(f"/api/body/sites/{unused['id']}", headers=TRAV)
    assert r.status_code == 200 and "Neck" not in {s["name"] for s in r.json()["sites"]}
