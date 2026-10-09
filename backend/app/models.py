"""Database models. Every table a user owns carries user_id (directly or
through its workout), and every query filters on it: see app/users.py.

Primary keys are UUIDv7. Clients may supply their own (offline sync, Spec 5);
the server makes them for imports and anything else it creates.
"""

from __future__ import annotations

import datetime as dt
import os
import time
import uuid
from decimal import Decimal

from sqlalchemy import (
    ARRAY, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, Text,
    UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7: 48-bit Unix milliseconds, then random bits."""
    ms = time.time_ns() // 1_000_000
    b = bytearray(ms.to_bytes(6, "big") + os.urandom(10))
    b[6] = 0x70 | (b[6] & 0x0F)
    b[8] = 0x80 | (b[8] & 0x3F)
    return uuid.UUID(bytes=bytes(b))


class Base(DeclarativeBase):
    pass


def _id() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid7)


def _created() -> Mapped[dt.datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Muscle(Base):
    __tablename__ = "muscles"
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    sort: Mapped[int] = mapped_column(Integer, nullable=False)


class CatalogExercise(Base):
    """free-exercise-db, as published. Read-only: a trigger rejects writes."""
    __tablename__ = "catalog_exercises"
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    force: Mapped[str | None] = mapped_column(Text)
    level: Mapped[str | None] = mapped_column(Text)
    mechanic: Mapped[str | None] = mapped_column(Text)
    equipment: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    # The dataset's own muscle words, unchanged ("shoulders", "middle back").
    primary_muscles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    secondary_muscles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    instructions: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _id()
    login: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="America/Los_Angeles")
    weight_unit: Mapped[str] = mapped_column(Text, nullable=False, server_default="lb")
    distance_unit: Mapped[str] = mapped_column(Text, nullable=False, server_default="mi")
    # Rest timer alert plays through silent and vibrate (rest-timer-alarm-v1).
    play_through_silent: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[dt.datetime] = _created()
    __table_args__ = (
        CheckConstraint("weight_unit IN ('lb', 'kg')", name="ck_users_weight_unit"),
        CheckConstraint("distance_unit IN ('mi', 'km')", name="ck_users_distance_unit"),
    )


EQUIPMENT_CHECK = "equipment IN ('barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other')"
LOGGING_CHECK = ("logging_type IN ('weight_reps', 'bodyweight_reps', 'weighted_bodyweight', "
                 "'assisted_bodyweight', 'duration', 'distance_duration')")


class UserExercise(Base):
    """A user's own exercise: a copy of a catalog entry (catalog_id set) or custom."""
    __tablename__ = "user_exercises"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    catalog_id: Mapped[str | None] = mapped_column(ForeignKey("catalog_exercises.id"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    equipment: Mapped[str] = mapped_column(Text, nullable=False)
    logging_type: Mapped[str] = mapped_column(Text, nullable=False)
    primary_muscles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    secondary_muscles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default="{}")
    needs_review: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[dt.datetime] = _created()
    __table_args__ = (
        CheckConstraint(EQUIPMENT_CHECK, name="ck_user_exercises_equipment"),
        CheckConstraint(LOGGING_CHECK, name="ck_user_exercises_logging_type"),
        CheckConstraint("btrim(name) <> ''", name="ck_user_exercises_name"),
        Index("uq_user_exercises_name", "user_id", text("lower(name)"), unique=True),
        Index("uq_user_exercises_catalog", "user_id", "catalog_id", unique=True,
              postgresql_where=text("catalog_id IS NOT NULL")),
    )


class MuscleMapChange(Base):
    """Every edit to an exercise's muscles. Reports use the current map; this is the record."""
    __tablename__ = "muscle_map_changes"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    exercise_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_exercises.id", ondelete="CASCADE"), nullable=False)
    changed_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    old_map: Mapped[dict] = mapped_column(JSONB, nullable=False)
    new_map: Mapped[dict] = mapped_column(JSONB, nullable=False)
    __table_args__ = (Index("ix_muscle_map_changes_exercise", "exercise_id", "changed_at"),)


class Import(Base):
    """One run of an importer. The file itself is never stored."""
    __tablename__ = "imports"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    file_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[dt.datetime] = _created()
    workouts_added: Mapped[int] = mapped_column(Integer, nullable=False)
    sets_added: Mapped[int] = mapped_column(Integer, nullable=False)
    workouts_skipped: Mapped[int] = mapped_column(Integer, nullable=False)
    sets_skipped: Mapped[int] = mapped_column(Integer, nullable=False)
    workouts_conflicting: Mapped[int] = mapped_column(Integer, nullable=False)
    sets_conflicting: Mapped[int] = mapped_column(Integer, nullable=False)
    __table_args__ = (
        CheckConstraint("source IN ('hevy')", name="ck_imports_source"),
        Index("ix_imports_user", "user_id", "created_at"),
    )


class HevyTitleMapping(Base):
    """A Hevy exercise title resolved to one of the user's exercises, so later imports don't ask again."""
    __tablename__ = "hevy_title_mappings"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    hevy_title: Mapped[str] = mapped_column(Text, nullable=False)
    exercise_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_exercises.id"), nullable=False)
    created_at: Mapped[dt.datetime] = _created()
    __table_args__ = (UniqueConstraint("user_id", "hevy_title", name="uq_hevy_title_mappings"),)


class Workout(Base):
    __tablename__ = "workouts"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    # Computed at save from the user's timezone with the 4 AM rollover (app/dates.py).
    workout_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    source: Mapped[str] = mapped_column(Text, nullable=False)
    import_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("imports.id"))
    # Hevy dedupe: start time (to the minute) plus title, unique per user.
    import_key: Mapped[str | None] = mapped_column(Text)
    # SHA-256 of the workout's rows as imported, to tell a re-import from a changed workout.
    import_hash: Mapped[str | None] = mapped_column(Text)
    # The routine version this workout started from (Spec 5). Null for imports.
    routine_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("routine_versions.id", ondelete="RESTRICT"))
    created_at: Mapped[dt.datetime] = _created()
    exercises: Mapped[list[WorkoutExercise]] = relationship(
        order_by="WorkoutExercise.position", cascade="all, delete-orphan")
    __table_args__ = (
        CheckConstraint("source IN ('liftlog', 'hevy_import')", name="ck_workouts_source"),
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ck_workouts_times"),
        CheckConstraint("(source = 'hevy_import') = (import_key IS NOT NULL)", name="ck_workouts_import_key"),
        Index("uq_workouts_import_key", "user_id", "import_key", unique=True,
              postgresql_where=text("import_key IS NOT NULL")),
        Index("ix_workouts_user_started", "user_id", "started_at"),
    )


class WorkoutExercise(Base):
    __tablename__ = "workout_exercises"
    id: Mapped[uuid.UUID] = _id()
    workout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workouts.id", ondelete="CASCADE"), nullable=False)
    exercise_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_exercises.id"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    superset_group: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    # The name when it was logged. Display uses the exercise's current name.
    logged_name: Mapped[str] = mapped_column(Text, nullable=False)
    sets: Mapped[list[Set]] = relationship(order_by="Set.position", cascade="all, delete-orphan")
    __table_args__ = (
        UniqueConstraint("workout_id", "position", name="uq_workout_exercises_position"),
        Index("ix_workout_exercises_exercise", "exercise_id"),
    )


class Set(Base):
    __tablename__ = "sets"
    id: Mapped[uuid.UUID] = _id()
    workout_exercise_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workout_exercises.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    set_type: Mapped[str] = mapped_column(Text, nullable=False, server_default="normal")
    # Exactly as entered, plus the unit, plus kg for math. For assisted
    # bodyweight this is the assistance.
    weight_value: Mapped[Decimal | None] = mapped_column(Numeric)
    weight_unit: Mapped[str | None] = mapped_column(Text)
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    reps: Mapped[int | None] = mapped_column(Integer)
    rpe: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    distance_value: Mapped[Decimal | None] = mapped_column(Numeric)
    distance_unit: Mapped[str | None] = mapped_column(Text)
    distance_m: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("workout_exercise_id", "position", name="uq_sets_position"),
        CheckConstraint("set_type IN ('normal', 'warmup', 'drop', 'failure')", name="ck_sets_type"),
        CheckConstraint(
            "(weight_value IS NULL AND weight_unit IS NULL AND weight_kg IS NULL) OR "
            "(weight_value >= 0 AND weight_unit IN ('lb', 'kg') AND weight_kg IS NOT NULL)",
            name="ck_sets_weight"),
        CheckConstraint(
            "(distance_value IS NULL AND distance_unit IS NULL AND distance_m IS NULL) OR "
            "(distance_value >= 0 AND distance_unit IN ('mi', 'km', 'm') AND distance_m IS NOT NULL)",
            name="ck_sets_distance"),
        CheckConstraint("reps IS NULL OR reps >= 0", name="ck_sets_reps"),
        CheckConstraint("duration_seconds IS NULL OR duration_seconds >= 0", name="ck_sets_duration"),
        CheckConstraint("rpe IS NULL OR (rpe BETWEEN 6 AND 10 AND rpe * 2 = trunc(rpe * 2))", name="ck_sets_rpe"),
    )


class WorkoutChange(Base):
    """Finished workouts are never updated in place. Any edit (Spec 5 and
    later) writes the before and after here."""
    __tablename__ = "workout_changes"
    id: Mapped[uuid.UUID] = _id()
    workout_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workouts.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    changed_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    before: Mapped[dict] = mapped_column(JSONB, nullable=False)
    after: Mapped[dict] = mapped_column(JSONB, nullable=False)
    __table_args__ = (Index("ix_workout_changes_workout", "workout_id", "changed_at"),)


SET_TYPE_CHECK = "set_type IN ('normal', 'warmup', 'drop', 'failure')"


class RoutineFolder(Base):
    """A program, like "Upper/Lower". Holds routines (days) in a user-set order."""
    __tablename__ = "routine_folders"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[dt.datetime] = _created()
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="ck_routine_folders_name"),
        Index("ix_routine_folders_user", "user_id", "position"),
    )


class Routine(Base):
    """One day, like "Day 4: Deadlift", in a folder or on its own. Its content
    lives in immutable versions; current_version_id points at the latest."""
    __tablename__ = "routines"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    folder_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("routine_folders.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("routine_versions.id", name="fk_routines_current_version", use_alter=True))
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[dt.datetime] = _created()
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="ck_routines_name"),
        Index("ix_routines_user", "user_id", "folder_id", "position"),
    )


class RoutineVersion(Base):
    """Immutable once written (a trigger rejects updates, here and on its
    exercises and sets). Every save makes a new one and deletes the one it
    replaced, unless a workout references it (workouts.routine_version_id,
    ON DELETE RESTRICT)."""
    __tablename__ = "routine_versions"
    id: Mapped[uuid.UUID] = _id()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    routine_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("routines.id", ondelete="CASCADE"), nullable=False)
    # 1, 2, 3... per routine, for display.
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    # The version this one was edited from. A save whose parent isn't current is a
    # conflict. No foreign key: the parent is usually pruned once this one is saved.
    parent_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Superset group (as a string) -> rest seconds after each round.
    superset_rests: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[dt.datetime] = _created()
    exercises: Mapped[list[RoutineExercise]] = relationship(
        order_by="RoutineExercise.position", cascade="all, delete-orphan", passive_deletes=True)
    __table_args__ = (UniqueConstraint("routine_id", "number", name="uq_routine_versions_number"),)


class RoutineExercise(Base):
    __tablename__ = "routine_exercises"
    id: Mapped[uuid.UUID] = _id()
    version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("routine_versions.id", ondelete="CASCADE"), nullable=False)
    exercise_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("user_exercises.id"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    # Up to three adjacent exercises share a group. Numbered 0, 1, 2... per version.
    superset_group: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    rest_seconds: Mapped[int | None] = mapped_column(Integer)
    sets: Mapped[list[RoutineSet]] = relationship(
        order_by="RoutineSet.position", cascade="all, delete-orphan", passive_deletes=True)
    __table_args__ = (
        UniqueConstraint("version_id", "position", name="uq_routine_exercises_position"),
        CheckConstraint("rest_seconds IS NULL OR rest_seconds BETWEEN 0 AND 3600", name="ck_routine_exercises_rest"),
        Index("ix_routine_exercises_exercise", "exercise_id"),
    )


class RoutineSet(Base):
    """Per-set targets. Every target is optional. Reps are a range; a fixed
    number has reps_min = reps_max."""
    __tablename__ = "routine_sets"
    id: Mapped[uuid.UUID] = _id()
    routine_exercise_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("routine_exercises.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    set_type: Mapped[str] = mapped_column(Text, nullable=False, server_default="normal")
    reps_min: Mapped[int | None] = mapped_column(Integer)
    reps_max: Mapped[int | None] = mapped_column(Integer)
    weight_value: Mapped[Decimal | None] = mapped_column(Numeric)
    weight_unit: Mapped[str | None] = mapped_column(Text)
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    rpe: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    distance_value: Mapped[Decimal | None] = mapped_column(Numeric)
    distance_unit: Mapped[str | None] = mapped_column(Text)
    distance_m: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    __table_args__ = (
        UniqueConstraint("routine_exercise_id", "position", name="uq_routine_sets_position"),
        CheckConstraint(SET_TYPE_CHECK, name="ck_routine_sets_type"),
        CheckConstraint("(reps_min IS NULL AND reps_max IS NULL) OR (reps_min >= 0 AND reps_max >= reps_min)",
                        name="ck_routine_sets_reps"),
        CheckConstraint(
            "(weight_value IS NULL AND weight_unit IS NULL AND weight_kg IS NULL) OR "
            "(weight_value >= 0 AND weight_unit IN ('lb', 'kg') AND weight_kg IS NOT NULL)",
            name="ck_routine_sets_weight"),
        CheckConstraint(
            "(distance_value IS NULL AND distance_unit IS NULL AND distance_m IS NULL) OR "
            "(distance_value >= 0 AND distance_unit IN ('mi', 'km', 'm') AND distance_m IS NOT NULL)",
            name="ck_routine_sets_distance"),
        CheckConstraint("duration_seconds IS NULL OR duration_seconds >= 0", name="ck_routine_sets_duration"),
        CheckConstraint("rpe IS NULL OR (rpe BETWEEN 6 AND 10 AND rpe * 2 = trunc(rpe * 2))",
                        name="ck_routine_sets_rpe"),
    )
