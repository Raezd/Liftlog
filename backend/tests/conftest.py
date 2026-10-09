"""Test setup. Run through scripts/test-backend.sh, which starts a throwaway
Postgres and sets TEST_DATABASE_URL. Tests marked `db` need it; the auth and
pure-logic tests would run without it, but the script always provides one."""

import os

import pytest

os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://invalid/none")
os.environ.setdefault("PROXY_SECRET", "t" * 64)
os.environ.setdefault("ALLOWED_LOGINS", "trav@example.com,partner@example.com")

SECRET = os.environ["PROXY_SECRET"]
TRAV = {"X-Liftlog-Proxy": SECRET, "Tailscale-User-Login": "trav@example.com"}
PARTNER = {"X-Liftlog-Proxy": SECRET, "Tailscale-User-Login": "partner@example.com"}


@pytest.fixture(scope="session")
def migrated():
    if "TEST_DATABASE_URL" not in os.environ:
        pytest.fail("No test database. Run scripts/test-backend.sh.")
    from alembic import command
    from alembic.config import Config
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    command.upgrade(cfg, "head")


@pytest.fixture
def db(migrated):
    """A clean database for each test. The catalog and muscles stay."""
    from sqlalchemy import text
    from app.db import get_engine
    with get_engine().begin() as conn:
        conn.execute(text("TRUNCATE users CASCADE"))
    yield


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    return TestClient(app)
