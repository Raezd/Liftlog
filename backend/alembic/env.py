"""Alembic runs this to apply migrations. It reads DATABASE_URL directly so
migrations don't need the app's other secrets."""

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = create_engine(os.environ["DATABASE_URL"])
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        # Postgres runs DDL inside transactions, so a failed migration rolls
        # back completely and leaves the database exactly as it was.
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
