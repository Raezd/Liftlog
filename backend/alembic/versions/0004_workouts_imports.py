"""Workouts, their exercises and sets, the workout change log, import
records, and saved Hevy title mappings.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-09
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def _user_fk() -> sa.Column:
    return sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)


def _now(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)


def upgrade() -> None:
    op.create_table(
        "imports",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("file_sha256", sa.Text(), nullable=False),
        _now("created_at"),
        sa.Column("workouts_added", sa.Integer(), nullable=False),
        sa.Column("sets_added", sa.Integer(), nullable=False),
        sa.Column("workouts_skipped", sa.Integer(), nullable=False),
        sa.Column("sets_skipped", sa.Integer(), nullable=False),
        sa.Column("workouts_conflicting", sa.Integer(), nullable=False),
        sa.Column("sets_conflicting", sa.Integer(), nullable=False),
        sa.CheckConstraint("source IN ('hevy')", name="ck_imports_source"),
    )
    op.create_index("ix_imports_user", "imports", ["user_id", "created_at"])

    op.create_table(
        "hevy_title_mappings",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("hevy_title", sa.Text(), nullable=False),
        sa.Column("exercise_id", sa.UUID(), sa.ForeignKey("user_exercises.id"), nullable=False),
        _now("created_at"),
        sa.UniqueConstraint("user_id", "hevy_title", name="uq_hevy_title_mappings"),
    )

    op.create_table(
        "workouts",
        sa.Column("id", sa.UUID(), primary_key=True),
        _user_fk(),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("workout_date", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("import_id", sa.UUID(), sa.ForeignKey("imports.id")),
        sa.Column("import_key", sa.Text()),
        sa.Column("import_hash", sa.Text()),
        _now("created_at"),
        sa.CheckConstraint("source IN ('liftlog', 'hevy_import')", name="ck_workouts_source"),
        sa.CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ck_workouts_times"),
        sa.CheckConstraint("(source = 'hevy_import') = (import_key IS NOT NULL)", name="ck_workouts_import_key"),
    )
    op.create_index("ix_workouts_user_started", "workouts", ["user_id", "started_at"])
    op.create_index("uq_workouts_import_key", "workouts", ["user_id", "import_key"], unique=True,
                    postgresql_where=sa.text("import_key IS NOT NULL"))

    op.create_table(
        "workout_exercises",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("workout_id", sa.UUID(), sa.ForeignKey("workouts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.UUID(), sa.ForeignKey("user_exercises.id"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("superset_group", sa.Integer()),
        sa.Column("notes", sa.Text(), server_default="", nullable=False),
        sa.Column("logged_name", sa.Text(), nullable=False),
        sa.UniqueConstraint("workout_id", "position", name="uq_workout_exercises_position"),
    )
    op.create_index("ix_workout_exercises_exercise", "workout_exercises", ["exercise_id"])

    op.create_table(
        "sets",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("workout_exercise_id", sa.UUID(), sa.ForeignKey("workout_exercises.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("set_type", sa.Text(), server_default="normal", nullable=False),
        sa.Column("weight_value", sa.Numeric()),
        sa.Column("weight_unit", sa.Text()),
        sa.Column("weight_kg", sa.Numeric(12, 4)),
        sa.Column("reps", sa.Integer()),
        sa.Column("rpe", sa.Numeric(3, 1)),
        sa.Column("duration_seconds", sa.Integer()),
        sa.Column("distance_value", sa.Numeric()),
        sa.Column("distance_unit", sa.Text()),
        sa.Column("distance_m", sa.Numeric(12, 3)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("workout_exercise_id", "position", name="uq_sets_position"),
        sa.CheckConstraint("set_type IN ('normal', 'warmup', 'drop', 'failure')", name="ck_sets_type"),
        sa.CheckConstraint(
            "(weight_value IS NULL AND weight_unit IS NULL AND weight_kg IS NULL) OR "
            "(weight_value >= 0 AND weight_unit IN ('lb', 'kg') AND weight_kg IS NOT NULL)",
            name="ck_sets_weight"),
        sa.CheckConstraint(
            "(distance_value IS NULL AND distance_unit IS NULL AND distance_m IS NULL) OR "
            "(distance_value >= 0 AND distance_unit IN ('mi', 'km', 'm') AND distance_m IS NOT NULL)",
            name="ck_sets_distance"),
        sa.CheckConstraint("reps IS NULL OR reps >= 0", name="ck_sets_reps"),
        sa.CheckConstraint("duration_seconds IS NULL OR duration_seconds >= 0", name="ck_sets_duration"),
        sa.CheckConstraint("rpe IS NULL OR (rpe BETWEEN 6 AND 10 AND rpe * 2 = trunc(rpe * 2))", name="ck_sets_rpe"),
    )

    op.create_table(
        "workout_changes",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("workout_id", sa.UUID(), sa.ForeignKey("workouts.id"), nullable=False),
        _user_fk(),
        _now("changed_at"),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("before", postgresql.JSONB(), nullable=False),
        sa.Column("after", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_workout_changes_workout", "workout_changes", ["workout_id", "changed_at"])


def downgrade() -> None:
    op.drop_table("workout_changes")
    op.drop_table("sets")
    op.drop_table("workout_exercises")
    op.drop_table("workouts")
    op.drop_table("hevy_title_mappings")
    op.drop_table("imports")
