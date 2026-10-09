"""Docker healthcheck: python -m app.healthcheck

Every route is behind the auth middleware, so this sends the headers Caddy and
Tailscale would, using the container's own settings. Exits nonzero unless
/api/health answers 200 (which also means the database answered).
"""

import os
import urllib.request

from app.auth import PROXY_HEADER

login = os.environ["ALLOWED_LOGINS"].split(",")[0].strip()
req = urllib.request.Request(
    "http://127.0.0.1:8000/api/health",
    headers={PROXY_HEADER: os.environ["PROXY_SECRET"], "Tailscale-User-Login": login},
)
urllib.request.urlopen(req, timeout=3)
