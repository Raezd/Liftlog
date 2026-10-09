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


# CORS: only the Android app's origin (https://localhost) gets CORS headers.
OK = {"X-Liftlog-Proxy": SECRET, "Tailscale-User-Login": "trav@example.com"}


def test_cors_allows_app_origin(client):
    r = client.get("/api/me", headers={**OK, "Origin": "https://localhost"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://localhost"


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost",
                                    "https://localhost:8443", "null"])
def test_cors_other_origin_gets_no_headers(client, origin):
    r = client.get("/api/me", headers={**OK, "Origin": origin})
    assert not [h for h in r.headers if h.lower().startswith("access-control-")]


def test_cors_preflight_other_origin_gets_no_headers(client):
    r = client.options("/api/me", headers={**OK, "Origin": "https://evil.example",
                                           "Access-Control-Request-Method": "POST"})
    assert not [h for h in r.headers if h.lower().startswith("access-control-")]


def test_cors_preflight_still_needs_auth(client):
    r = client.options("/api/me", headers={"Origin": "https://localhost",
                                           "Access-Control-Request-Method": "POST"})
    assert r.status_code == 403
    assert "access-control-allow-origin" not in r.headers


def test_apk_download_needs_auth(client):
    assert client.get("/api/app/liftlog.apk").status_code == 403
    assert client.get("/api/app/latest").status_code == 403
