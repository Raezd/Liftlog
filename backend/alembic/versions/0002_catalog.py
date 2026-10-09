"""Exercise catalog (free-exercise-db) and the muscle vocabulary.

Loads app/seed/free-exercise-db/exercises.json (pinned commit, see SOURCE.md
there) into catalog_exercises, which a trigger then keeps read-only. The
vocabulary is the dataset's muscle groups, read from the same file, with
shoulders split into front, side, and rear delts.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-09
"""

import json
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

DATASET = Path(__file__).resolve().parents[2] / "app" / "seed" / "free-exercise-db" / "exercises.json"
DELTS = [("front_delts", "Front delts"), ("side_delts", "Side delts"), ("rear_delts", "Rear delts")]


def upgrade() -> None:
    catalog = op.create_table(
        "catalog_exercises",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("force", sa.Text()),
        sa.Column("level", sa.Text()),
        sa.Column("mechanic", sa.Text()),
        sa.Column("equipment", sa.Text()),
        sa.Column("category", sa.Text()),
        sa.Column("primary_muscles", sa.ARRAY(sa.Text()), nullable=False),
        sa.Column("secondary_muscles", sa.ARRAY(sa.Text()), nullable=False),
        sa.Column("instructions", sa.ARRAY(sa.Text()), nullable=False),
    )
    muscles = op.create_table(
        "muscles",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False),
    )

    data = json.loads(DATASET.read_text(encoding="utf-8"))
    op.bulk_insert(catalog, [{
        "id": e["id"], "name": e["name"], "force": e.get("force"), "level": e.get("level"),
        "mechanic": e.get("mechanic"), "equipment": e.get("equipment"), "category": e.get("category"),
        "primary_muscles": e["primaryMuscles"], "secondary_muscles": e["secondaryMuscles"],
        "instructions": e.get("instructions") or [],
    } for e in data])

    found = {m.strip() for e in data for m in e["primaryMuscles"] + e["secondaryMuscles"]}
    vocab = {m.lower().replace(" ", "_"): m.capitalize() for m in found if m.lower() != "shoulders"}
    vocab.update(DELTS)
    op.bulk_insert(muscles, [{"id": k, "label": v, "sort": i}
                             for i, (k, v) in enumerate(sorted(vocab.items(), key=lambda kv: kv[1]))])

    # Read-only from here on. A newer dataset arrives as a new migration that
    # drops this trigger, reloads, and puts it back.
    op.execute("""
        CREATE FUNCTION catalog_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'catalog_exercises is read-only';
        END $$
    """)
    op.execute("""
        CREATE TRIGGER catalog_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
        ON catalog_exercises FOR EACH STATEMENT EXECUTE FUNCTION catalog_read_only()
    """)


def downgrade() -> None:
    op.drop_table("muscles")
    op.drop_table("catalog_exercises")
    op.execute("DROP FUNCTION catalog_read_only()")
