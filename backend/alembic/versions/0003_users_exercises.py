"""Users, their exercises, and the muscle-map change log.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-09
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("login", sa.Text(), nullable=False, unique=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("timezone", sa.Text(), server_default="America/Los_Angeles", nullable=False),
        sa.Column("weight_unit", sa.Text(), server_default="lb", nullable=False),
        sa.Column("distance_unit", sa.Text(), server_default="mi", nullable=False),
        sa.Column("play_through_silent", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("weight_unit IN ('lb', 'kg')", name="ck_users_weight_unit"),
        sa.CheckConstraint("distance_unit IN ('mi', 'km')", name="ck_users_distance_unit"),
    )
    op.create_table(
        "user_exercises",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("catalog_id", sa.Text(), sa.ForeignKey("catalog_exercises.id")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("equipment", sa.Text(), nullable=False),
        sa.Column("logging_type", sa.Text(), nullable=False),
        sa.Column("primary_muscles", sa.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("secondary_muscles", sa.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("needs_review", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_user_exercises_name"),
        sa.CheckConstraint("equipment IN ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other')",
                           name="ck_user_exercises_equipment"),
        sa.CheckConstraint("logging_type IN ('weight_reps', 'bodyweight_reps', 'weighted_bodyweight', "
                           "'assisted_bodyweight', 'duration', 'distance_duration')",
                           name="ck_user_exercises_logging_type"),
    )
    op.create_index("uq_user_exercises_name", "user_exercises", ["user_id", sa.literal_column("lower(name)")],
                    unique=True)
    op.create_index("uq_user_exercises_catalog", "user_exercises", ["user_id", "catalog_id"], unique=True,
                    postgresql_where=sa.text("catalog_id IS NOT NULL"))
    op.create_table(
        "muscle_map_changes",
        sa.Column("id", sa.UUID(), primary_key=True),
        sa.Column("user_id", sa.UUID(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.UUID(), sa.ForeignKey("user_exercises.id", ondelete="CASCADE"), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("old_map", postgresql.JSONB(), nullable=False),
        sa.Column("new_map", postgresql.JSONB(), nullable=False),
    )
    op.create_index("ix_muscle_map_changes_exercise", "muscle_map_changes", ["exercise_id", "changed_at"])


def downgrade() -> None:
    op.drop_table("muscle_map_changes")
    op.drop_table("user_exercises")
    op.drop_table("users")
