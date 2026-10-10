"""Gear for plate math (Spec 5b): bars, plate sets, and the plates in each
set, all per user. Each bar and plate keeps its weight as entered plus the
unit plus kg. A plate is on or off and has a pair count (null: unlimited).

Users get a default bar and plate set (seeded with presets on first use, see
app/gear.py, so both start null). Each user exercise gets a bar, a plate set
(null: the user's default; deleting a bar or plate set sets these back to
null), and plate_math, on for existing barbell exercises.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

WEIGHT = ("weight_value > 0 AND weight_value <= 2000 AND weight_unit IN ('lb', 'kg') "
          "AND scale(weight_value) <= 2")


def _user_fk() -> sa.Column:
    return sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)


def _weight() -> list[sa.Column]:
    return [
        sa.Column("weight_value", sa.Numeric(), nullable=False),
        sa.Column("weight_unit", sa.Text(), nullable=False),
        sa.Column("weight_kg", sa.Numeric(12, 4), nullable=False),
    ]


def _now() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "bars",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("name", sa.Text(), nullable=False),
        *_weight(),
        _now(),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_bars_name"),
        # A sled or a loading pin can weigh nothing.
        sa.CheckConstraint(WEIGHT.replace("weight_value > 0", "weight_value >= 0"), name="ck_bars_weight"),
    )
    op.create_index("ix_bars_user", "bars", ["user_id"])

    op.create_table(
        "plate_sets",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("name", sa.Text(), nullable=False),
        _now(),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_plate_sets_name"),
    )
    op.create_index("ix_plate_sets_user", "plate_sets", ["user_id"])

    op.create_table(
        "plates",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("plate_set_id", sa.UUID(), sa.ForeignKey("plate_sets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        *_weight(),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("pair_count", sa.Integer()),
        _now(),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_plates_name"),
        sa.CheckConstraint(WEIGHT, name="ck_plates_weight"),
        sa.CheckConstraint("pair_count IS NULL OR pair_count BETWEEN 1 AND 99", name="ck_plates_pair_count"),
    )
    op.create_index("ix_plates_set", "plates", ["plate_set_id"])

    op.add_column("users", sa.Column("default_bar_id", sa.UUID(), sa.ForeignKey(
        "bars.id", ondelete="SET NULL", name="fk_users_default_bar")))
    op.add_column("users", sa.Column("default_plate_set_id", sa.UUID(), sa.ForeignKey(
        "plate_sets.id", ondelete="SET NULL", name="fk_users_default_plate_set")))
    op.add_column("users", sa.Column("gear_seeded", sa.Boolean(), server_default=sa.text("false"), nullable=False))

    op.add_column("user_exercises", sa.Column("bar_id", sa.UUID(), sa.ForeignKey(
        "bars.id", ondelete="SET NULL", name="fk_user_exercises_bar")))
    op.add_column("user_exercises", sa.Column("plate_set_id", sa.UUID(), sa.ForeignKey(
        "plate_sets.id", ondelete="SET NULL", name="fk_user_exercises_plate_set")))
    op.add_column("user_exercises", sa.Column("plate_math", sa.Boolean(), server_default=sa.text("false"),
                                              nullable=False))
    op.execute("UPDATE user_exercises SET plate_math = true WHERE equipment = 'barbell'")


def downgrade() -> None:
    for c in ("plate_math", "plate_set_id", "bar_id"):
        op.drop_column("user_exercises", c)
    for c in ("gear_seeded", "default_plate_set_id", "default_bar_id"):
        op.drop_column("users", c)
    op.drop_table("plates")
    op.drop_table("plate_sets")
    op.drop_table("bars")
