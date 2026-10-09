"""The auth tests need no database: they only call /api/me."""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://invalid/none")
os.environ.setdefault("PROXY_SECRET", "t" * 64)
os.environ.setdefault("ALLOWED_LOGINS", "trav@example.com,partner@example.com")
