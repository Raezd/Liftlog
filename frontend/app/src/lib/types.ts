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
  /** Plate math: null bar or plate set means the user's default. */
  bar_id: string | null;
  plate_set_id: string | null;
  plate_math: boolean;
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
  completed_at: string | null;
};

export type WorkoutDetail = Omit<WorkoutSummary, "exercise_count" | "set_count"> & {
  notes: string;
  /** The routine version it started from, and that version's routine. Null for imports and empty workouts. */
  routine_version_id: string | null;
  routine_id: string | null;
  /** The routine's name and the version's number and save date. Missing in copies saved before Spec 6. */
  routine_name?: string | null;
  routine_version_number?: number | null;
  routine_version_created_at?: string | null;
  exercises: {
    id: string;
    exercise_id: string;
    name: string;
    logged_name: string;
    position: number;
    superset_group: number | null;
    notes: string;
    rest_seconds: number | null;
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

export type RoutineSetT = {
  id: string;
  position: number;
  set_type: SetType;
  reps_min: number | null;
  reps_max: number | null;
  weight_value: string | null;
  weight_unit: WeightUnit | null;
  rpe: string | null;
  duration_seconds: number | null;
  distance_value: string | null;
  distance_unit: DistanceUnit | "m" | null;
};

export type RoutineVersion = {
  id: string;
  routine_id: string;
  number: number;
  parent_version_id: string | null;
  created_at: string;
  /** Superset group -> rest seconds after each round. */
  superset_rests: Record<string, number>;
  exercises: {
    id: string;
    exercise_id: string;
    name: string;
    logging_type: LoggingType;
    equipment: Equipment;
    position: number;
    superset_group: number | null;
    notes: string;
    rest_seconds: number | null;
    sets: RoutineSetT[];
  }[];
};

export type RoutineDetail = {
  id: string;
  name: string;
  folder_id: string | null;
  position: number;
  archived: boolean;
  used: boolean;
  current_version: RoutineVersion;
};

export type RoutineSummary = {
  id: string;
  name: string;
  folder_id: string | null;
  position: number;
  archived: boolean;
  used: boolean;
  current_version_id: string;
  exercise_names: string[];
  set_count: number;
};

export type Folder = { id: string; name: string; position: number; archived: boolean; used: boolean; routines: RoutineSummary[] };

export type RoutineList = { folders: Folder[]; routines: RoutineSummary[] };

export type VersionSummary = {
  id: string; number: number; created_at: string; current: boolean;
  /** Your workouts that started from it, newest first. */
  workouts: { id: string; title: string; workout_date: string }[];
};

/** GET /api/offline: everything the phone keeps for offline use. */
export type OfflineCopy = {
  me: Me;
  exercises: Exercise[];
  /** Archived folders and routines included. */
  routines: RoutineList;
  /** Routine id -> its current version. */
  versions: Record<string, RoutineVersion>;
  /** Every workout, newest first. */
  workouts: WorkoutDetail[];
  /** Missing in copies saved before plate math. */
  gear?: Gear;
};

/** Plate math gear (GET /api/gear). Weights as entered plus unit plus kg. */
export type Bar = { id: string; name: string; weight_value: string; weight_unit: WeightUnit; weight_kg: string };
/** A plate size. Off plates are left out; null pairs is unlimited. */
export type Plate = Bar & { enabled: boolean; pair_count: number | null };
export type PlateSet = { id: string; name: string; plates: Plate[] };
export type Gear = { default_bar_id: string | null; default_plate_set_id: string | null; bars: Bar[]; plate_sets: PlateSet[] };
