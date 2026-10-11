"""Body measurements: sites, check-ins, and values, all per user, plus the
length unit setting (in or cm, default in).

- measure_sites: the user's places to measure. The standard ones are seeded
  on first use (app/body.py, users.body_seeded); users add custom ones. A
  paired site (arms, thighs) takes a left and a right value. A site with
  values can't be deleted (RESTRICT from measure_values), only archived.
- measure_checkins: one per user per date. Optional body fat, which always
  has a method, and notes.
- measure_values: one per site (and side) per check-in. The value as
  entered, its unit, and normalized cm, 1 to 300 cm with at most two
  decimals as entered.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

METHODS = "('calipers', 'smart_scale', 'dexa', 'navy_tape', 'visual', 'other')"


def _user_fk() -> sa.Column:
    return sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)


def _now() -> sa.Column:
    return sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    op.add_column("users", sa.Column("length_unit", sa.Text(), server_default="in", nullable=False))
    op.create_check_constraint("ck_users_length_unit", "users", "length_unit IN ('in', 'cm')")
    op.add_column("users", sa.Column("body_seeded", sa.Boolean(), server_default=sa.text("false"), nullable=False))

    op.create_table(
        "measure_sites",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("paired", sa.Boolean(), nullable=False),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        _now(),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_measure_sites_name"),
    )
    op.create_index("uq_measure_sites_name", "measure_sites", ["user_id", sa.literal_column("lower(name)")],
                    unique=True)

    op.create_table(
        "measure_checkins",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("body_fat_pct", sa.Numeric()),
        sa.Column("body_fat_method", sa.Text()),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        _now(),
        sa.UniqueConstraint("user_id", "date", name="uq_measure_checkins_date"),
        sa.CheckConstraint(
            "(body_fat_pct IS NULL AND body_fat_method IS NULL) OR "
            f"(body_fat_pct BETWEEN 1 AND 75 AND scale(body_fat_pct) <= 2 AND body_fat_method IS NOT NULL "
            f"AND body_fat_method IN {METHODS})",
            name="ck_measure_checkins_body_fat"),
    )

    op.create_table(
        "measure_values",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("checkin_id", sa.UUID(), sa.ForeignKey("measure_checkins.id", ondelete="CASCADE"), nullable=False),
        sa.Column("site_id", sa.UUID(), sa.ForeignKey("measure_sites.id", ondelete="RESTRICT"), nullable=False),
        # left or right on a paired site, null on a single one.
        sa.Column("side", sa.Text()),
        sa.Column("value", sa.Numeric(), nullable=False),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("value_cm", sa.Numeric(9, 4), nullable=False),
        sa.CheckConstraint("side IS NULL OR side IN ('left', 'right')", name="ck_measure_values_side"),
        sa.CheckConstraint("unit IN ('in', 'cm') AND value > 0 AND scale(value) <= 2 "
                           "AND value_cm BETWEEN 1 AND 300", name="ck_measure_values_value"),
    )
    op.execute("ALTER TABLE measure_values ADD CONSTRAINT uq_measure_values_site "
               "UNIQUE NULLS NOT DISTINCT (checkin_id, site_id, side)")
    op.create_index("ix_measure_values_site", "measure_values", ["site_id"])


def downgrade() -> None:
    op.drop_table("measure_values")
    op.drop_table("measure_checkins")
    op.drop_table("measure_sites")
    op.drop_column("users", "body_seeded")
    op.drop_constraint("ck_users_length_unit", "users")
    op.drop_column("users", "length_unit")
