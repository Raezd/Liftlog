"""Editing and deleting finished workouts (Spec 6b).

Adds workouts.edit_revision (0 when stored, plus one for every change log
row) and workouts.deleted_at (a soft delete: the row stays, so its routine
version stays and a Hevy re-import still finds its key). Both change only
through edit_finished_workout(): a trigger rejects any other write to them,
even on a workout the current transaction created, and a new workout must
start at revision 0 and not deleted.

edit_finished_workout() now also sets deleted_at when the document has the
key, bumps edit_revision on every call, and refuses a workout that's already
deleted. Its snapshots carry both columns.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

# The function as 0007 wrote it, with the three changes marked.
EDIT_FUNCTION = """
    CREATE OR REPLACE FUNCTION edit_finished_workout(p_change_id uuid, p_workout_id uuid, p_reason text, p_after jsonb)
    RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE
        w workouts;
        before jsonb;
    BEGIN
        SELECT * INTO w FROM workouts WHERE id = p_workout_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'no workout %', p_workout_id USING ERRCODE = 'no_data_found';
        END IF;
        -- 0009: a deleted workout is never changed again.
        IF w.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'workout % is deleted', p_workout_id USING ERRCODE = 'no_data_found';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(coalesce(p_after->'exercises', '[]'::jsonb)) e
            WHERE NOT EXISTS (SELECT 1 FROM user_exercises u
                              WHERE u.id = (e->>'exercise_id')::uuid AND u.user_id = w.user_id)) THEN
            RAISE EXCEPTION 'exercise not found' USING ERRCODE = 'foreign_key_violation';
        END IF;
        before := workout_snapshot(p_workout_id);
        PERFORM set_config('liftlog.editing_workout', p_workout_id::text, true);

        UPDATE workouts SET
            title = coalesce(p_after->>'title', title),
            notes = coalesce(p_after->>'notes', notes),
            started_at = coalesce((p_after->>'started_at')::timestamptz, started_at),
            ended_at = coalesce((p_after->>'ended_at')::timestamptz, ended_at),
            workout_date = coalesce((p_after->>'workout_date')::date, workout_date),
            -- 0009: delete when asked, and count every change.
            deleted_at = coalesce((p_after->>'deleted_at')::timestamptz, deleted_at),
            edit_revision = edit_revision + 1
        WHERE id = p_workout_id;

        IF p_after ? 'exercises' THEN
            DELETE FROM workout_exercises WHERE workout_id = p_workout_id;
            INSERT INTO workout_exercises (id, workout_id, exercise_id, position, superset_group, notes,
                                           logged_name, rest_seconds)
            SELECT r.id, p_workout_id, r.exercise_id, r.position, r.superset_group, coalesce(r.notes, ''),
                   r.logged_name, r.rest_seconds
            FROM jsonb_populate_recordset(NULL::workout_exercises, p_after->'exercises') r;
            INSERT INTO sets (id, workout_exercise_id, position, set_type, weight_value, weight_unit, weight_kg,
                              reps, rpe, duration_seconds, distance_value, distance_unit, distance_m, completed_at)
            SELECT s.id, (e->>'id')::uuid, s.position, coalesce(s.set_type, 'normal'), s.weight_value,
                   s.weight_unit, s.weight_kg, s.reps, s.rpe, s.duration_seconds, s.distance_value,
                   s.distance_unit, s.distance_m, s.completed_at
            FROM jsonb_array_elements(p_after->'exercises') e,
                 jsonb_populate_recordset(NULL::sets, coalesce(e->'sets', '[]'::jsonb)) s;
        END IF;

        INSERT INTO workout_changes (id, workout_id, user_id, reason, before, after)
        VALUES (p_change_id, p_workout_id, w.user_id, p_reason, before, workout_snapshot(p_workout_id));
        PERFORM set_config('liftlog.editing_workout', '', true);
        RETURN p_change_id;
    END $$
"""


def upgrade() -> None:
    op.add_column("workouts", sa.Column("edit_revision", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("workouts", sa.Column("deleted_at", sa.DateTime(timezone=True)))
    op.create_check_constraint("ck_workouts_edit_revision", "workouts", "edit_revision >= 0")

    # The workouts_immutable trigger already guards finished workouts. This
    # one guards the two new columns on every workout, in progress or just
    # created too: only edit_finished_workout() moves them.
    op.execute("""
        CREATE FUNCTION workouts_edit_columns() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.edit_revision <> 0 OR NEW.deleted_at IS NOT NULL THEN
                    RAISE EXCEPTION 'a new workout starts unedited (workout %)', NEW.id
                        USING ERRCODE = 'restrict_violation';
                END IF;
            ELSIF (NEW.edit_revision IS DISTINCT FROM OLD.edit_revision
                   OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
                  AND coalesce(current_setting('liftlog.editing_workout', true), '') <> OLD.id::text THEN
                RAISE EXCEPTION 'edits and deletes go through edit_finished_workout() (workout %)', OLD.id
                    USING ERRCODE = 'restrict_violation';
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute("CREATE TRIGGER workouts_edit_columns BEFORE INSERT OR UPDATE ON workouts "
               "FOR EACH ROW EXECUTE FUNCTION workouts_edit_columns()")
    op.execute(EDIT_FUNCTION)


def downgrade() -> None:
    # Back to 0007's function (no deleted check, no revision).
    body = EDIT_FUNCTION
    for line in (
        "        -- 0009: a deleted workout is never changed again.\n"
        "        IF w.deleted_at IS NOT NULL THEN\n"
        "            RAISE EXCEPTION 'workout % is deleted', p_workout_id USING ERRCODE = 'no_data_found';\n"
        "        END IF;\n",
        ",\n            -- 0009: delete when asked, and count every change.\n"
        "            deleted_at = coalesce((p_after->>'deleted_at')::timestamptz, deleted_at),\n"
        "            edit_revision = edit_revision + 1",
    ):
        assert line in body
        body = body.replace(line, "")
    op.execute(body)
    op.execute("DROP TRIGGER workouts_edit_columns ON workouts")
    op.execute("DROP FUNCTION workouts_edit_columns()")
    op.drop_constraint("ck_workouts_edit_revision", "workouts", type_="check")
    op.drop_column("workouts", "deleted_at")
    op.drop_column("workouts", "edit_revision")
