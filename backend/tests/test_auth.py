import os

import pytest
from fastapi.testclient import TestClient

from app.main import app

SECRET = os.environ["PROXY_SECRET"]


@pytest.fixture
def client():
    return TestClient(app)


def test_missing_proxy_secret_rejected(client):
    r = client.get("/api/me", headers={"Tailscale-User-Login": "trav@example.com"})
    assert r.status_code == 403


def test_wrong_proxy_secret_rejected(client):
    r = client.get("/api/me", headers={"X-Liftlog-Proxy": "x" * 64,
                                       "Tailscale-User-Login": "trav@example.com"})
    assert r.status_code == 403


def test_unlisted_login_rejected(client):
    r = client.get("/api/me", headers={"X-Liftlog-Proxy": SECRET,
                                       "Tailscale-User-Login": "intruder@example.com"})
    assert r.status_code == 403


@pytest.mark.parametrize("login", ["trav@example.com", "Partner@Example.com"])
def test_allowed_login_accepted(client, login):
    r = client.get("/api/me", headers={"X-Liftlog-Proxy": SECRET, "Tailscale-User-Login": login})
    assert r.status_code == 200
    assert r.json() == {"login": login.lower()}
