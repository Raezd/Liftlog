"""Keep only routine versions that matter: the current one, and any a workout
started from. parent_version_id keeps its value (what an edit was based on)
but loses its foreign key, since the parent may be pruned.

workouts.routine_version_id (ON DELETE RESTRICT) already exists from 0005, so
a version a workout references can't be deleted.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-10
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("routine_versions_parent_version_id_fkey", "routine_versions", type_="foreignkey")
    # One-time prune of every non-current version no workout references.
    # Their exercises and sets go with them (ON DELETE CASCADE).
    op.execute("""
        DELETE FROM routine_versions v
        USING routines r
        WHERE v.routine_id = r.id
          AND v.id IS DISTINCT FROM r.current_version_id
          AND NOT EXISTS (SELECT 1 FROM workouts w WHERE w.routine_version_id = v.id)
    """)


def downgrade() -> None:
    # Pruned versions can't come back. NOT VALID keeps parent ids that point
    # at pruned versions while still checking new rows.
    op.execute("ALTER TABLE routine_versions ADD CONSTRAINT routine_versions_parent_version_id_fkey "
               "FOREIGN KEY (parent_version_id) REFERENCES routine_versions (id) NOT VALID")
