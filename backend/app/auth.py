"""Authentication, as middleware so it covers every route, including ones
added later and the API docs.

Two checks on every request:

1. The X-Liftlog-Proxy header must match PROXY_SECRET. Caddy sets it and
   overwrites any client-supplied value, so this proves the request came
   through Caddy (which is only reachable through Tailscale Serve).
2. Tailscale-User-Login, added by Tailscale Serve after it verifies the
   device, must be on the ALLOWED_LOGINS list.

Check 2 is only trustworthy because of check 1 plus the network layout: nothing
can reach the backend without passing through Tailscale first. That is why the
stack publishes no host ports.

Identity rejections carry an auth_ code so the app can explain what went
wrong. The caller's own login is echoed only after check 1 passes, so nothing
that bypassed Caddy learns anything. A failed check 1 gets a bare, generic
answer.
"""

import hmac
from collections.abc import Awaitable, Callable

from fastapi import Request, Response, status
from fastapi.responses import JSONResponse

from app.config import get_settings

PROXY_HEADER = "X-Liftlog-Proxy"


def _deny(code: int, detail: dict) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=code)


async def require_identity(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    settings = get_settings()
    given = request.headers.get(PROXY_HEADER)
    # compare_digest takes constant time, so the secret can't be guessed by timing.
    if given is None or not hmac.compare_digest(given.encode(), settings.proxy_secret.encode()):
        return _deny(status.HTTP_403_FORBIDDEN, {"code": "forbidden"})

    login = (request.headers.get("Tailscale-User-Login") or "").strip().lower()
    if not login:
        return _deny(status.HTTP_401_UNAUTHORIZED, {"code": "auth_no_identity"})
    if login not in settings.allowed_login_set:
        # Only the caller's own login, so a typo in ALLOWED_LOGINS is easy to spot.
        return _deny(status.HTTP_403_FORBIDDEN, {"code": "auth_not_allowed", "login": login})

    request.state.login = login
    return await call_next(request)
