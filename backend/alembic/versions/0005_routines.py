"""Routines: folders (programs), routines (days), immutable routine versions,
their exercises and per-set targets. Workouts get routine_version_id so
Spec 5 can record which version a workout started from.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-09
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def _user_fk() -> sa.Column:
    return sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)


def _now(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "routine_folders",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        _now("created_at"),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_routine_folders_name"),
    )
    op.create_index("ix_routine_folders_user", "routine_folders", ["user_id", "position"])

    op.create_table(
        "routines",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("folder_id", sa.UUID(), sa.ForeignKey("routine_folders.id", ondelete="RESTRICT")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("current_version_id", sa.UUID()),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        _now("created_at"),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_routines_name"),
    )
    op.create_index("ix_routines_user", "routines", ["user_id", "folder_id", "position"])

    op.create_table(
        "routine_versions",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("routine_id", sa.UUID(), sa.ForeignKey("routines.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("parent_version_id", sa.UUID(), sa.ForeignKey("routine_versions.id")),
        sa.Column("superset_rests", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        _now("created_at"),
        sa.UniqueConstraint("routine_id", "number", name="uq_routine_versions_number"),
    )
    op.create_foreign_key("fk_routines_current_version", "routines", "routine_versions",
                          ["current_version_id"], ["id"])

    op.create_table(
        "routine_exercises",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("version_id", sa.UUID(), sa.ForeignKey("routine_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.UUID(), sa.ForeignKey("user_exercises.id"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("superset_group", sa.Integer()),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("rest_seconds", sa.Integer()),
        sa.UniqueConstraint("version_id", "position", name="uq_routine_exercises_position"),
        sa.CheckConstraint("rest_seconds IS NULL OR rest_seconds BETWEEN 0 AND 3600",
                           name="ck_routine_exercises_rest"),
    )
    op.create_index("ix_routine_exercises_exercise", "routine_exercises", ["exercise_id"])

    op.create_table(
        "routine_sets",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("routine_exercise_id", sa.UUID(), sa.ForeignKey("routine_exercises.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("set_type", sa.Text(), server_default="normal", nullable=False),
        sa.Column("reps_min", sa.Integer()),
        sa.Column("reps_max", sa.Integer()),
        sa.Column("weight_value", sa.Numeric()),
        sa.Column("weight_unit", sa.Text()),
        sa.Column("weight_kg", sa.Numeric(12, 4)),
        sa.Column("rpe", sa.Numeric(3, 1)),
        sa.Column("duration_seconds", sa.Integer()),
        sa.Column("distance_value", sa.Numeric()),
        sa.Column("distance_unit", sa.Text()),
        sa.Column("distance_m", sa.Numeric(12, 3)),
        sa.UniqueConstraint("routine_exercise_id", "position", name="uq_routine_sets_position"),
        sa.CheckConstraint("set_type IN ('normal', 'warmup', 'drop', 'failure')", name="ck_routine_sets_type"),
        sa.CheckConstraint(
            "(reps_min IS NULL AND reps_max IS NULL) OR (reps_min >= 0 AND reps_max >= reps_min)",
            name="ck_routine_sets_reps"),
        sa.CheckConstraint(
            "(weight_value IS NULL AND weight_unit IS NULL AND weight_kg IS NULL) OR "
            "(weight_value >= 0 AND weight_unit IN ('lb', 'kg') AND weight_kg IS NOT NULL)",
            name="ck_routine_sets_weight"),
        sa.CheckConstraint(
            "(distance_value IS NULL AND distance_unit IS NULL AND distance_m IS NULL) OR "
            "(distance_value >= 0 AND distance_unit IN ('mi', 'km', 'm') AND distance_m IS NOT NULL)",
            name="ck_routine_sets_distance"),
        sa.CheckConstraint("duration_seconds IS NULL OR duration_seconds >= 0", name="ck_routine_sets_duration"),
        sa.CheckConstraint("rpe IS NULL OR (rpe BETWEEN 6 AND 10 AND rpe * 2 = trunc(rpe * 2))",
                           name="ck_routine_sets_rpe"),
    )

    # A version never changes once written. Deleting (an unused routine) is fine.
    op.execute("""
        CREATE FUNCTION routine_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'routine versions are immutable (%)', TG_TABLE_NAME;
        END $$
    """)
    for t in ("routine_versions", "routine_exercises", "routine_sets"):
        op.execute(f"CREATE TRIGGER {t}_immutable BEFORE UPDATE ON {t} "
                   "FOR EACH ROW EXECUTE FUNCTION routine_version_immutable()")

    # Spec 5 fills this when a workout starts from a routine. RESTRICT keeps a
    # used routine from being deleted (the API archives those instead).
    op.add_column("workouts", sa.Column(
        "routine_version_id", sa.UUID(), sa.ForeignKey("routine_versions.id", ondelete="RESTRICT")))
    op.create_index("ix_workouts_routine_version", "workouts", ["routine_version_id"],
                    postgresql_where=sa.text("routine_version_id IS NOT NULL"))


def downgrade() -> None:
    op.drop_index("ix_workouts_routine_version", table_name="workouts")
    op.drop_column("workouts", "routine_version_id")
    for t in ("routine_versions", "routine_exercises", "routine_sets"):
        op.execute(f"DROP TRIGGER {t}_immutable ON {t}")
    op.execute("DROP FUNCTION routine_version_immutable()")
    op.drop_table("routine_sets")
    op.drop_table("routine_exercises")
    op.drop_constraint("fk_routines_current_version", "routines", type_="foreignkey")
    op.drop_table("routine_versions")
    op.drop_table("routines")
    op.drop_table("routine_folders")
