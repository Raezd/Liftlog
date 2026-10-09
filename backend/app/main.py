from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.auth import require_identity
from app.db import get_sessionmaker

# Interactive API docs at /api/docs. Like every route, behind the auth middleware.
app = FastAPI(title="Liftlog", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
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


@app.get("/api/me")
def me(request: Request) -> dict:
    """The caller's Tailscale login, as checked by the auth middleware."""
    return {"login": request.state.login}
