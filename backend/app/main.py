import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.datastructures import Headers
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth import require_identity
from app.db import get_sessionmaker
from app.routers import exercises, imports, me, routines, workouts

# Interactive API docs at /api/docs. Like every route, behind the auth middleware.
app = FastAPI(title="Liftlog", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

# The Android app (Capacitor) serves its bundled files from https://localhost
# and calls the API cross-origin. That origin and nothing else gets CORS
# headers; the desktop web build is same-origin and needs none.
# Added before the auth middleware, which makes auth the outer layer: every
# request, preflights included, must pass both checks before CORS answers.
CORS_ORIGINS = ["https://localhost"]


class AllowlistCORS(CORSMiddleware):
    """Starlette's CORS, except that a preflight from an unlisted origin gets
    a bare 400 with no CORS headers at all, not even the allowed methods."""

    def preflight_response(self, request_headers: Headers) -> PlainTextResponse:
        if not self.is_allowed_origin(request_headers["origin"]):
            return PlainTextResponse("Disallowed CORS origin", status_code=400)
        return super().preflight_response(request_headers)


app.add_middleware(
    AllowlistCORS,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Accept"],
    max_age=600,
)
app.middleware("http")(require_identity)


@app.get("/api/health")
def health() -> JSONResponse:
    """Used by Docker's healthcheck and the hello page. 503 when the db doesn't answer."""
    try:
        with get_sessionmaker()() as session:
            session.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return JSONResponse({"status": "error", "database": "down"}, status_code=503)
    return JSONResponse({"status": "ok", "database": "ok"})


for r in (me.router, exercises.router, workouts.router, imports.router, routines.router):
    app.include_router(r)


# The signed Android app, published by scripts/android-publish.sh into
# data/apk, mounted read-only. Behind the auth middleware like everything else.
APK_DIR = Path("/apk")


def _no_apk() -> JSONResponse:
    return JSONResponse({"detail": {"code": "no_apk"}}, status_code=404)


@app.get("/api/app/latest")
def app_latest() -> JSONResponse:
    """Version info for the newest published APK, for the /download page."""
    try:
        info = json.loads((APK_DIR / "version.json").read_text())
    except (OSError, ValueError):
        return _no_apk()
    return JSONResponse(info, headers={"Cache-Control": "no-store"})


@app.get("/api/app/liftlog.apk", response_model=None)
def app_apk() -> FileResponse | JSONResponse:
    path = APK_DIR / "liftlog.apk"
    if not path.is_file():
        return _no_apk()
    return FileResponse(
        path,
        media_type="application/vnd.android.package-archive",
        filename="liftlog.apk",
        headers={"Cache-Control": "no-store"},
    )
