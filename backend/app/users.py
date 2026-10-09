"""Who's calling, and the scoping rule every route follows.

The auth middleware has already checked the Tailscale login. The user row is
created on that login's first request. Every query on user data filters by
the caller's user id, and asking for someone else's object gets 404, exactly
like one that doesn't exist, so ids never reveal what exists.
"""

import uuid
from typing import Annotated, TypeVar

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import Base, User, uuid7

DbSession = Annotated[Session, Depends(get_session)]


def current_user(request: Request, session: DbSession) -> User:
    login = request.state.login
    user = session.scalar(select(User).where(User.login == login))
    if user is None:
        session.execute(insert(User).values(
            id=uuid7(), login=login, display_name=login.split("@")[0],
        ).on_conflict_do_nothing(index_elements=["login"]))
        session.commit()
        user = session.scalar(select(User).where(User.login == login))
    return user


CurrentUser = Annotated[User, Depends(current_user)]

M = TypeVar("M", bound=Base)


def not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, {"code": "not_found", "message": "Not found"})


def owned(session: Session, model: type[M], id: uuid.UUID, user: User) -> M:
    """The caller's own row, or 404. Never 403: another user's id looks missing."""
    row = session.get(model, id)
    if row is None or getattr(row, "user_id") != user.id:
        raise not_found()
    return row
