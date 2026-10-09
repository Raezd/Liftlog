Workout app: v1 scope and Spec 1
Oct 9, 2026 · @Trav
v1 scope
v1 is a two-user, offline-first workout log that fully replaces Hevy for Trav and his wife, built as a Capacitor Android app plus a web build for desktop. It ships across seven specs, one per Claude Code session, each deployed and verified on both phones before the next. Working name is liftlog until a real name is picked.
Decisions
• Standalone app with its own data, UI, Compose project, Postgres, and Tailscale hostname. Fully usable without Foodlog.
• Two users from day one, scoped per user server-side, identity keyed on Tailscale login. All data private in v1.
• Offline-first. Everything needed to run a workout lives on the device. Sync is opportunistic and never blocks logging.
• Android client is a Capacitor shell around the React build so the rest timer can schedule local notifications with no network. Trav's phone locks between sets, which rules out a pure PWA timer. Desktop uses the plain web build. Spec 2 prototypes the timer before features are built on it.
• Same stack and design system as Foodlog: FastAPI, SQLAlchemy 2, Alembic, Postgres 17, React 19, TypeScript, Vite, Tailwind, TanStack Query, ECharts, Caddy, Tailscale sidecar, Docker Compose. Earth palette, Bricolage Grotesque and Atkinson Hyperlegible, every color a themeable CSS variable, WCAG AA.
• Security posture carries over unchanged: Tailscale only, Funnel off, no published host ports, Caddy secret header plus ALLOWED_LOGINS, secrets in .env.
• Bodyweight and TDEE belong to Foodlog. This app reads bodyweight from Foodlog once sync exists and never stores its own. Exercise calories are never sent to Foodlog's energy math.
• Workout date uses Foodlog's rule: the user's timezone plus the 4 AM rollover.
• History never silently changes. Starting a workout snapshots the routine. Editing a finished workout is explicit and recorded.
• Weights are stored as the value and unit the user entered, plus a normalized kg value. Display never drifts through repeated conversion. Default unit is lb, per-user setting.
• Estimates are labeled. "No data" is shown as no data, never zero.
Features
Exercise library. Seeded from free-exercise-db (Unlicense, public domain, about 870 exercises), committed to the repo and loaded by a migration, so it is not a runtime dependency. Text, equipment, and muscle data only, no images. All entries are searchable when adding an exercise, but a user's library shows only exercises they have used or added. Custom exercises are supported. Each exercise has an equipment type (barbell, dumbbell, machine, cable, bodyweight, other), a logging type (weight and reps, bodyweight reps, weighted bodyweight, assisted bodyweight, duration, distance and duration), primary muscles, and secondary muscles. Muscles can be left unassigned, and unassigned shows up as unassigned in reports. The app uses its own muscle vocabulary, matching the dataset's groups except that shoulders splits into front, side, and rear delts. Every dataset exercise tagged shoulders is flagged for review. Dataset muscle tags are a starting point, editable per exercise. No Hevy library, images, or animations are copied.
Routines. Built from exercises with target sets, reps, weight, RPE, rest time, and notes per exercise. Exercises can be grouped into supersets of up to three, with a superset rest time. Routines can be reordered, duplicated, and archived.
Workout screen. Starting a routine opens the first exercise as a full-screen card with no scrolling.
• The card shows the exercise name, routine notes, the set list with large tap targets for weight and reps prefilled from routine targets or last session, and a compact strip with last session's sets, top set, and volume for this exercise.
• Add set, remove set, and complete set. RPE is one tap per set, 6 to 10 in half steps, hidden until tapped. Set type is normal by default, with warm-up, drop, and failure available. Warm-ups never count toward volume or PRs.
• Completing a set starts the rest timer with that exercise's preset and its own alert sound. The timer fires with the phone locked and no signal.
• "Next exercise" loads the next card. "Overview" escapes to the full list, where exercises can be dragged to reorder, added, dropped, grouped into or out of supersets, or jumped to.
• A superset is one card with its exercises stacked compactly. Completing a set advances to the next exercise in the group, and the rest timer starts after the last exercise in each round.
• Every tap writes to on-device storage immediately. Closing the app or losing power mid-workout loses nothing.
Plate math. Tapping the weight on a barbell exercise shows plates per side. Users pick a bar and plate set per exercise, with a per-user default. Calculation uses an exact search over available plates, not greedy, and when a target can't be loaded it shows the nearest achievable load below and above. Fully on-device.
Preset
lb
kg
Olympic barbell
45
20
Women's Olympic barbell
35
15
Olympic EZ curl bar
25
10
Hex or trap bar
45
20
Standard 1-inch bar, 5 ft
15
7
Olympic plates, lb
55, 45, 35, 25, 10, 5, 2.5, 1.25

Olympic plates, kg

25, 20, 15, 10, 5, 2.5, 2, 1.5, 1.25, 1, 0.5
Standard 1-inch plates, lb
50, 25, 10, 5, 2.5, 1.25

Bar weights for EZ, hex, and standard bars vary by maker, so presets are starting points. Users can add custom bars and custom plates with a name, weight, and unit. Custom items persist and sync across devices until deleted. Users can turn individual plates off and set a pair count per plate, default unlimited.
Finish. Saves the workout and shows a summary with duration, total sets, volume, and any new PRs, with confetti that respects reduced motion. Finishing with no signal saves locally and uploads later. Export is CSV or JSON for a single workout or full history.
History and stats.
• Calendar of workouts by workout date.
• Per exercise: every session, averages, trend chart, and PRs for heaviest weight, best reps at a given weight, best estimated 1RM, best set volume, and best session volume.
• Estimated 1RM uses the Epley formula, only from normal, drop, or failure sets of 10 reps or fewer, and is always labeled estimated. RPE is stored but not used in 1RM math in v1.
• Body-part volume: hard sets per muscle per week. A primary muscle counts one set and a secondary muscle counts half, following the fractional counting in Pelland et al.'s 2024 meta-regression. Warm-ups are excluded. Tonnage is shown per exercise only. Reports compute from current muscle maps, so editing an exercise's muscles recalculates past body-part volume. Logged sets never change, and each muscle-map edit is recorded on the exercise with its date.
• Imported Hevy data is labeled as imported wherever it appears.
Measurements. Body measurements only: waist, chest, hips, neck, arms, forearms, thighs, calves, left and right where it applies, plus custom sites. Units are in or cm per user. Optional body fat percentage with a required method label. Bodyweight is read from Foodlog once synced. Until then, features that need it show no data.
Hevy import. Each user imports their own Hevy CSV export as a one-time seed. After import, liftlog's database is the only source of truth. The importer fuzzy-matches each Hevy exercise name to a dataset entry and shows a review screen to confirm, pick another match, or mark it custom. Import keeps set types, RPE, superset groupings, notes, duration, and distance. Re-importing creates no duplicates, which covers a fresh export at cutover if Hevy is still in use while liftlog is built. Imported workouts are labeled imported.
Foodlog sync. This app exposes a narrow summary API with a service token from v1: workouts per workout date and per user, for the challenge rule and Social. Foodlog consumes it after its maintenance window ends Nov 9. Bodyweight flows back the same way.
Out of v1
Social sharing, comparisons, cheers and nudges (later, through Foodlog's Social model); share images; RPE-based 1RM; Foodlog-side changes before Nov 9; exercise images; iOS.
Build order
1. Infrastructure: repo, docs, Compose, auth, backups, hello page on both phones
2. Capacitor shell and rest timer prototype: locked phone, airplane mode, custom sound, on time
3. Data model, exercise library seeded from free-exercise-db with the muscle vocabulary, Hevy import with match review
4. Routines with supersets and target RPE
5. Workout card flow, offline storage and sync, RPE, plate math, finish and export
6. History, PRs, charts, body-part volume
7. Measurements and the Foodlog summary API
Open items
• Resolved: Trav's phone locks between sets, so the native shell is required. Spec 2 still verifies the timer before features build on it.
• Final app name, which sets the repo and Tailscale hostname. Renaming later is cheap but not free.
• Whether Trav's wife has Hevy history to import. The importer works per user either way.
