# Liftlog: instructions for Claude Code

Self-hosted workout tracker for a small household (Trav and his wife). Runs on the homelab via Docker Compose, beside Foodlog but fully separate from it, and is reachable only over Tailscale. Read `HANDOFF.md` for current state, deploy, backups, and restores. **Scope lives in `docs/v1-scope.md`.** If a request isn't in it, ask before building it.

## Product principles

From `docs/v1-scope.md`, which wins if the two ever disagree:

- **Standalone.** Own data, UI, Compose project, Postgres, and Tailscale hostname. Fully usable without Foodlog.
- **Private and per user.** Two users from day one, every row scoped per user on the server, identity keyed on the Tailscale login. All data is private in v1.
- **Offline-first.** Everything needed to run a workout lives on the device. Every tap writes to on-device storage immediately. Sync is opportunistic and never blocks logging.
- **History never silently changes.** Starting a workout snapshots the routine. Editing a finished workout is explicit and recorded.
- **Weights never drift.** Store the value and unit the user entered plus a normalized kg value. Default unit lb, per user.
- **Workout date** uses Foodlog's rule: the user's timezone plus the 4 AM rollover.
- **Honest numbers.** Estimates are labeled. "No data" is shown as no data, never zero.
- **Bodyweight and TDEE belong to Foodlog.** Never store bodyweight here, and never send exercise calories to Foodlog's energy math.
- **No public exposure.** Tailscale only, no open ports, two layers of identity checking.
- **Short, plain UI copy.** Plain American English, no developer text, no em dashes.

## Stack

- Backend: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Postgres 17 (`backend/`)
- Frontend: React 19, TypeScript, Vite, Tailwind, TanStack Query, React Router, lucide-react icons (`frontend/app/`). ECharts 6.1.0 (pinned, tree-shaken in `components/EChart.tsx`, adapted from Foodlog's; the two chart pages load it lazily). The Android client is a Capacitor shell around this build (from Spec 2); desktop uses the plain web build.
- Serving: Caddy (static files plus `/api` reverse proxy), Tailscale sidecar with Tailscale Serve for HTTPS
- Containers (`docker-compose.yml`, project `liftlog`): `tailscale` (hostname `liftlog`, `tag:liftlog`), `web` (Caddy, shares the tailscale network namespace, 127.0.0.1:8080), `backend` (FastAPI :8000), `db` (Postgres, internal network only)
- Foodlog (`~/foodlog`) is the reference for patterns. Read its code and copy what fits. Never import from it, share code with it, or change it from this repo.

## Security posture (non-negotiable)

1. **No published host ports.** The app is exposed only through Tailscale Serve on 443, Funnel off (`tailscale/serve.json`). Never add `ports:` to any service.
2. **Auth is two layers and must stay that way.** Caddy overwrites `X-Liftlog-Proxy` with `PROXY_SECRET`; the backend middleware (`app/auth.py`) checks it with `hmac.compare_digest`, then checks `Tailscale-User-Login` against `ALLOWED_LOGINS`. It runs on every route, so new routes are covered automatically. Never trust a client-supplied identity, and never add a route that skips the middleware.
3. **The backend and database have no internet.** Both sit on internal networks; only the Tailscale container has a route out.
4. **Secrets live in `.env`** (chmod 600, gitignored). Never commit `.env`, `data/`, or anything under `data/`. Never print secret values in output. Every variable is listed, without values, in `.env.example`. Off-site backup credentials are root-only files in `/etc/restic`: never read or print anything there, and never ask for key values; Trav handles those himself.
5. **No new external service or outbound dependency without Trav's approval first.** That includes CDNs, APIs, analytics, fonts, and anything the backend or browser would call out to. Fonts and assets are self-hosted.
6. **Every schema change is an Alembic migration** in `backend/alembic/versions/`, numbered sequentially (`0008` is the latest; next is `0009`). Migrations must upgrade and downgrade cleanly. Deploy with `scripts/deploy.sh`, which takes a pg_dump before the backend starts and migrates.
7. **Every query on user data is scoped to the caller.** Get the user with the `CurrentUser` dependency (`app/users.py`) and filter on `user_id`, or load by id with `owned()`. Another user's object answers **404, never 403**, so ids never reveal what exists. User B getting 404 on user A's exercises, workouts, and imports is tested (`tests/test_data.py`), on folders, routines, and versions (`tests/test_routines.py`), on workout uploads and the offline copy (`tests/test_workouts.py`), and on exports (`tests/test_export.py`: another user's workout is 404, full history holds only the caller's workouts, exercises, and gear); extend those tests when adding a new kind of user object.

## Data model

Primary keys are UUIDv7 (`models.uuid7()`). Clients may send their own ids (offline sync); the API accepts any UUIDv7, returns the existing row if it's already the caller's, and answers 409 if it belongs to someone else. Workout uploads differ: someone else's workout id is 404 (see Offline model and sync). The server makes ids for imports.

| Table | What |
|---|---|
| `catalog_exercises` | free-exercise-db, pinned commit, loaded by `0002` from `backend/app/seed/free-exercise-db/` (see `SOURCE.md` there; Unlicense). Read-only by trigger. Dataset muscle words unchanged. |
| `muscles` | The vocabulary: the dataset's muscle groups (spaces become underscores, `middle back` is `middle_back`), with `shoulders` replaced by `front_delts`, `side_delts`, `rear_delts`. |
| `users` | One per Tailscale login, made on the first request. Display name, timezone (default America/Los_Angeles), weight unit (lb), distance unit (mi), `play_through_silent` (off), `default_bar_id` and `default_plate_set_id` (plate math), `gear_seeded`. |
| `user_exercises` | A user's own exercises: a copy of a catalog entry (`catalog_id`) made the first time it's added or imported, or custom (no `catalog_id`). Name unique per user, case-insensitive. Equipment, logging type, primary and secondary muscle arrays (checked against `muscles` in `app/library.py`), `needs_review`, `archived`, and plate math: `bar_id` and `plate_set_id` (null means the user's default; ON DELETE SET NULL) and `plate_math` (on for barbell exercises when made). |
| `muscle_map_changes` | Every muscle edit: when, old map, new map. Reports always compute from the current map. |
| `workouts` | Title, `started_at`/`ended_at` (timestamptz, from the phone's clock), `workout_date` (computed at upload from `started_at`, `app/dates.py`: user's timezone, 4 AM rollover), notes, `source` (`liftlog` or `hevy_import`), `import_id`, for imports `import_key` (unique per user) and `import_hash`, for uploads `upload_hash`. Finished ones are immutable (see below). |
| `workout_exercises` | Position, `superset_group`, notes, `logged_name` (the name then; display uses the exercise's current name), `rest_seconds` (the rest it used; for a superset's first exercise, the rest after each round; null for imports). |
| `sets` | Position, `set_type` (normal, warmup, drop, failure), weight as entered (`weight_value`, exact numeric) plus `weight_unit` plus `weight_kg`, reps, RPE (6 to 10 in half steps), duration, distance as entered plus `distance_m`, `completed_at` (null for imports). For assisted bodyweight, weight is the assistance. Upload limits under Set field limits. |
| `workout_changes` | The record for edits to finished workouts (before, after, reason), written only by `edit_finished_workout()`. No edit endpoint or UI yet (Spec 6). |
| `imports` | One per import run: file SHA-256, time, workouts and sets added, skipped, conflicting. The CSV itself is never stored. |
| `hevy_title_mappings` | A Hevy exercise title resolved to one of the user's exercises, so later imports don't ask again. |
| `routine_folders` | A program ("Upper/Lower", "PPL"). Name, `position` (user order), `archived`. |
| `routines` | One day ("Day 4: Deadlift"), in a folder or not (`folder_id` null). Name, `position` within its folder, `archived`, `current_version_id`. |
| `routine_versions` | Immutable content of a routine: `number` (1, 2, 3 per routine), `parent_version_id` (the version it was edited from; a plain id with no foreign key, since that version is usually pruned), `superset_rests` (JSONB, group to seconds). Only the current version and versions a workout used are kept. |
| `routine_exercises` | Per version: position, user exercise, `superset_group` (up to three adjacent exercises, numbered 0, 1, 2 per version), notes, `rest_seconds`. |
| `routine_sets` | Per-set targets, all optional: `set_type`, `reps_min`/`reps_max` (equal for a fixed number), weight as entered plus unit plus kg, RPE, duration, distance as entered plus meters. |
| `bars` | A user's bars (or sleds): name, weight as entered plus unit plus kg (0 to 2,000, at most 2 decimals so plate math stays in whole hundredths; 0 is allowed for a sled). |
| `plate_sets` | A user's plate sets, by name. |
| `plates` | The plate sizes in a set: name (defaults to the weight, like "45 lb"), weight as entered plus unit plus kg (above 0), `enabled`, `pair_count` (1 to 99, null for unlimited). Deleted with their set. |

`workouts.routine_version_id` (null for imports and empty workouts; foreign key ON DELETE RESTRICT, added in `0005`) records the version a workout started from. The upload writes it. Workouts from the API (and in the offline copy) also carry `routine_name`, `routine_version_number`, and `routine_version_created_at`, so the detail page can name the version offline. `GET /api/routines/{id}/versions` lists, per version, the caller's workouts that used it (`workouts`: id, title, date, newest first); another user's routine is 404.

**Finished workouts are immutable in Postgres** (`0007`). Triggers reject UPDATE and DELETE on a workout with `ended_at` set, and INSERT, UPDATE, and DELETE on its `workout_exercises` and `sets`, with two exceptions: the transaction that created the workout (an insert trigger records its id in the transaction-local setting `liftlog.new_workouts`; that's how the upload and the Hevy import write their rows), and `edit_finished_workout(change_id, workout_id, reason, after)`, which applies `after` (a `workout_snapshot()`-shaped document: title, notes, times, date, and when present all exercises and sets) and writes the matching `workout_changes` row with the before and after, signalling the triggers through the transaction-local setting `liftlog.editing_workout`. Any future edit flow must go through that function. A hand-run `UPDATE` in psql is rejected. Deleting a user with finished workouts is refused too.

Copying a catalog exercise tagged shoulders turns shoulders into the delts its name suggests (`catalog.suggest_delts`: rear delt, reverse fly, face pull are rear; lateral or side raise is side; press and front raise are front) and sets `needs_review`. Saving the muscles (library edit, or "these delts are right" on the import screen) clears it.

## Hevy import

`app/hevy.py`, routes in `app/routers/imports.py`, page `src/pages/Import.tsx`. Parsing is adapted from Foodlog's importer (copied, not shared).

1. **Preview** (`POST /api/imports/hevy/preview`, the file): parses every row (any unreadable row rejects the whole file), detects lb or kg and mi or km from the column names, reads Hevy's zoneless times as the user's local time, groups each run of rows for the same exercise into one workout exercise, and classifies each workout by its key (start time to the minute plus title): new, skipped (key exists, same content hash), or conflicting (key exists, different content; never overwritten). It lists every exercise title in the new workouts that has no saved mapping, with the top three catalog matches and similar exercises of the user's.
2. **Review**: per title, accept a match, search the catalog, merge into an existing exercise, or make a custom one; confirm delts for shoulder exercises.
3. **Import** (`POST /api/imports/hevy`, the file again plus the choices): refuses with 422 and writes nothing unless every title is resolved, then creates the exercises, saves the title mappings, writes the import record and every new workout, and commits it all in one transaction.

Mapping: `superset_id` to superset group, `set_type` to ours (`dropset` to `drop`), `rpe`, `exercise_notes` (Hevy's literal `\n` becomes a line break), workout `description` to notes.

## Routines

Routes in `app/routers/routines.py`; pages `Routines.tsx`, `RoutineView.tsx` (`/routines/{id}`, read-only, with Edit), `RoutineEdit.tsx` (`/routines/{id}/edit`), `RoutineVersions.tsx`; save as routine is on `WorkoutView.tsx` and lands on the view page with a confirmation naming the folder.

- **Versioning and pruning.** Every save of a routine's content (`POST /api/routines/{id}/versions`) writes a new version and moves `current_version_id`. In the same transaction it deletes the version it replaced, unless a workout references it (`workouts.routine_version_id`). So a routine keeps its current version plus every version a workout used, and nothing else. Versions never change once written (a trigger rejects UPDATE), and Postgres refuses to delete one a workout references (RESTRICT). Renaming, moving, archiving, and reordering change the routine row only. `0006` pruned every existing non-current version once. Pruned versions can't be restored.
- **Conflicts.** A save sends `parent_version_id`. The check runs before pruning and compares it to the routine's current version: if it isn't current (including when that parent has since been pruned), the answer is 409 `version_conflict` and nothing is written or pruned; the editor offers to load the latest. Never overwrite. This is what makes offline editing (after v1) safe.
- **Ids.** Folder, routine, version, exercise, and set ids may come from the client (UUIDv7). A retry with the caller's own id returns the existing row; someone else's id is 409.
- **Delete or archive.** A routine or folder can be deleted only if no workout references any of its versions (`workouts.routine_version_id`); deleting a folder deletes its routines. Otherwise only archive (409 `in_use`; the RESTRICT foreign key refuses it in Postgres too). Restoring a routine restores its folder.
- **Supersets.** The API rejects a split group or more than three; a group of one is dropped. Save as routine splits a workout's groups into runs of three.
- **Superset move rules** (`frontend/app/src/lib/reorder.ts`, pure, tested in `frontend/app/tests/reorder.test.ts`; use it wherever exercises are reordered or removed, including the workout Overview): moving an exercise within its own superset keeps it in the group. Moving it past the group's first or last exercise takes it out; with the buttons, one step past an edge leaves the group and stays next to it. A lone exercise never lands inside another superset; it goes past the whole group. A whole superset moves as one unit from its header, by drag and by buttons. The rest after each round stays with the group's first exercise. Every move is announced to screen readers (`describeExercise`, `describeUnit`). Removing an exercise (`removeExercise`) keeps the rest of its superset grouped when two or more remain; a lone survivor becomes standalone. The editor's reorder mode is `components/ExerciseOrder.tsx`, also used by the workout Overview.
- **Save as routine** (`POST /api/routines/from-workout`): exercises, order, supersets, notes, set types, and each set's weight and reps (plus duration and distance) become fixed targets. RPE is not copied.

## Plate math and gear

Gear routes in `app/routers/gear.py` (`GET /api/gear`, `PATCH /api/gear/defaults`, `POST/PATCH/DELETE` for `/api/gear/bars[/{id}]`, `/api/gear/plate-sets[/{id}]`, `/api/gear/plate-sets/{id}/plates`, `/api/gear/plates/{id}`; every change answers with the whole gear), presets and seeding in `app/gear.py`, page `src/pages/Gear.tsx` (`/settings/gear`), math in `src/lib/plates.ts`, sheet in `components/PlateSheet.tsx`.

- **Gear is per user, on the server.** The first `GET /api/gear` or `GET /api/offline` copies in the v1 presets (`docs/v1-scope.md`) once (`users.gear_seeded`, under a row lock): the five bars in the user's weight unit and all three plate sets. Defaults become the Olympic barbell and the Olympic plates in their unit. Users add, rename, change, and delete bars, plate sets, and plates, turn plates on or off, and set pair counts. The current default bar or plate set can't be deleted (409 `is_default`). Deleting any other one sets exercises that used it back to the default.
- **Per exercise** (Library editor): Show plates (`plate_math`), bar, and plate set. Shown for logging types with a weight. Picking barbell equipment turns Show plates on.
- **Offline:** gear is in the offline copy (`gear`). Editing it needs a connection, like routines.
- **The rule** (`plateMath`, pure, tested in `tests/plates.test.ts`): exact search over pairs per side, never greedy, respecting pair counts, plates turned off, and the workout's left-out plates. Ties: fewest plates, then fewest distinct sizes, then heaviest plates first (90 lb per side is 45 and 45, not 55 and 35). Plates per side are listed heaviest first with counts, plus the bar and the total, as text. A target the plates can't make shows the nearest load below and above; tapping one sets that set's weight. A target under the bar says so, with the bar's weight, and shows the empty bar. When the bar, every plate in use, and the target share a unit, the math runs in whole hundredths of it, so 137.5 lb never becomes 137.49 (gear has at most 2 decimals; only a target typed with more makes the steps finer). Mixed units run in whole grams and show rounded to 0.1 in the set's unit, and since rounded grams of different units rarely line up (1.25 lb is 566.99 g), a load that shows as the target to 0.1 counts as an exact hit. A target past the heaviest load the plates can make shows that load and nothing above. Keep the file free of runtime imports.
- **At the gym:** the weight field's plate button (exercises with plate math on) opens the sheet. Plates unchecked there are left out for this workout only: saved in the workout in progress (`excluded_plates`), applied to every exercise in it, listed on the sheet, and gone when it finishes or is discarded. They never change the saved gear.

## Export

Routes in `app/routers/export.py`: `GET /api/export?format=json|csv` (full history) and `GET /api/workouts/{id}/export?format=json|csv` (one workout; someone else's is 404). File downloads named with the date (`liftlog-history-<today in the user's timezone>`, `liftlog-workout-<workout date>`). Buttons on the History detail page and Settings, Export (`/settings/export`). Browser only: in the Android app those places show Open in browser (`components/ExportLinks.tsx`), a plain link to the same page on the server's host; Capacitor hands links to other hosts to the phone's browser, so there's no browser plugin. Workouts still on a phone appear once they upload.

- **JSON** is the lossless backup: `schema: "liftlog-export"`, `schema_version` 1, `scope` (`history` or `workout`), the user's settings, the workouts with every stored field (weights as entered plus unit plus kg, ids, `routine_version_id` and `routine_id`, import and upload hashes, timezone-aware timestamps), every exercise, folders and routines (archived too) with each routine's current version, and gear. One workout exports the same document with only that workout.
- **CSV** is Hevy's workout export layout, verified against Trav's real export: the same 14 columns in the same order, text quoted and numbers bare, newest workout first, one row per set, `set_index` from 0 per exercise, `dropset` for drop sets, the superset group as `superset_id`, line breaks in notes as a literal `\n`, `\n` between rows and none after the last. Weights in the user's weight unit (`weight_lbs` or `weight_kg`), distances in their distance unit, each as entered when it's already in that unit, else converted from kg or meters and rounded to 0.01. Times in the user's timezone like `6 Oct 2026, 16:19`, no offset. Workouts only; exercises use their current names. Importing Trav's real file and exporting it gives the same bytes. The round trip through the Hevy importer is tested.

## Offline model and sync

Live workouts run only in the Android app; the web build shows routines with no Start button. Code: `src/lib/idb.ts` (storage), `offline.ts` (copy, login check, queue), `active.ts` (workout in progress), `session.ts` (its shape and pure steps), `start.tsx`, `pages/Workout.tsx`, `WorkoutFinish.tsx`, `timer/useRest.ts`.

- **IndexedDB** (`liftlog`, version 1, no packages): `cache` (the copy from `GET /api/offline` under `copy`, with the login it belongs to), `active` (the one workout in progress), `queue` (finished workouts waiting to upload, by id). Writes use strict durability. A new store or index means a new version and an upgrade step.
- **The copy** is the user, every exercise, folders and routines (archived too), each routine's current version, gear (bars, plate sets, plates, defaults), and the full workout history (never paged; Trav's is 72 workouts and about 1,000 sets). It refreshes at start, on resume, when the network returns, and after uploads. Pages that read routines, the routine view, and `useMe` use `cached()`: the server when it answers, else the copy. Editing routines still needs a connection. Queries and mutations run with `networkMode: "always"` so they fall back or fail plainly instead of pausing.
- **Login check** (`lib/offlineRules.ts`, pure, tested): the copy belongs to one login. A different login from `/api/offline` replaces it, unless the cached login still has unsynced workouts (queued, or one in progress); then nothing is cleared, refreshing stops, and a plain message asks to switch Tailscale back. Uploads only send workouts whose login matches `/api/me`.
- **In progress:** one at a time, on the device only. Every tap is written before the screen shows it (typing shows first and writes right after). Reopening the app goes back to it. Starting from a routine snapshots its current version (from the server if it answers within 2 s, else the copy), keeps that content with the workout, and records `routine_version_id`; prefill uses `prefill.ts` on the copy plus queued workouts. Empty workouts record none. Removing an exercise from a superset uses `removeExercise` in `reorder.ts` (the rest stay grouped when two or more remain).
- **Rest timer:** completing a set schedules the path A notification for an absolute end time saved with the workout. A superset rests only once every exercise in it has done that round's set, using the superset rest. Defaults: the routine's rest, else the exercise's rest from its most recent workout, else 90 s. The card's plus and minus 15 s change it for this workout. Uncompleting a set, skip, discard, and finish cancel the alert. While the app is in front it takes the alert over and plays it itself, like Spec 2.
- **Finish:** a confirm screen (sets not done and exercises with no done sets are dropped, and it says how many; title and notes editable), then one storage write moves the workout from `active` to `queue`, then an upload. Discard asks first, deletes it, and sends nothing.
- **Volume** (`lib/volume.ts`, pure, tested): completed normal, drop, and failure sets on weight and reps and weighted bodyweight, weight times reps summed exactly per entered unit and converted once into the user's unit. Warm-ups and bodyweight, assisted, duration, and distance exercises add nothing; no counted set is no data, not zero.
- **Set field limits** (the upload checks them in `check_sets()`, `app/routers/workouts.py`; the phone's inputs refuse anything else as it's typed, `INPUT` and `setProblem` in `session.ts`): weight 0 to 9999.99 in its unit with at most two decimals (a fifth digit before the point or a third decimal can't be typed); reps whole, 0 to 999; RPE 6 to 10 in half steps; duration 0 to 86,400 s; distance 0 to 1,000,000 m normalized, at most three decimals as entered. A bad set refuses the whole upload with 422 `bad_set` and a plain reason naming the exercise and the set as the phone numbers it ("Bench Press, set 1: the weight 225265 lb is over the limit of 9999.99."), and nothing is written. Bad input never causes a 5xx. Data already in the database isn't rechecked.
- **Set numbering** (`setLabels` in `lib/format.ts`; everywhere sets are listed: workout card, Overview, last-session strip, workout view, exercise page, routine view and versions (`SetRows`), and the routine editor): warm-ups show "W" and aren't counted, the rest are numbered from 1 in order, and drop and failure sets also get a small tag. Display only: stored positions and prefill matching don't change. The server's reasons use the same numbers ("warm-up 2", "set 3").
- **Heavy weight warning** (`heaviest`, `tooHeavy`, `heavySets` in `session.ts`, tested): a set whose weight is more than 1.5 times the heaviest weight ever logged for that exercise (any set type, compared exactly in kg, over `history()`, so queued workouts count) shows "Check this weight" under it. Never blocks. No history, no warning. The finish screen lists every flagged set; tapping one opens its card with the cursor in its weight.
- **Card flow:** the rest bar says what's on the next card ("Up next" over "Squat", or a superset's exercises), never the current exercise. The names wrap below "Up next" onto as many lines as they need, at body text size or larger, never truncated; on the last card it says "Last exercise", and Next exercise becomes Finish (opens the confirm screen; Finish at the top stays). RPE is set from the set's sheet (tap the set label) and shows under the row, which leaves the weight field room for 9999.99 at full size on a 360 px wide screen.
- **Sync contract:** `PUT /api/workouts/{id}` with the whole finished workout under its client UUIDv7 (title, notes, `started_at`, `ended_at`, `routine_version_id`, exercises with ids, superset groups, notes, rest, and done sets with ids). New: 201. Same id, same content (SHA-256 of the canonical body in `upload_hash`): 200, nothing changes. Same id, different content: 409 `workout_conflict`, never overwritten. Someone else's id: 404. A taken exercise or set id: 409. The server computes `workout_date` and `logged_name`. The body also carries `routine_version`, the started-from version's content as the phone snapshotted it; it isn't part of the hash. **Recreation rule:** if `routine_version_id` no longer exists (the routine was edited elsewhere and the version pruned while the workout was offline), the server recreates it from that content under its original id, as an older version (not current, no parent, fresh ids for its exercises and sets, its old number unless taken), so the workout keeps its link and Versions lists it. Only when its routine belongs to the caller (someone else's routine or exercise is 404, and nothing is recreated) and no version has that id. If the routine was deleted, or the body has no version content, the workout is stored without the link.
- **Upload loop** (`lib/uploader.ts`, pure, tested): oldest first, only the signed-in login's workouts. No connection or a 5xx stops the loop and everything stays queued. Uploads run on finish, at start and resume, when the network returns, and from Retry in the waiting bar.
- **Needs attention:** a workout the server refuses (409 or any other 4xx) is marked with the reason and shown under Needs attention in the waiting bar. It isn't retried automatically and never blocks the rest of the queue. It shows the server's own reason (for 422, the `bad_set` message). Its actions: Reopen, Copy as JSON (clipboard), Retry (just that workout), and Remove from phone (asks first; it can't be recovered). Nothing is ever removed automatically.
- **Reopen** (`reopen` in `session.ts`, tested; `reopenQueued` in `active.ts`): one storage write moves the workout from `queue` back to `active` with the same id, `started_at`, and `ended_at` (`ActiveWorkout.ended_at`), its done sets, no rest timer, and no plates left out, so it's fixed on the normal workout screen. Finishing again keeps the original `ended_at` and queues it. Disabled, with the reason, while another workout is in progress. A 4xx means the server never stored it, so resending under the same id is a fresh upload (except a 409 `workout_conflict`, where the server holds a different workout under that id; that one stays refused).

## Records, charts, and body-part volume

**Computed on read, never stored.** No PR table, no migration. All the math is pure TypeScript in `src/lib/stats.ts` (no runtime imports; tests in `tests/stats.test.ts`). The phone runs it on its copy plus this login's queued workouts (`statWorkouts`, which also computes `workout_date` for queued ones with the 4 AM rule); the web build runs the same code on the copy it fetches (`/api/offline`, refreshed when a stats page opens and after imports and exercise edits). `lib/useStats.ts` is the React side. History, the workout view, the exercise page, and Muscles all read the copy, so they work offline.

- **Which sets count:** every completed set except warm-ups, imported and queued workouts included.
- **Order:** workouts are judged by `started_at`. An exercise's first session is the baseline and earns nothing. A record must beat everything in workouts that started earlier; ties are not records. Within one workout only the best set per record type can be one. Weights compare in normalized kg (from value and unit), and values within 0.05 kg are equal (225 lb is 102.06 kg); volumes allow 0.05 kg per rep.
- **Per logging type:** weight and reps: heaviest weight, best reps at a weight, best estimated 1RM, best set volume, best session volume. Weighted bodyweight: the same on the added weight, no 1RM. Bodyweight reps: most reps in a set. Duration: longest set. Distance and duration: longest distance in a set. Assisted: none in v1. Weight records need at least 1 rep.
- **Best reps at a weight (dominance):** a set is a record only if no earlier set had at least as many reps at the same weight or heavier. If several sets in a workout qualify, the heaviest (then most reps) is the record. The exercise page lists the current frontier.
- **Estimated 1RM:** Epley, weight x (30 + reps) / 30; a single is its own weight; over 10 reps, no estimate. Always labeled estimated.
- **Where they show:** the finish summary (`recordsFor`: judged only against workouts that started before it, never itself), tags on each record set in the workout view, and the exercise page (current records with dates and links, a trend chart of the best per session: estimated 1RM by default, heaviest and session volume as toggles, imported sessions as hollow diamonds, on a workout-date axis; other types chart their main record; no averages).
- **Body-part volume** (`muscleSets`; page `/history/muscles`): hard sets per muscle per week, weeks starting Monday by `workout_date`. Every completed non-warm-up set counts, any logging type: 1 per primary muscle, 0.5 per secondary (Pelland et al. 2024); exercises with no muscles count under unassigned. Always the current muscle maps. A table for the chosen week and an 8-week chart per muscle; no targets or landmarks.
- **Calendar:** History has List and Calendar (month, Monday first, days marked by `workout_date`; tap a day for its workouts).
- **Workouts still on the phone** show in History labeled Waiting to upload or Needs attention. Their detail page is read-only, with no Save as routine or export until they upload.

**Prefill rule** (`frontend/app/src/lib/prefill.ts`, pure TypeScript, run offline on the copy; tests in `frontend/app/tests/`, run with `npm test` on Node's own runner, no packages): per exercise, use the most recent finished workout from the same routine (any version) that included it, else the most recent finished workout with it from anywhere. Imported workouts count and count as finished. Match sets by position within the same set type (second warm-up to second warm-up). Use the matched set's weight and reps (and duration and distance); a field it left empty falls back to the target. No matching set: the target (a range prefills its low end). No target: empty. A rep range always shows as a hint ("8 to 12") and never changes the value. If the routine has an exercise twice, the nth one matches the nth one in the past workout. Keep the file free of runtime imports.

## RAM budget

The box is tight. Memory limits are in `docker-compose.yml`: db 256 MB, backend 256 MB, Caddy 64 MB, Tailscale 128 MB. Postgres runs with `shared_buffers=64MB` and `max_connections=20`, and the backend pool is small to match. Don't raise a limit or add a container without saying why and checking `docker stats`.

## Design system

- **Fonts:** Bricolage Grotesque (headings and numbers via `.display` and `.num`) and Atkinson Hyperlegible (body), self-hosted from `@fontsource` npm packages, never a CDN.
- **Colors:** Foodlog's earth palette as CSS variables in `src/styles.css`, light and dark. Dark follows the OS, and `data-theme` on the root overrides it.

  | Token | Light | Dark |
  |---|---|---|
  | `--ground` | `#F3E7DC` | `#2A1B14` |
  | `--surface` | `#FBF5EF` | `#36241B` |
  | `--sunken` | `#E9DACB` | `#221510` |
  | `--ink` | `#2A1B14` | `#F3E7DC` |
  | `--muted` | `#6E5444` | `#C2A58F` |
  | `--line` | `#DCC8B6` | `#4C3528` |
  | `--accent` | `#D2792B` | `#D2792B` |
  | `--accent-strong` | `#9E5316` | `#9E5316` |
  | `--accent-text` | `#9E5316` | `#D2792B` |
  | `--over` | `#A8432A` | `#E8876A` |

  Use them through Tailwind (`bg-surface`, `text-muted`, `border-line`, `text-accent-text`). Never hard-code a palette color in components. Keep WCAG AA contrast.
- **Layout:** mobile first, single column, max width `max-w-md`, safe-area insets respected. Size text and spacing in rem. Tap targets at least 44 px.
- **Accessibility:** labels on every input, screen-reader text on icon-only buttons and color-only indicators, `prefers-reduced-motion` respected. **One focus indicator per control:** the base-layer `:focus-visible` rule in `src/styles.css` (2px outline in `--accent-text`, at least 4:1 on every background in both themes). A component that draws its own ring on a wrapper uses `focus-within:outline-*` there and `outline-none` on the input. Never add a second ring, and never put focus styles outside the base layer, or they'll beat `outline-none`.

## Workflow

- **One spec per session.** Each session implements exactly one spec, end to end: build, test, commit, deploy, update `HANDOFF.md`. Don't start the next spec or slip in unrelated work. If something out of scope comes up, note it in `HANDOFF.md` and ask.
- **Deploy status comes only from live checks:** the commit on `origin/main`, the migration `alembic current` reports, and the version `/download` offers (`data/apk/version.json`). The commands are in `HANDOFF.md`, section 3. Never write what's deployed into `HANDOFF.md` or anywhere else in the repo, and never trust an old note about it.
- **Minimal testing.** Test what would hurt if it broke silently: auth, privacy, and data integrity rules (today: auth and CORS, the 4 AM workout date with DST, user isolation, import dedupe and atomicity, exact weights, set type mapping, the muscle-map log, routine versioning, pruning, and conflicts, save as routine, the prefill rule, the superset move and remove rules, upload idempotency and the date at upload, the immutability triggers and change log function, the volume rules, the offline login check, queued workouts feeding prefill and rest, the upload loop and Needs attention, version recreation on upload, the plate math rule, export privacy, the CSV round trip through the Hevy importer, set field limits on upload, the heavy weight warning, Reopen, the record rules and Epley, the finish summary's records, hard sets per muscle and their weeks, the versions list's privacy). Don't write tests for layout, copy, or simple CRUD. Run the backend tests, the frontend tests, and the frontend build before every commit.
- **Ask Trav before:** anything touching auth or networking, deleting data, raising memory limits, or adding an external service or outbound dependency.

## Commands

All from the repo root (`~/liftlog`).

```bash
# Deploy: clean tree, build, verified pg_dump, then start (migrations run on backend start).
scripts/deploy.sh

# Backend tests, against a throwaway Postgres on an internal network (never the live one).
scripts/test-backend.sh

# Frontend unit tests (prefill, superset moves and removal, volume, the login check, queued history, the upload loop, plate math, the heavy weight warning, Reopen, records, 1RM, body-part volume).
cd frontend/app && docker run --rm -v "$PWD":/src:ro -w /src node:22-alpine npm test

# Frontend build check. Node isn't installed on the host.
cd frontend/app && docker run --rm -v "$PWD":/src:ro node:22-alpine sh -c \
  'mkdir /w && cd /src && tar cf - --exclude=node_modules --exclude=dist . | tar xf - -C /w && cd /w && npm ci && npm run build'
```

## Git

- Branch `main`, remote `origin` = private GitHub repo `liftlog` via the SSH alias `github-liftlog` (key `~/.ssh/github_liftlog`).
- Small, descriptive commits. `.env`, `data/`, `node_modules/`, `dist/` are ignored.

## Copy style

Plain, direct, friendly American English. No em dashes in UI text or docs. Keep copy short. No technical or developer text in the UI.
