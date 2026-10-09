"""Workout sync (Spec 5a): finished workouts become immutable in Postgres.

Triggers reject UPDATE and DELETE on a finished workout (ended_at set), and
INSERT, UPDATE, and DELETE on its exercises and sets, with two exceptions:

- The transaction that created the workout (the upload, or a Hevy import)
  can still write it and its rows. An insert trigger adds the new workout's
  id to the transaction-local setting liftlog.new_workouts.
- edit_finished_workout(), which applies an edit and writes the matching
  workout_changes row. It signals the triggers through the transaction-local
  setting liftlog.editing_workout, set to the workout's id only while it runs.

Also adds workout_exercises.rest_seconds (the rest the exercise used, so the
next workout can default to it) and workouts.upload_hash (SHA-256 of the
upload, so a retried PUT with the same content is a no-op and different
content is a conflict).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workout_exercises", sa.Column("rest_seconds", sa.Integer()))
    op.create_check_constraint("ck_workout_exercises_rest", "workout_exercises",
                               "rest_seconds IS NULL OR rest_seconds BETWEEN 0 AND 3600")
    op.add_column("workouts", sa.Column("upload_hash", sa.Text()))

    # Remembers, for the rest of this transaction only, which workouts it created.
    op.execute("""
        CREATE FUNCTION workouts_note_new() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            PERFORM set_config('liftlog.new_workouts',
                               coalesce(current_setting('liftlog.new_workouts', true), '') || NEW.id::text || ',', true);
            RETURN NULL;
        END $$
    """)
    op.execute("CREATE TRIGGER workouts_note_new AFTER INSERT ON workouts "
               "FOR EACH ROW EXECUTE FUNCTION workouts_note_new()")
    # True when the workout can still be written: in progress, created in this
    # transaction, being edited by edit_finished_workout(), or already gone
    # (a cascade from a delete that was itself checked).
    op.execute("""
        CREATE FUNCTION workout_writable(wid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
            SELECT coalesce((
                SELECT w.ended_at IS NULL
                    OR position(wid::text || ',' IN coalesce(current_setting('liftlog.new_workouts', true), '')) > 0
                    OR coalesce(current_setting('liftlog.editing_workout', true), '') = wid::text
                FROM workouts w WHERE w.id = wid), true)
        $$
    """)
    op.execute("""
        CREATE FUNCTION workouts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT workout_writable(OLD.id) THEN
                RAISE EXCEPTION 'finished workouts are immutable (workout %)', OLD.id
                    USING ERRCODE = 'restrict_violation';
            END IF;
            RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END $$
    """)
    op.execute("""
        CREATE FUNCTION workout_exercises_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF (TG_OP <> 'INSERT' AND NOT workout_writable(OLD.workout_id))
               OR (TG_OP <> 'DELETE' AND NOT workout_writable(NEW.workout_id)) THEN
                RAISE EXCEPTION 'finished workouts are immutable (workout %)',
                    CASE WHEN TG_OP = 'DELETE' THEN OLD.workout_id ELSE NEW.workout_id END
                    USING ERRCODE = 'restrict_violation';
            END IF;
            RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END $$
    """)
    op.execute("""
        CREATE FUNCTION sets_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE
            old_w uuid;
            new_w uuid;
        BEGIN
            IF TG_OP <> 'INSERT' THEN
                SELECT workout_id INTO old_w FROM workout_exercises WHERE id = OLD.workout_exercise_id;
            END IF;
            IF TG_OP <> 'DELETE' THEN
                SELECT workout_id INTO new_w FROM workout_exercises WHERE id = NEW.workout_exercise_id;
            END IF;
            IF (old_w IS NOT NULL AND NOT workout_writable(old_w))
               OR (new_w IS NOT NULL AND NOT workout_writable(new_w)) THEN
                RAISE EXCEPTION 'finished workouts are immutable (workout %)', coalesce(new_w, old_w)
                    USING ERRCODE = 'restrict_violation';
            END IF;
            RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END $$
    """)
    op.execute("CREATE TRIGGER workouts_immutable BEFORE UPDATE OR DELETE ON workouts "
               "FOR EACH ROW EXECUTE FUNCTION workouts_immutable()")
    op.execute("CREATE TRIGGER workout_exercises_immutable BEFORE INSERT OR UPDATE OR DELETE ON workout_exercises "
               "FOR EACH ROW EXECUTE FUNCTION workout_exercises_immutable()")
    op.execute("CREATE TRIGGER sets_immutable BEFORE INSERT OR UPDATE OR DELETE ON sets "
               "FOR EACH ROW EXECUTE FUNCTION sets_immutable()")

    # A workout, its exercises, and their sets as one JSON document: the
    # before and after of each change log row.
    op.execute("""
        CREATE FUNCTION workout_snapshot(wid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
            SELECT to_jsonb(w) - 'upload_hash' || jsonb_build_object('exercises', coalesce((
                SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('sets', coalesce((
                    SELECT jsonb_agg(to_jsonb(s) ORDER BY s.position) FROM sets s
                    WHERE s.workout_exercise_id = e.id), '[]'::jsonb)) ORDER BY e.position)
                FROM workout_exercises e WHERE e.workout_id = w.id), '[]'::jsonb))
            FROM workouts w WHERE w.id = wid
        $$
    """)
    # The only way to change a finished workout. p_after is a snapshot-shaped
    # document: title, notes, started_at, ended_at, and workout_date replace
    # the workout's when present, and exercises (each with its sets), when
    # present, replace all of them. Writes the workout_changes row with the
    # before and after, in the same transaction. No endpoint calls it yet
    # (editing is Spec 6).
    op.execute("""
        CREATE FUNCTION edit_finished_workout(p_change_id uuid, p_workout_id uuid, p_reason text, p_after jsonb)
        RETURNS uuid LANGUAGE plpgsql AS $$
        DECLARE
            w workouts;
            before jsonb;
        BEGIN
            SELECT * INTO w FROM workouts WHERE id = p_workout_id FOR UPDATE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'no workout %', p_workout_id USING ERRCODE = 'no_data_found';
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
                workout_date = coalesce((p_after->>'workout_date')::date, workout_date)
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
    """)


def downgrade() -> None:
    op.execute("DROP FUNCTION edit_finished_workout(uuid, uuid, text, jsonb)")
    op.execute("DROP FUNCTION workout_snapshot(uuid)")
    for t in ("sets", "workout_exercises", "workouts"):
        op.execute(f"DROP TRIGGER {t}_immutable ON {t}")
        op.execute(f"DROP FUNCTION {t}_immutable()")
    op.execute("DROP FUNCTION workout_writable(uuid)")
    op.execute("DROP TRIGGER workouts_note_new ON workouts")
    op.execute("DROP FUNCTION workouts_note_new()")
    op.drop_column("workouts", "upload_hash")
    op.drop_constraint("ck_workout_exercises_rest", "workout_exercises", type_="check")
    op.drop_column("workout_exercises", "rest_seconds")
