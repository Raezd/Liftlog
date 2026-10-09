export type WeightUnit = "lb" | "kg";
export type DistanceUnit = "mi" | "km";

export type Me = {
  login: string;
  id: string;
  display_name: string;
  timezone: string;
  weight_unit: WeightUnit;
  distance_unit: DistanceUnit;
  play_through_silent: boolean;
};

export type Muscle = { id: string; label: string };

export type Equipment = "barbell" | "dumbbell" | "machine" | "cable" | "bodyweight" | "other";
export type LoggingType =
  | "weight_reps" | "bodyweight_reps" | "weighted_bodyweight" | "assisted_bodyweight" | "duration" | "distance_duration";

export type Exercise = {
  id: string;
  name: string;
  catalog_id: string | null;
  equipment: Equipment;
  logging_type: LoggingType;
  primary_muscles: string[];
  secondary_muscles: string[];
  needs_review: boolean;
  archived: boolean;
};

export type MuscleMap = { primary: string[]; secondary: string[] };
export type ExerciseDetail = Exercise & { muscle_history: { changed_at: string; old: MuscleMap; new: MuscleMap }[] };

export type CatalogEntry = {
  id: string;
  name: string;
  category: string | null;
  equipment: Equipment;
  logging_type: LoggingType;
  primary_muscles: string[];
  secondary_muscles: string[];
  /** The dataset tagged it shoulders: delts are a suggestion to confirm. */
  shoulders: boolean;
  /** Where shoulders sat in the dataset, so chosen delts go to the same list. */
  shoulders_role: "primary" | "secondary" | null;
  score?: number;
};

export type WorkoutSummary = {
  id: string;
  title: string;
  workout_date: string;
  started_at: string;
  ended_at: string | null;
  source: "liftlog" | "hevy_import";
  exercise_count: number;
  set_count: number;
};

export type SetType = "normal" | "warmup" | "drop" | "failure";

export type WorkoutSet = {
  id: string;
  position: number;
  set_type: SetType;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  reps: number | null;
  rpe: string | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: DistanceUnit | "m" | null;
};

export type WorkoutDetail = Omit<WorkoutSummary, "exercise_count" | "set_count"> & {
  notes: string;
  exercises: {
    id: string;
    exercise_id: string;
    name: string;
    logged_name: string;
    position: number;
    superset_group: number | null;
    notes: string;
    sets: WorkoutSet[];
  }[];
};

export type Counts = { workouts: number; sets: number };

export type TitleReview = {
  title: string;
  sets: number;
  mapped_to: { id: string; name: string } | null;
  suggestions?: CatalogEntry[];
  user_matches?: { id: string; name: string }[];
  logging_type?: LoggingType;
  equipment?: Equipment;
};

export type ImportPreview = {
  file_sha256: string;
  rows: number;
  weight_unit: WeightUnit;
  distance_unit: DistanceUnit;
  first_date: string;
  last_date: string;
  total: Counts;
  new: Counts;
  skipped: Counts;
  conflicting: Counts;
  conflicts: { title: string; start: string }[];
  titles: TitleReview[];
  unresolved: number;
};

export type ImportResult = {
  id: string;
  created_at: string;
  added: Counts;
  skipped: Counts;
  conflicting: Counts;
};
