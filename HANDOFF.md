# Liftlog handoff

Current state of the project, how to run it, and what comes next. Rules for working on it are in `CLAUDE.md`, with area detail in sections 17 to 27; scope is in `docs/v1-scope.md`.

## 1. What exists (Spec 1: infrastructure)

- **App URL:** `https://liftlog.<tailnet>.ts.net`, via the Tailscale sidecar (hostname `liftlog`, `tag:liftlog`, userspace networking, Serve on 443, Funnel off).
- **Users:** Trav and his wife, both in `ALLOWED_LOGINS`. She reaches the node through a Tailscale device share.
- **Code:** `~/liftlog`, branch `main`, private GitHub repo `Raezd/Liftlog` via the deploy key `~/.ssh/github_liftlog` (SSH alias `github-liftlog`, write access).
- **Address:** `https://liftlog.tail9d27a0.ts.net`. Kuma push monitor `Liftlog` and the Homepage tile (Health group) are set up. What's deployed is never written here; check it live (section 3).
- **Spec 1 accepted on October 9, 2026:**
  - The hello page shows each person's own login on Trav's phone, his wife's phone, and desktop.
  - The auth tests pass, no container publishes a port, and Funnel is off.
  - A manual dump restored cleanly into a scratch database, which was then dropped.
  - Restic snapshot `00ca92fd` contains the dump file.
  - A forced dump failure posted to Discord, and the stack came back healthy.
  - `.env` is 600 and has never been committed.
  - Every container is under its memory limit.
  - Kuma is green.
- **Separate from Foodlog:** own Compose project, database, Tailscale node, networks, backups, and off-site job. Nothing here depends on `~/foodlog`.
- **Backend:** FastAPI with the two-layer auth as middleware on every route (`app/auth.py`). Routes: `GET /api/health` (`{"status", "database"}`, 503 when the database doesn't answer) and `GET /api/me` (`{"login"}`). Spec 3 added the data model and its routes (section 6).
- **Frontend:** Vite, React 19, TypeScript, Tailwind. One hello page showing the app name, your login, backend and database health, and the build version. Earth palette in light and dark, self-hosted fonts.
- **Tests:** `scripts/test-backend.sh` (throwaway Postgres). Auth rules (`test_auth.py`): missing header, wrong header, and an unlisted login get 403; an allowed login gets 200. Spec 3's data rules are in `test_rules.py` and `test_data.py`.
- **Networks:** `edge` (Tailscale only, has internet), `app` (internal: Caddy to backend), `db` (internal: backend to Postgres). The backend and database have no route to the internet. No host ports.
- **Memory limits:** db 256 MB, backend 256 MB, web 64 MB, tailscale 128 MB. Postgres: `shared_buffers=64MB`, `max_connections=20`.

```
docker-compose.yml       tailscale, web, backend, db
.env.example             every variable, no values
tailscale/serve.json     Serve 443 -> 127.0.0.1:8080, Funnel off
frontend/Caddyfile       headers, CSP, /api proxy with X-Liftlog-Proxy
backend/app/             main.py, auth.py, config.py, db.py, models.py, healthcheck.py
backend/alembic/         env.py, versions/0001_baseline.py
frontend/app/src/        main.tsx, Hello.tsx, styles.css (tokens)
scripts/                 backup.sh + liftlog-backup.service/.timer (local dump)
                         offsite-backup.sh + liftlog-offsite.service/.timer (restic)
                         healthcheck.sh + liftlog-health.service/.timer (Kuma push)
```

## 2. Secrets (names only)

- **`~/liftlog/.env`** (chmod 600, gitignored): `TS_AUTHKEY` (blank after first start), `POSTGRES_PASSWORD`, `PROXY_SECRET`, `ALLOWED_LOGINS`, `DISCORD_WEBHOOK_URL` (the same webhook as Foodlog).
- **`/etc/liftlog/health.env`** (root 600): `KUMA_PUSH_URL`.
- **`/etc/restic/env` and `/etc/restic/password`** (root 600, shared with the homelab's other off-site jobs): `RESTIC_REPOSITORY`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` (no-delete key). Never read or print these.
- **`~/.ssh/github_liftlog`**: the deploy key's private half. Never print it.
- **Tailscale node identity:** `~/liftlog/data/tailscale` (root-owned).

## 3. Deploy

```bash
cd ~/liftlog
scripts/deploy.sh
```

It refuses a dirty tree or an unmounted `/mnt/storage`, builds, takes a pg_dump (checked with `pg_restore --list`) to `/mnt/storage/backups/liftlog/predeploy/` (newest 10 kept), then starts the new containers. Migrations run when the backend starts, so the dump always comes first. It ends with `docker compose ps`, the Alembic revision, and `docker stats`.

**What's deployed: check it live, every time.** This file never records deploy status, because it goes stale. Run these three:

```bash
cd ~/liftlog
git fetch -q origin && git rev-parse --short origin/main      # the commit on origin/main
docker compose exec -T backend alembic current | tail -1      # the migration the live database is on
cat data/apk/version.json                                     # the Android version /download offers (<code>-<commit>)
```

The web build's commit shows in Settings, under the version. The web app and the APK match when Settings and `version.json` name the same commit.

**First-time setup (done once):**

1. Tailscale admin console: add `"tag:liftlog": ["autogroup:admin"]` to `tagOwners`, then generate an auth key (reusable off, ephemeral off, pre-approved on, tag `tag:liftlog`). Put it in `TS_AUTHKEY` and deploy. Then blank it out.
2. Share the `liftlog` machine with Trav's wife (Machines > liftlog > Share), the same way as Foodlog.
3. `sudo install -d -o YOUR_USER -g root -m 755 /mnt/storage/backups/liftlog`
4. Install the units (replace `YOUR_USER` in the `.service` files), then enable the timers (section 4).

## 4. Backups and restores

| When | Unit | What |
|---|---|---|
| 03:45 daily | `liftlog-backup.timer` | `pg_dump -Fc` to `/mnt/storage/backups/liftlog`, checked with `pg_restore --list` |
| 04:05 daily | `liftlog-offsite.timer` | `restic backup --tag liftlog` of the dumps, `.env`, compose, serve.json, and Tailscale state to B2 |
| every 5 min | `liftlog-health.timer` | pings the Uptime Kuma push monitor `Liftlog` when healthy |

- **Local retention:** 7 daily, 4 weekly (Sundays), 12 monthly (1st), with hard links. Same as Foodlog. Refuses to run if `/mnt/storage` isn't mounted.
- **Off-site retention:** the monthly prune from Trav's PC (`restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`, prune key, never on the homelab) covers these snapshots too. Restic groups by host and paths, so Liftlog gets its own retention.
- **Alerts:** any failure posts to Discord (`[liftlog]` for the dump, `[liftlog offsite]` for restic). The off-site job also warns if the newest dump is over 26 hours old.
- The live database directory (`data/postgres`) is never backed up as files.

**Install the units:**

```bash
cd ~/liftlog/scripts
for u in liftlog-backup liftlog-offsite liftlog-health; do
  for x in service timer; do
    sed "s/YOUR_USER/$USER/g" $u.$x | sudo tee /etc/systemd/system/$u.$x >/dev/null
  done
done
sudo systemctl daemon-reload
sudo systemctl enable --now liftlog-backup.timer liftlog-offsite.timer liftlog-health.timer
```

**Health monitor:** in Uptime Kuma add a **Push** monitor named `Liftlog`, heartbeat interval 360 s, retries 1. Save its push URL (it should start with `http://127.0.0.1:3001/api/push/`) without echoing it:

```bash
read -rsp 'Kuma push URL: ' u && printf 'KUMA_PUSH_URL=%s\n' "$u" | sudo install -D -m 600 -o root -g root /dev/stdin /etc/liftlog/health.env; unset u; echo
```

**Restore a dump** (into a scratch database first):

```bash
cd ~/liftlog
D=$(ls -t /mnt/storage/backups/liftlog/daily/*.dump | head -1)
docker compose exec -T db createdb -U liftlog liftlog_restore
docker compose exec -T db pg_restore -U liftlog -d liftlog_restore --exit-on-error < "$D"
# Look around, then either drop it or swap it in:
docker compose exec -T db dropdb -U liftlog liftlog_restore
```

To replace the live database: `docker compose stop backend web`, `dropdb liftlog`, `createdb liftlog`, `pg_restore -d liftlog` the dump, then `docker compose up -d`.

**Restore from B2** (as root, with `/etc/restic` set up):

```bash
set -a; . /etc/restic/env; set +a; export RESTIC_PASSWORD_FILE=/etc/restic/password
restic snapshots --tag liftlog
restic restore latest --tag liftlog --target /root/restore --include /mnt/storage/backups/liftlog
# Tailscale identity, with the stack stopped:
restic restore latest --tag liftlog --target / --include /home/YOUR_USER/liftlog/data/tailscale
```

## 5. Spec 2: Android app and rest timer prototype

**Status:** accepted October 9, 2026. Trav reported every phone acceptance test passing on both phones. **Path A chosen; default alert follows the ringer.**

### What exists

- **App:** Capacitor 8.5.2 Android project in `frontend/app/android`, app id `io.github.raezd.liftlog` (permanent: changing it means uninstalling). Plugins pinned exactly: `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` 8.5.2, `@capacitor/local-notifications` 8.3.1. No iOS project. minSdk 26, target 36.
- **Offline:** web files are bundled in the APK, never loaded from the server. The API base (`https://liftlog.tail9d27a0.ts.net`) is set at build time from the stack's own Tailscale name (`VITE_API_BASE`). The web build uses relative paths.
- **CORS:** only `https://localhost` (the app's origin) gets CORS headers (`backend/app/main.py`). The desktop web build is same-origin. Auth wraps CORS, so preflights must pass both auth layers too. A disallowed preflight gets a bare 400 with no CORS headers. Tests are in `backend/tests/test_auth.py`.
- **Timer test screen** (removed in Spec 5a; in git history before `3a3e271`): 10/60/90/180 s timers, five 2:30 rests 30 s apart, Done resting, Cancel, path A/B switch, alarm sound toggle, server status and login, permission help, and a results list showing how late each alert was posted.
- **Path A:** `@capacitor/local-notifications` with `allowWhileIdle` (`setExactAndAllowWhileIdle`). **Path B:** the app's own `RestAlarm` plugin (`RestAlarmPlugin.java`) using `AlarmManager.setAlarmClock`.
- **Channels** (`RestAlerts.java`): `rest-timer-v1` (notification usage, follows the ringer) and `rest-timer-alarm-v1` (alarm usage, rings on vibrate or silent). Both high importance, vibration `0,700,250,700,250,700`, sound `res/raw/rest_alert.wav` (original, see `docs/rest-alert-sound.md`). A channel's sound can't change after creation: a new sound means `-v2` ids.
- **Timer state** is absolute end times in `localStorage`. While the app is open it takes an alert over 600 ms before it's due (only if the native side says the app is in front), cancels the scheduled one, and plays the same sound and vibration in-app, so there's no duplicate notification. If the app leaves the front before the end, the alert is handed back to the phone.
- **Permissions:** `POST_NOTIFICATIONS` is requested on first launch, `USE_EXACT_ALARM` is granted at install. The screen explains in plain words, with an Open settings button, if notifications, either channel, or exact alarms are off.
- **`/download`:** a web page showing the latest version, served by the backend at `/api/app/latest` and `/api/app/liftlog.apk`, behind the auth middleware. Files are in `data/apk` (mounted read-only into the backend).

### Build and publish

```bash
cd ~/liftlog
scripts/android-build.sh      # clean tree required (ALLOW_DIRTY=1 for a test build)
scripts/android-publish.sh    # newest build to /download
```

- Runs in the `liftlog-android-build:1` image (`scripts/android/Dockerfile`: Temurin JDK 21.0.12, Node 22.23.3). The Android SDK (command-line tools 15859902, checksum pinned; platform 36, build-tools 35.0.0), Gradle 8.14.3 (checksum pinned), and npm caches, and the built APKs, are in `/mnt/storage/liftlog-build` (1.9 GB after the first build). The script prints free space on `/` and `/mnt/storage` before and after, and refuses to run under 4 GB / 8 GB.
- Version: code = `git rev-list --count HEAD`, name = `<code>-<short hash>`. Each commit raises the code, so updates install over the old version.
- One-time setup (done): `sudo install -d -o $USER -g $USER -m 755 /mnt/storage/liftlog-build ~/liftlog/data/apk`.
- At deploy, free space was 70 GB on `/` and 810 GB on `/mnt/storage`.

### Signing and keystore backup

- Keystore: `~/.liftlog-signing/liftlog-release.p12` (PKCS12, RSA 4096, alias `liftlog`, valid 100 years) and its password in `~/.liftlog-signing/keystore-password`. Directory 700, files 600, outside the repo. Made once by `scripts/android-keystore.sh`, which refuses to overwrite.
- Certificate SHA-256: `612d7f374925c458783267a22f7b8d84f3877955c9f8bb466aa5fa8ea170b903`.
- Off-site: `scripts/offsite-backup.sh` includes both files and fails (Discord alert) if either is missing. **Confirmed in restic snapshot `03eb37ba`** (2026-10-09 19:24) before any phone installed the app.
- **Losing the keystore means every update needs an uninstall, which wipes the app's on-device data.** Restore it with `restic restore latest --tag liftlog --target / --include /home/YOUR_USER/.liftlog-signing`.

### Installing and updating on a phone

1. On the phone, with Tailscale on, open `https://liftlog.tail9d27a0.ts.net/download` and tap Download.
2. Open the file. Allow the browser to install apps if asked.
3. Tap Install (or Update). Updates keep data because every build is signed with the same key.
4. First launch: allow notifications.

From the app: Settings, About, shows the installed version and an Update app button that opens `/download` in the phone's browser. When `/download` serves a different version, Settings also shows "Update available" with it (section 15).

### Acceptance tests (both phones, airplane mode, stopwatch, pass = within 2 s)

Trav ran all of them on both phones and reported that everything passed, both scheduling paths included. Per-test stopwatch times weren't recorded.

| Test | Trav | Wife |
|---|---|---|
| Installs from /download, opens in airplane mode | pass | pass |
| Shows own login with network and Tailscale on; desktop web still works | pass | pass |
| 90 s timer, screen locked | pass | pass |
| Five-timer sequence, locked in a pocket | pass | pass |
| `adb shell dumpsys deviceidle force-idle`, three 60 s timers, **path A** | pass | pass |
| Same, **path B** | pass | pass |
| Fires after the app is swiped from recents | pass | pass |
| Cancelled early never fires | pass | pass |
| Audible in Bluetooth earbuds over music | pass | pass |
| On vibrate: default vibrates only; alarm toggle plays sound | pass | pass |
| Keystore and password in latest restic snapshot | pass (`03eb37ba`) | |
| CORS test passes | pass (13 backend tests) | |

**Scheduling path chosen: A** (`@capacitor/local-notifications` with `allowWhileIdle`). It passed every test, including force-idle, so per the rule A is used. B (`setAlarmClock`) also passed; its code was removed in Spec 3 (it's in git history before `688e3de` if A ever turns out late on a phone or Android update). The workout screen (Spec 5) schedules with A.

**Ringer default for v1: follow the ringer** (`rest-timer-v1`: sound and vibration normally, vibration only on vibrate or silent). Spec 3 added the per-user setting **Play through silent mode** (off by default), which switches to `rest-timer-alarm-v1`. The phone keeps the last value it saw so the timer works with no signal.

### The rest of v1

The remaining order: 3 data model, exercise library, and Hevy import (done, section 6); 4 routines (done, section 7); 5a workout card flow, offline storage and sync, finish (built, section 9); 5b plate math and export; 6 history, PRs, charts, body-part volume (done, section 13); 6b editing finished workouts; 7 measurements and the Foodlog summary API.

## 6. Spec 3: data model, exercise library, Hevy import

**Status:** built and tested. Waiting on Trav's import and phone checks (table below).

### What exists

- **Schema** (migrations `0002` to `0004`; overview in section 17): read-only exercise catalog (876 from free-exercise-db, commit `f00c92c`, Unlicense, in `backend/app/seed/free-exercise-db/`), muscle vocabulary (19: the dataset's groups with shoulders split into front, side, rear delts), users, user exercises, muscle-map change log, workouts, workout exercises, sets, workout change log, imports, Hevy title mappings. UUIDv7 keys; client ids accepted.
- **User scoping:** users are created on their first request from the Tailscale login. Every query filters on the caller; another user's object is a 404.
- **Routes:** `GET/PATCH /api/me` (login and settings), `GET /api/muscles`, `GET /api/catalog?q=`, `GET /api/catalog/{id}`, `GET/POST /api/exercises`, `GET/PATCH /api/exercises/{id}`, `GET /api/workouts?before=`, `GET /api/workouts/{id}`, `POST /api/imports/hevy/preview`, `POST /api/imports/hevy`, `GET /api/imports`, `GET /api/imports/{id}`.
- **Pages** (web and Android, bottom nav): History (newest first, imported label, tap for exercises and sets), Library (search, Needs review and Archived filters, add from catalog or custom, edit name, equipment, logging type, muscles, archive, muscle change history), Import (upload, counts, per-title review, delt confirmation, result), Settings (display name, timezone, units, play through silent mode, login and version). The hello page is gone; the timer test screen is under Settings in the app.
- **Hevy import** (flow in section 19): columns verified against Trav's real export. Strong matches (score 1.1 or more) start out picked on the review screen; everything else needs a choice. Delts chosen on the review screen are applied; the exercise keeps Needs review unless "These delts are right" is ticked.
- **Deploy** now goes through `scripts/deploy.sh` (dump first).

### Dry run on Trav's export

`~/imports/hevy-trav.csv` (1,025 rows) through the real code against a scratch database, picking the top match for every title: **72 workouts and 1,025 sets added**, matching the file's 72 distinct workouts and 1,025 rows. Re-importing added 0 and skipped 72 workouts (1,025 sets), and asked no questions. The scratch database was deleted; nothing was imported into the live one. Trav runs the real import through the page so the exercise choices are his.

Notes from the file: 31 exercise titles, weights in lb, distances in miles, no RPE, one superset (Jul 25, 2026: Lat Pulldown and Seated Row), Treadmill done twice in four workouts (kept as two entries), one workout description ("Deload week", Aug 18). Titles with no good catalog match: Champagnes, Stretching, Hip Openers, Ruck walk, Medicine Ball Catch, Knee-to-wall Ankle Dorsiflexion; custom is likely right for those.

### Acceptance

| Check | Result |
|---|---|
| Trav's export imports; counts match the CSV (72 workouts, 1,025 sets) | dry run passes; real import pending (Trav) |
| Spot-check oldest (Nov 16, 2025, Day 4: Deadlift), superset (Jul 25, 2026), newest (Oct 7, 2026) against Hevy | pending (Trav) |
| Re-import adds 0 and reports all skipped | test passes; dry run passes |
| Every title resolved; second import asks nothing | test passes; dry run passes |
| Shoulder exercises arrive with Needs review; confirming clears it | test passes; pending on the page (Trav) |
| Tests pass | 39 pass |
| Library, history, settings on desktop and both phones; wife sees none of Trav's data | isolation test passes; phones pending |
| pg_dump before the migration; stack under memory limits | done |

## 7. Spec 4: routines

**Status:** built and tested. Waiting on Trav's checks on the page and phones (table below).

### What exists

- **Schema** (`0005`): `routine_folders`, `routines`, `routine_versions`, `routine_exercises`, `routine_sets`, all scoped per user, plus `workouts.routine_version_id` (empty until Spec 5). A trigger makes versions, their exercises, and their sets immutable. Model and rules are in section 20.
- **Routes:** `GET /api/routines?archived=`, `PUT /api/routines/layout` (folder order, and each folder's routines in order), `POST/PATCH/DELETE /api/folders[/{id}]`, `POST /api/folders/{id}/duplicate`, `POST /api/routines`, `GET/PATCH/DELETE /api/routines/{id}`, `POST /api/routines/{id}/duplicate`, `POST /api/routines/{id}/versions` (409 `version_conflict` on a stale parent), `GET /api/routines/{id}/versions[/{vid}]`, `POST /api/routines/from-workout`.
- **Pages:** the bottom nav is now Routines, History, Library, Settings. Import moved to Settings (`/settings/import`).
  - **Routines** (`/`): folders with their routines in order, "Not in a folder" below. Options per folder or routine: rename, move to another folder, duplicate, archive or restore, delete (only if no workout used it), earlier versions. Reorder mode: drag handles plus move up and move down buttons, with each move read out for screen readers. Show archived on demand.
  - **Editor** (`/routines/new`, `/routines/{id}`): add from your library (several at once), reorder by buttons on each card or in reorder mode (drag or buttons), supersets with "Superset with the next exercise" (up to three, a rest after each round), rest and notes per exercise. Per set: add (copies the last set), remove, move, set type, reps fixed or a range, and weight, RPE, time, or distance depending on the logging type. Save makes a new version; leaving with unsaved changes asks first; a conflict offers to load the latest and never overwrites.
  - **Versions** (`/routines/{id}/versions`): the kept versions, newest first, each readable as it was saved. Since the Spec 4 fixes (section 8), only the current version and versions a workout used are kept.
  - **Save as routine:** a button at the bottom of a workout in History. Name defaults to the workout title; pick a folder, no folder, or a new one.
- **Prefill rule:** `frontend/app/src/lib/prefill.ts`, exported for Spec 5, not used by any screen yet. Rule in section 25.
- **Tests:** 44 backend (5 new in `test_routines.py`: new version leaves the old one unchanged, stale parent is a conflict, the database refuses updates to a version, superset rules, save as routine copies sets and skips RPE, delete only when unused, user isolation for folders, routines, and versions) and 6 frontend (`frontend/app/tests/prefill.test.ts`, Node's own test runner, no new packages). `0005` downgrades and upgrades cleanly.

### Choices made while building (not in the spec)

- A rep range with no history prefills its low end.
- Prefill also carries duration and distance the same way as weight and reps. A field the past set left empty falls back to the target.
- Moving an exercise takes it out of its superset, so a group never splits by accident.
- Deleting an unused folder deletes the routines in it, after asking.
- A routine's name lives on the routine, not the version. Renaming doesn't make a new version.
- Exercises are added from your library only. New exercises are made in Library first.

### Acceptance

| Check | Result |
|---|---|
| Trav saves his latest Day 1 to Day 4 workouts as routines in one folder, then edits one to use rep ranges and a different target on one set | pending (Trav) |
| Editing makes a new version; the old one is still readable | test passes; on the page under Versions, pending (Trav) |
| Editor works on desktop and both phones, reordering by drag and by buttons | pending (Trav). Not checked in a browser this session (no browser tools). |
| Tests pass | 44 backend, 6 frontend, build passes |
| Wife sees none of Trav's folders or routines and can make her own | isolation test passes; on her phone, pending |
| Dump before migrations; memory under limits | done |

## 8. Spec 4 fixes

**Status:** built and tested. Waiting on Trav's checks (table below).

- **Migration:** "Lower A" went from 7 versions to 1 when `0006` ran.

- **Superset moves** (`src/lib/reorder.ts`, rules in section 20): moving an exercise within its superset keeps it there; past the first or last exercise takes it out; a lone exercise skips past a whole superset instead of landing inside it; a superset moves as one unit from its header. Works by drag and by buttons in reorder mode (`components/ExerciseOrder.tsx`, with a line showing where it will land and "In superset A" or "Not in a superset" on the dragged row), and by the buttons on each card (the first card of a superset has the group's buttons). Every move is announced.
- **Save as routine** still saves immediately, then opens the new routine's view page (`/routines/{id}`, read-only, Edit button) with "Saved as a routine in {folder}." The editor moved to `/routines/{id}/edit`. Tapping a routine on the Routines page now opens the view page too; Edit is on it and in the routine's options.
- **Focus:** one ring on every control, a 2px outline in `--accent-text` from the base-layer rule in `styles.css`. The old rule was outside Tailwind's layers, so it beat `outline-none` and doubled the editor's wrapper ring; it also forced a 4px corner on rounded inputs, and its color (`--accent`) was only 2.65:1 on the light background. Now 4.15:1 or better on every background in both themes.
- **Version pruning** (`0006`): `parent_version_id` lost its foreign key and keeps its value. Every non-current version that no workout references was deleted once. A save now deletes the version it replaced in the same transaction, unless a workout references it. The conflict check runs first, unchanged. `workouts.routine_version_id` (RESTRICT) was already added by `0005` in Spec 4, so `0006` didn't add it again. Delete-only-if-unused already used that column. `0006` downgrades (the foreign key comes back as NOT VALID; pruned versions don't come back).
- **Tests:** 46 backend, 11 frontend. New or rewritten for this: `test_saving_prunes_the_previous_version_when_no_workout_used_it`, `test_stale_save_is_a_conflict_even_when_its_parent_was_pruned`, `test_a_version_a_workout_used_survives_saves_and_postgres_wont_delete_it`, `test_used_routines_and_folders_only_archive_and_postgres_refuses_deletes`, and five superset move tests in `tests/reorder.test.ts`. A one-off check (not kept) ran `0006` on a routine with 7 versions, one used by a workout: the current one and the used one remained, with their exercises, and it downgraded and upgraded cleanly.

| Check | Result |
|---|---|
| Save as routine shows the confirmation and opens the view page | pending (Trav) |
| One focus ring on each input, desktop and both phones | pending (Trav) |
| Superset swap, move out past an edge, move whole superset, by drag and buttons, desktop and both phones | rules unit-tested; pending on devices (Trav) |
| Lower A shows one version after the migration; more edits still leave one | 1 after migration (checked in the database); further edits covered by a test, pending on the page |
| Web and APK report the same commit; both phones on the new APK | matched when checked; phones pending |
| Tests pass; dump before migration; memory under limits | 46 backend, 11 frontend; done |

## 9. Spec 5a: live workouts offline, sync, immutable history

**Status:** built and tested with the section 10 follow-ups. Phone checks below are still Trav's.

### What exists

- **Backend.** `PUT /api/workouts/{id}` (the upload; contract in section 24), `GET /api/offline` (everything the phone caches), and `GET /api/workouts/{id}` now also returns `routine_version_id`, `routine_id`, each exercise's `rest_seconds`, and each set's `completed_at`.
- **Migration `0007`.** `workout_exercises.rest_seconds`, `workouts.upload_hash`, the immutability triggers on `workouts`, `workout_exercises`, and `sets`, `workout_snapshot()`, and `edit_finished_workout()` (writes `workout_changes`; nothing calls it until Spec 6). Rules in section 17. Downgrades and upgrades cleanly (checked once against the test database, with data in it).
- **Phone storage.** IndexedDB `liftlog` v1: `cache`, `active`, `queue`. The copy refreshes on start, resume, reconnect, and after uploads. The login check refuses to clear while the cached login has unsynced workouts and says so on every page.
- **Routines** (`/`, `/routines/{id}`): read from the copy when the server can't be reached. In the app: **Start empty workout** at the top, **Start** on each routine row and on the routine page. A bar on every page resumes a workout in progress; reopening the app goes straight back to it.
- **Workout** (`/workout`, full screen, app only): one card per exercise or superset, Previous and Next exercise, elapsed time. Each set: type (tap the set number: normal, warm-up, drop, failure, or remove), weight, reps, time, or distance by logging type, RPE (tap to show 6 to 10), done. Rep ranges show as "Target 8 to 12 reps". The last-session strip shows last time's sets, top set, and volume. Rest control on the card (plus and minus 15 s, this workout only); a rest bar with the countdown, its own plus and minus 15 s, and Skip. **Overview:** jump, remove (asks if it has done sets), superset with the next exercise (up to three), add from the library, reorder (the routine editor's drag and buttons), discard.
- **Finish** (`/workout/finish`): title and notes, how many sets and exercises will be dropped, Save, Back, Discard. **Summary** (`/workout/done`): time, sets, volume, confetti (none with reduced motion), and whether it uploaded.
- **Unsynced indicator:** "N workouts waiting to upload" with Retry, above every page; the server's reason shows when it refused one.
- **Routine editor fix:** removing the middle of a three-exercise superset keeps the other two grouped.
- **Removed:** the timer test screen, its route, `useRestTimer.ts`, and the native `delivered()` method only it used.
- **Tests:** 56 backend (new `tests/test_workouts.py`: upload idempotency, 409 and 404, workout date at upload with the 4 AM rule and DST, the triggers on update, delete, and insert, the change log function, Hevy re-import with the triggers on, version kept for a synced workout while unused ones are pruned, the offline copy is private; `test_routines.py` now links workouts through a real upload) and 18 frontend (new `volume.test.ts`, `offline.test.ts`, and a superset removal test in `reorder.test.ts`).

### Choices made while building (not in the spec)

- Each workout exercise stores the rest it used (`rest_seconds`), which is what "the rest time from that exercise's most recent workout" reads. For a superset it's on the first exercise and is the rest after each round.
- A superset rests once every exercise in it has done that round's set (so it works in any order, and with uneven set counts).
- The rest bar's plus and minus change only the running rest; the card's change the exercise's rest for the rest of the workout (and the running rest, if it's that exercise's).
- An exercise added during a workout gets as many sets as last time, prefilled from it, or one empty set.
- Workout exercises keep the routine's notes for that exercise, so save as routine still carries them.
- Finish is disabled until at least one set is done; discard is offered instead.
- Starting from a routine used the server's current version if it answered within 6 seconds, else the copy. Now 2 seconds (section 10).
- A finished workout whose routine version was pruned while it was offline was first stored with no version link. Superseded by section 10, which recreates the version.
- Upload response codes beyond the spec: a taken exercise or set id is 409 `id_taken`; bad values are 422.

### Acceptance

Nothing below has been run on a phone or in a browser this session (no device or browser tools). Every item marked pending needs the deploy and the new APK first.

| Check | Result |
|---|---|
| Real workout from a routine, airplane mode, phone locked between sets; alerts on time; appears once in History on desktop with the right date and version | pending (Trav) |
| Prefill in airplane mode matches the last session of the same routine | rule unit-tested; pending on phone |
| Force-stop mid-workout, reopen: resumes with every completed set | pending (Trav) |
| Superset: alert only after the last exercise of each round | pending (Trav) |
| Empty workout started offline syncs when back online | pending (Trav) |
| Two workouts finished offline both upload once; Retry again adds no duplicates | idempotency tested; pending on phone |
| A discarded workout never reaches the server | pending (Trav) |
| Wife's phone shows only her data | upload and offline copy isolation tested; pending on her phone |
| Timer test screen is gone | done in code; pending in the new APK |
| A hand-run UPDATE on a finished set in psql is rejected | tested; pending on live (`docker compose exec db psql -U liftlog -c "UPDATE sets SET reps = reps"` should fail with "finished workouts are immutable") |
| Tests pass; dump before migration; memory under limits | 56 backend, 18 frontend, build passes |

## 10. Spec 5a follow-ups: version recreation, Needs attention, sync tests

**Status:** built and tested with section 9. No migration in this change.

- **Version recreation** (rule in section 24): the phone keeps the started-from version's content with the workout and sends it as `routine_version`. If the server pruned that version meanwhile, it recreates it under its original id as an older, non-current version with no parent, and links the workout. Someone else's routine or version is 404 and recreates nothing; a deleted routine means no link.
- **Needs attention:** a workout refused with a 4xx shows in the waiting bar with the reason and Copy as JSON, Retry, and Remove from phone (confirmed). It's never retried or removed automatically and never blocks the queue. The summary screen says so too.
- **Start** waits at most 2 seconds for the server's current version, then uses the copy.
- **Refactor:** `session.ts` imports name their `.ts` files (`allowImportingTsExtensions` in `tsconfig.json`), and the upload loop is `lib/uploader.ts`, so Node's test runner loads both. One behavior difference from section 9: a 5xx or a non-HTTP failure now stops the loop like no connection does, instead of marking the workout refused.
- **Tests:** 60 backend, 24 frontend. New: a retry with trailing-zero lb weights and microsecond timestamps is 200 and leaves one workout; a queued workout feeds prefill, the last-session strip, and the rest lookup as the same routine (`tests/session.test.ts`); refused uploads don't block later ones, aren't retried on their own, and retry alone (`tests/uploader.test.ts`); a pruned version is recreated under its id as non-current and linked; another user's routine or version is 404 and recreates nothing; a deleted routine lands unlinked.

| Check | Result |
|---|---|
| Workout from a routine in progress in airplane mode, routine edited and saved on desktop, workout finished and uploaded: linked to its routine and its version, which Versions lists | recreation tested; pending on phone (Trav) |
| Start opens within about 2 seconds on weak signal | pending (Trav) |
| Tests pass; dump before migration; memory under limits; web and APK same commit | 60 backend, 24 frontend, build passes; matched when checked |

## 11. Spec 5b: plate math, gear, export

**Status:** built and tested with its fixes. Rules are in sections 21 and 22.

- **Migration `0008`:** `bars`, `plate_sets`, `plates`; `users.default_bar_id`, `default_plate_set_id`, `gear_seeded`; `user_exercises.bar_id`, `plate_set_id`, `plate_math` (turned on for existing barbell exercises). Downgrades and upgrades cleanly (checked once with gear in it).
- **Gear:** presets copied in on first use, in the user's unit. Settings, Bars and plates (`/settings/gear`). Library editor: Show plates, bar, plates. Gear is in the offline copy.
- **Workout card:** plate button on the weight field opens the plate sheet; nearest-load buttons set the weight; plates unchecked there are left out for this workout only.
- **Export:** CSV (Hevy layout) and JSON (schema version 1), full history from Settings, Export and one workout from its History page. In the Android app those places show the browser address instead.
- **Verified:** Trav's real Hevy file, imported into a scratch user and exported again, came out byte for byte the same (one-off check, not kept). Gear endpoints smoke-checked once (not kept: simple CRUD).
- **Tests:** 62 backend (new `tests/test_export.py`: export privacy with every kind of data on both users, CSV round trip), 37 frontend (new `tests/plates.test.ts`), build passes.
- **Not covered by the round trip:** a set entered in kg by a lb user exports converted to lb, rounded to 0.01 (100 kg is 220.46 lb), and comes back as that lb value. The CSV is the portable copy; JSON keeps it exact.
- **Choices made while building:** gear lists sort by name; the current default bar or plate set can't be deleted until another is picked; a bar may weigh 0 (sleds); gear weights allow at most 2 decimals (schema, API, and page), so plate math stays in whole hundredths; in mixed units a load that shows as the target to 0.1 counts as exact; delete in the gear page asks for a second tap; the one-workout JSON carries the same exercises, routines, and gear as the full one.

| Check | Result |
|---|---|
| Airplane mode: 225 lb on the Olympic bar shows 45 and 45 per side | rule tested; pending on phone (Trav) |
| 137 lb shows 135 and 137.5; tapping sets the weight | rule tested; pending on phone |
| 30 lb shows the below-the-bar message and the empty bar | rule tested; pending on phone |
| Leaving out the 2.5s changes every exercise in that workout; the next workout has them back | pending on phone |
| Custom sled bar on a plate-loaded exercise | pending on phone |
| Desktop exports in both formats; CSV has Hevy's columns; JSON has routines and gear | tested; pending in a browser |
| Android app export screen points to the browser | pending on phone |
| Wife sees her own preset gear and exports only her data | isolation tested; pending on her phone |
| Tests pass; dump before migration; memory under limits; web and APK same commit | tests pass; deploy pending |

## 12. Fixes from real use: set numbers, card flow, weight limits, Reopen, export button

**Status:** built and tested. No migration. Rules are in section 24 (set field limits, set numbering, heavy weight warning, card flow, Needs attention, Reopen) and section 22 (Export).

- **Set numbering:** warm-ups show W, the rest count from 1 skipping warm-ups, drop and failure sets carry a small tag. On the workout card, the Overview (a row of set labels per exercise, filled when done), and the last-session strip ("W: 95 x 10, 1: 185 x 5, 3 drop: 135 x 8"). Display only.
- **Card flow:** the rest bar names the next card ("Up next: ..."), or "Last exercise". On the last card Next exercise becomes Finish.
- **Weight field and limits:** the weight field is at least 5.375rem wide (9999.99 at 18 px is 69 px of text; checked in headless Chromium at 360 px wide with the real font and CSS, no page overflow, not kept). Typing past the limits does nothing; `setProblem` checks them again before a set is completed. To make room, RPE moved from its own column into the set's sheet (tap the set label) and shows under the row as "RPE 8".
- **Heavy weight warning:** inline under the set, and listed on the finish screen (tap to jump). It compares against everything on the phone, so a reopened workout doesn't count against itself (it's out of the queue while open).
- **Server:** `PUT /api/workouts/{id}` checks every set field and answers 422 `bad_set` with the reason. The old Pydantic bounds (weight up to 10,000, reps 10,000, duration 172,800, distance 100,000) are gone from the model, so every range answer is the plain one; the hash is unchanged (types are the same). One-off check, not kept: NaN, Infinity, `1e1000000`, `1e-1000000`, 10^30 reps, absurd RPE and distances, a missing unit, and non-integer reps all answer 422 and write nothing.
- **Needs attention:** shows the server's reason (it already did for `{code, message}` errors; the generic text came from Pydantic's list errors, which these fields no longer produce). **Reopen** puts it back in progress (rules in section 24).
- **Export in the app:** Open in browser, a plain link to the page on the server's host. Capacitor sends links to other hosts to the phone's browser (`Bridge.launchIntent`, ACTION_VIEW), so no plugin was added.
- **Tests:** 68 backend (new: six bad set values refused with their reasons, nothing written, the limits themselves accepted), 44 frontend (new: the server's reason kept for Needs attention while later workouts upload; Reopen keeps id and times, finishing again keeps `ended_at`, refused while another workout is in progress, uploads once; the heavy weight warning above 1.5 times only, exact at the boundary in mixed units, counting queued workouts, quiet with no history).

### Choices made while building (not in the spec)

- Server reasons name warm-ups as "warm-up 2" (the card shows W), so the set can be found.
- Distance as entered allows at most three decimals, and time up to 24:00:00 can be typed; both keep bad values from reaching Postgres.
- Flagged sets on the finish screen include sets not done yet, marked "(not done)".
- An exercise missing from the copy on Reopen falls back to the started-from version's name and type, else "Exercise", weight and reps.
- A workout refused with 409 `workout_conflict` can be reopened too, but the server still holds different content under that id, so it'll be refused again.

| Check | Result |
|---|---|
| Routine with two warm-ups shows W, W, then 1 | pending on phone (Trav) |
| After the last set of an exercise, up next names the next exercise; a superset's names its exercises | pending on phone |
| Last card's button reads Finish and opens the confirm screen | pending on phone |
| Weight field shows 1102.5 fully; a fifth digit or third decimal does nothing | fits at 360 px in headless Chromium; pending on phone |
| 2252.5 lb on an exercise whose heaviest is 225 lb warns, and the finish screen lists it | rule tested; pending on phone |
| Export button opens the page in the browser, and an export downloads there | pending on phone |
| Tests pass; dump before deploy; memory under limits; web and APK same commit | 68 backend, 44 frontend, build passes; dump written first; all under limits; matched when checked |

## 13. Spec 6: records, calendar, exercise pages, body-part volume, version links

**Status:** built and tested. No migration. Not deployed by this session; check what's live with the commands in section 3. Phone and browser checks are Trav's (table below). Rules are in section 25.

- **HANDOFF.md** no longer records deploy status anywhere; section 3 has the live checks, and `CLAUDE.md` (Workflow) says deploy status only comes from them.
- **Computed on read:** records, estimated 1RM, per-session numbers, and hard sets per muscle are pure functions in `src/lib/stats.ts`, run on the offline copy plus queued workouts. Nothing is stored.
- **History** (`/history`): List and Calendar, both from the copy, so they work offline. Workouts on the phone show labeled Waiting to upload or Needs attention. **Muscles** (`/history/muscles`, button at the top of History): weekly hard sets table and an 8-week chart per muscle.
- **Workout view:** works offline (copy fallback), and opens queued workouts read-only. Exercise names link to their page. Record sets carry tags; a session volume record shows under the exercise name. Started-from routine and version save date link to Versions. Sets numbered W, 1, 2.
- **Exercise page** (`/exercises/{id}`; Library rows open it, Edit goes to the old editor): current records with dates and links, trend chart, every session newest first.
- **Finish summary:** lists new records per exercise, judged against everything on the phone that started earlier.
- **Versions page:** each version lists the workouts that used it, by date, linking to them.
- **Server:** workout responses add `routine_name`, `routine_version_number`, `routine_version_created_at`; the versions list adds `workouts` (the caller's only).
- **Set numbering** on the routine view, version pages, and routine editor (W, then 1, 2, ...). **Up next** in the rest bar now sits on its own full-width line under the timer and wraps.
- **ECharts 6.1.0** (same as Foodlog), pinned; the chart pages are lazy-loaded so the main bundle stays about the same size (ECharts is a separate 175 kB gzipped chunk).
- **Tests:** 69 backend (one new: workouts name their routine version; the versions list holds only the caller's workouts, even with the other user's workout put on that version by hand; another user's versions list and version are 404), 56 frontend (new `tests/stats.test.ts`: every record type, dominance, which set counts when several qualify at the same weight, ties, the baseline, warm-ups, 0.05 kg across units, imported and queued workouts, best set per workout, no 1RM for weighted bodyweight, Epley, the finish summary, body-part volume weights, unassigned, Monday weeks and the 4 AM rollover).
- **Checked once, not kept:** the functions on a read-only export of the live history: heaviest bench is 225 lb on Oct 10, 2026, matching a SQL query, and last week's (Sep 28) chest count was 4 by both the function and a hand-count query. The new pages rendered in headless Chromium at 360 px wide, light and dark, with no page overflow and no console errors.

### Choices made while building (not in the spec)

- History, the calendar, and the stats pages read the offline copy on the web too (refreshed when they open, after imports and exercise edits). The paged `GET /api/workouts` is no longer used by the app.
- Weight records need at least 1 rep. A record also needs an earlier value of that type to beat, so the first session with, say, a weighted set is that type's baseline.
- If several sets in one workout qualify for best reps at a weight, the heaviest (then the most reps) is the record.
- Volumes count as equal within 0.05 kg per rep; distances within half a millimeter.
- The exercise page shows the frontier of best reps at each weight (up to 8, heaviest first).
- Assisted exercises show "No records for assisted exercises yet." and no chart.
- In the Muscles chart, a week with no workouts has no bar; a week with workouts but none for that muscle shows 0.
- The calendar starts on Monday, like the volume weeks.

| Check | Result |
|---|---|
| HANDOFF.md has no deployed version line and shows the live-check commands | done |
| Trav's heaviest bench and its date on the exercise page match his history | 225 lb, Oct 10, 2026 on the live data; pending on the page |
| A record shows on the finish summary and its set is tagged on the detail page | tested; tags seen in headless Chromium; pending on phone |
| Airplane mode: a just-finished workout shows as Waiting to upload with its records counted; the label clears after upload | pending on phone |
| Calendar marks this month's workout days | Oct 5, 6, 7, 9, 10 marked in headless Chromium; pending on the real page |
| Last week's chest number matches a hand count | 4 and 4 (Sep 28 week, live data) |
| Workout detail names its routine version; Versions lists that workout | tested; pending on the page |
| Wife sees only her own records and volume | computed only from her own copy; versions list isolation tested; pending on her phone |
| Tests pass; dump first; memory under limits; web and APK same commit | 69 backend, 56 frontend, build passes; deploy pending (Trav) |
| Routine with two warm-ups shows W, W, 1 on its view page and in the editor | pending on the page |
| Three-exercise superset shows every name in full under Up next at normal text size | pending on phone |

## 14. Spec 6b: editing and deleting finished workouts

**Status:** built and tested. Migration `0009`. Rules are in section 18. What's deployed comes only from the live checks in section 3.

- **Migration `0009`:** `workouts.edit_revision` (0) and `workouts.deleted_at`. A trigger lets them change only inside `edit_finished_workout()`, which now bumps the revision on every call, sets `deleted_at` when asked, and refuses a deleted workout. Downgrades and upgrades cleanly (checked once against the test database with an edited workout in it; not kept). A downgrade brings deleted workouts back into every list, since the column goes away.
- **Server:** `POST /api/workouts/{id}/edit` (whole workout plus `base_revision`; 409 `edit_conflict` when stale; 422 with a plain reason; identical saves write nothing) and `DELETE /api/workouts/{id}` (soft, 204). Workouts carry `edit_revision` and `edited_at`. Deleted workouts are left out of history, the detail page, the offline copy, both exports, save as routine, and the Versions list. An upload under a deleted id is 410 `workout_deleted`.
- **Editor** (`/workouts/{id}/edit`, from Edit on the detail page): title, notes, start date and time in your timezone, duration in hours and minutes, exercises (add from the library, remove, reorder by buttons or drag, supersets, notes), and sets (add, remove, move, type, RPE, and the workout screen's own number fields). Inline heavy weight warning; Save opens a confirm screen with the date, duration, counts, and any flagged weights (tap one to jump to it). A conflict offers to load the latest. Leaving with unsaved changes asks first.
- **Delete:** on the detail page, after "It will disappear from your history, records, and exports, on every device. This can't be undone."
- **Offline:** Edit and Delete are disabled with "Editing and deleting need a connection." The editor keeps typed changes but won't save until the connection is back.
- **Phone:** a 410 drops the workout from the queue (no Needs attention). After a save or delete, this device updates its copy right away and refreshes; others catch up on their next refresh.
- **Labels:** "Edited" with the last edit's date in History, on exercise pages' session lists, and on the detail page.
- **Tests:** 86 backend (new `tests/test_edits.py`: one change log row with before and after and the revision bump; an identical save writes nothing; a stale revision is 409; 422 and nothing written for a bad weight, no exercises, an exercise with no sets, zero duration, and an end in the future; the date on a time edit, with the 4 AM rollover; delete with its log row and gone from history, the offline copy, both exports, and the one-workout export; 410 on upload; a retried first upload after an edit is 200 and changes nothing (upload_hash unchanged) while other content is 409; a deleted workout leaves save as routine and the Versions list but keeps its version; Hevy re-import skips a deleted import; with both users holding workouts, edit and delete of the other's are 404 and each can edit and delete their own; a direct UPDATE of `deleted_at` or `edit_revision` is rejected, and no new workout can start deleted), 59 frontend (new: a record moves when an edit removes its set; the queue drops a 410 without Needs attention; the copy drops a deleted workout and replaces an edited one in start order).

### Choices made while building (not in the spec)

- **The retry rule uses `upload_hash`.** The spec says to compare with the earliest change log row's before snapshot. `upload_hash` is the first upload's hash and edits never touch it, so it answers the same question, and it compares upload to upload, the way section 10's trailing-zero and microsecond fix needs. No snapshot comparison was written.
- **Every exercise needs at least one set,** not just one of them: finished workouts never have an empty exercise, and the reason names it ("Bench Press has no sets. Add a set or remove the exercise.").
- **Times keep their seconds** unless changed: a start unchanged to the minute keeps the stored `started_at`, and an unchanged duration keeps `ended_at`. Changed times are whole minutes. `workout_date` is recomputed only when the start changes, so a later timezone change in Settings doesn't make an unrelated edit move the workout's day.
- **Hidden set values are kept.** A value a set holds that its exercise's current logging type doesn't show (say a weight on an exercise switched to bodyweight later) is sent back unchanged, never dropped by an edit.
- **Rest isn't editable** (not in the spec's list); each exercise keeps the rest it used, following a superset's first exercise when the order changes.
- **Superset groups compare after renumbering,** so an import's Hevy group numbers don't make an unchanged save look like an edit. Supersets in the editor follow the upload's rules (runs over three are split), not the routine editor's refusal, so an import with a bigger superset can still be edited.
- **The no-op comparison normalizes text** the way the save stores it (title spaces collapsed, notes trimmed), so stray whitespace in an imported title doesn't count as a change.
- The delete confirmation's main button is the app's primary (accent) button; there's no separate danger color in the palette.
- The editor gets exercise names and logging types from the offline copy (refreshed when it opens), since it includes archived exercises.

| Check | Result |
|---|---|
| A workout left running for hours gets its real duration; History and the detail page show it and "Edited" | duration rule tested; pending on the page (Trav) |
| Moving a start into the previous week moves it on the calendar and changes both weeks' volume | date recompute tested; volume reads the copy; pending on the page |
| Adding one exercise and removing another shows on the detail page and both exercise pages | pending on the page |
| Editing down a record's set moves the record and the exercise page updates | rule tested; pending on the page |
| Editor open on desktop and phone, save on both: the second shows the conflict and reload; the first save is intact | stale revision tested; pending on devices |
| Delete on desktop: gone from History, calendar, records, exports, and from the phone after its refresh | server side and cache update tested; pending on devices |
| Airplane mode: Edit and Delete disabled with a reason | pending on phone |
| A hand-run UPDATE of `deleted_at` in psql is rejected | tested; on live: `docker compose exec db psql -U liftlog -c "UPDATE workouts SET deleted_at = now()"` should fail |
| Wife can't see, edit, or delete his workouts, and can edit and delete her own | tested; pending on her phone |
| Tests pass; dump first; memory under limits; web and APK same commit | 86 backend, 59 frontend, build passes; deploy and APK: check live (section 3) |

## 15. App update in Settings

**Status:** built and tested. No migration, no new route, no plugin or permission. Rules are in section 23. What's deployed comes only from the live checks in section 3.

- **Root cause:** no commit removed it. The Android app's Settings has never had an update link. Since Spec 3 (`688e3de`) the About card's `/download` link, Get the Android app, has been browser only (`Capacitor.isNativePlatform()`); in the app that slot held Rest timer test. Spec 5a (`3a3e271`) removed the timer test screen and left the slot empty in the app. Specs 6 and 6b never touched `Settings.tsx` (last changed in Spec 5b, `99a0d52`, which only added cards). Nothing else was hidden by any of those changes; the timer test's removal was intended and is recorded in section 5. The link that was seen was most likely Settings in a phone's browser, or `/download` opened by hand.
- **Settings, About:** Version shows `__BUILD_ID__`, which in the APK is its version name (like `32-55487bd`, the same as `/download`) and on the web the short commit. In the app, Update app opens `/download` in the phone's browser (a link to the server's host, like Export). In a browser, the plain Get the Android app link stays.
- **Update available:** when Settings opens in the app with a connection, it fetches `GET /api/app/latest` (the `/download` page's own source, `data/apk/version.json`; the app already reached it through the auth middleware and CORS) and compares `version_name` with the installed version. Different: "Update available", the new version, and an Update button to `/download`. Same, offline, a failed fetch, or no version: nothing.
- **Tests:** 86 backend (unchanged), 63 frontend (new `tests/appUpdate.test.ts`: the same version shows no notice; a different one shows it, older too; a failed fetch shows nothing; a missing, empty, or non-text version shows nothing).

### Choices made while building (not in the spec)

- One check per Settings visit: it runs when Settings mounts with a connection; it doesn't recheck on focus or when the network comes back while Settings is open. Going offline hides a notice already shown.
- The notice's button reads "Update to <version>"; the always-there button reads "Update app".
- A test build made with `ALLOW_DIRTY=1` has a version name ending in `-dirty`, which `__BUILD_ID__` cuts to 12 characters, so it always shows Update available. Published builds are clean.

| Check | Result |
|---|---|
| Both phones: Settings shows the installed version, and Update app opens `/download` in the browser | pending on phones (Trav) |
| Desktop browser: Settings shows the link and the build version | unchanged code path; pending in the browser |
| Airplane mode: Settings shows the version and no notice | rule tested; pending on phone |
| Next deploy (Spec 7): both phones show Update available with the new version, the button opens `/download`, and the notice is gone after installing | pending at Spec 7 |
| Tests pass; dump first; memory under limits; web and APK same commit | 86 backend, 63 frontend, build passes; deploy and APK are Trav's to run, then check live (section 3) |

## 15a. Spec 7: body measurements, and moving off Hevy

**Status:** built and tested. Migration `0010`. Rules are in section 28. What's deployed comes only from the live checks in section 3.

- **Migration `0010`:** `users.length_unit` (`in` or `cm`, default `in`) and `users.body_seeded`; tables `measure_sites`, `measure_checkins`, `measure_values` (section 17). The limits are constraints: values 1 to 300 cm normalized with at most two decimals as entered, body fat 1 to 75 with at most two decimals and always a method, one check-in per user per date, one value per site and side per check-in, and a site with values can't be deleted (RESTRICT). Downgrades and upgrades cleanly, and each constraint refuses a bad row written straight to the database (both checked once against the test database; not kept).
- **API** (`app/routers/body.py`, rules in `app/body.py`): `GET /api/body`, `POST/PATCH/DELETE /api/body/sites[/{id}]`, `POST /api/body/checkins`, `PUT/DELETE /api/body/checkins/{id}`. `PATCH /api/me` takes `length_unit`. The offline copy has `body`; the JSON export has `measurements` and `user.length_unit`, `schema_version` 2.
- **Pages:** the bottom nav is Routines, History, Body, Library, Settings. `Body.tsx` (`/body`), `BodyCheckin.tsx` (`/body/checkins/new` and `/body/checkins/{id}`), `BodySite.tsx` (`/body/sites/{id}`, loads ECharts lazily), `BodySites.tsx` (`/body/sites`, Manage sites). Settings has Body measurements: Inches or Centimeters.
- **Tests:** 92 backend (new `tests/test_body.py`: seeding, isolation for sites and check-ins with both users' data, the 422s with nothing written, exact inches beside cm, a second entry replacing the first, delete versus archive; `tests/test_export.py` now checks measurements are the caller's only and every field is there), 67 frontend (new `tests/body.test.ts`: since previous and since first with a skipped middle check-in, exact versus converted changes, display that never drifts, body fat across methods), build passes.

### Choices made while building (not in the spec)

- **Changes need a check-in that included the site.** A site measured once shows its value and no change. "Since first" is hidden when the first is also the previous (it would repeat the same figure).
- **Body fat compares with the reading right before it** and with the first, each only when the method matches. Calipers after smart scale shows no change and says why. Back on the scale after calipers: no change since previous (calipers), but since first shows if the first was by scale.
- **Changes:** both values in the display unit: exact, to the hundredth. Otherwise from cm, to 0.1. Converted values show to 0.1. Body fat changes are in points ("-0.75 points").
- **Adding on a date that has a check-in opens it,** including Add when today already has one. Anything typed before picking that date goes on top of what's there. Moving a check-in onto another one's date is refused (409 `date_taken`), not merged. On the server, `POST` to a taken date adds to that check-in: values given replace that site and side, body fat replaces if given, notes replace if not empty.
- **A check-in needs at least one value or body fat** (422 `empty_checkin`). Removing everything is Delete.
- **Sides:** a paired site takes left and right separately; either can be empty. Whether a site is paired is set when it's added and can't change.
- **Units per value:** a new value is in the display unit; an existing value keeps its own unit in the editor (shown beside the field) until cleared.
- **Archived sites** leave the Body tab and the editor, but the editor still shows one that the check-in being edited has a value for, and its site page still opens from a link.
- **Standard names:** Waist, Chest, Hips, Neck, then paired Arms, Forearms, Thighs, Calves. Seeding skips a name the user already has.
- **A second chart color**, `--chart-2` (`#1468A0` light, `#3E9CC8` dark), for the right side. Checked with a palette validator against `--accent-text` on `--surface` in both themes (lightness, chroma, colorblind and normal-vision separation, contrast). The right side also has a dashed line and hollow diamonds, so color isn't the only cue, and the legend is plain HTML above the chart.
- **Both exports' JSON** carries measurements, the one-workout export too, since it is the same document.
- **Not rendered here:** the host has no browser, so the pages were checked by build and type check only. The acceptance runs below are their first look.

| Check | Result |
|---|---|
| Trav's phone: check-in with waist, both arms, body fat by smart scale; desktop shows it | pending on phone (Trav) |
| A second check-in skipping one site: changes for those measured; the skipped site keeps its latest | rule tested; pending on phone |
| Switch to cm and back: converted, then the inch values exactly as entered | rule tested; pending on phone |
| Calipers after smart scale: no change figure | rule tested; pending on phone |
| A custom single site: add, measure, archive | pending on phone |
| Airplane mode: Body shows cached data; Add disabled with a reason | pending on phone |
| JSON export includes sites and check-ins | tested; pending in the browser |
| Trav's wife sees only her own measurements | tested; pending on her phone |
| Both phones show Update available with the new version, the button opens `/download`, the notice clears after installing (closes the 6b follow-ups check) | pending after this deploy |
| Trav's wife imports her Hevy CSV: counts match her CSV's rows; oldest, a superset, and newest match the Hevy app; then neither logs in Hevy | pending (Trav's wife, Settings, Import) |
| Tests pass; dump first; memory under limits; web and APK same commit | 92 backend, 67 frontend, build passes; deploy and APK are Trav's to run, then check live (section 3) |

## 16. Known gaps

- Routine editing needs a connection. Offline editing comes after v1 (the conflict check and client ids are ready for it).
- Records for assisted exercises. Undoing an edit or delete, and a screen for browsing the change log, are out of scope for v1. Flagging long workouts at finish is banked.
- The triggers' escape hatch is a transaction-local setting, so someone with direct database access can still set it by hand. The rule they enforce is against accidents and app bugs, not the database owner.
- Deleting a user who has finished workouts is refused by the triggers (no flow deletes users).
- Reordering while archived routines are hidden leaves their positions alone, so a restored one can land between others.
- Weight targets keep the unit they were entered in. Changing your weight unit in Settings doesn't convert existing targets.
- The app uses Capacitor's default launcher icon and splash.
- `localStorage` still holds the last-seen play through silent setting (`timer/alertSetting.ts`); everything else on the phone is in IndexedDB.
- Muscle arrays are checked against the vocabulary in the API, not by a foreign key.
- Measurements can't be entered offline (out of scope for v1), and a site's paired flag can't change after it's added.
- The database doesn't check that a value's side matches its site being paired, or that the site belongs to the check-in's user; the API does both.
- Adding a catalog exercise you already have returns your copy; delt choices on the import screen don't change an existing copy.
- Re-importing a file with nothing new still writes an import record (all skipped), which is how the skip counts are reported.

# Area reference (moved from CLAUDE.md)

Sections 17 to 27 hold the detail that used to load with `CLAUDE.md` every session. `CLAUDE.md` keeps the standing rules and points here by section number. Read a section before working in its area.

## 17. Data model

Primary keys are UUIDv7 (`models.uuid7()`). Clients may send their own ids (offline sync); the API accepts any UUIDv7, returns the existing row if it's already the caller's, and answers 409 if it belongs to someone else. Workout uploads differ: someone else's workout id is 404 (see Offline model and sync). The server makes ids for imports.

| Table | What |
|---|---|
| `catalog_exercises` | free-exercise-db, pinned commit, loaded by `0002` from `backend/app/seed/free-exercise-db/` (see `SOURCE.md` there; Unlicense). Read-only by trigger. Dataset muscle words unchanged. |
| `muscles` | The vocabulary: the dataset's muscle groups (spaces become underscores, `middle back` is `middle_back`), with `shoulders` replaced by `front_delts`, `side_delts`, `rear_delts`. |
| `users` | One per Tailscale login, made on the first request. Display name, timezone (default America/Los_Angeles), weight unit (lb), distance unit (mi), `play_through_silent` (off), `default_bar_id` and `default_plate_set_id` (plate math), `gear_seeded`, `length_unit` (in), `body_seeded`. |
| `user_exercises` | A user's own exercises: a copy of a catalog entry (`catalog_id`) made the first time it's added or imported, or custom (no `catalog_id`). Name unique per user, case-insensitive. Equipment, logging type, primary and secondary muscle arrays (checked against `muscles` in `app/library.py`), `needs_review`, `archived`, and plate math: `bar_id` and `plate_set_id` (null means the user's default; ON DELETE SET NULL) and `plate_math` (on for barbell exercises when made). |
| `muscle_map_changes` | Every muscle edit: when, old map, new map. Reports always compute from the current map. |
| `workouts` | Title, `started_at`/`ended_at` (timestamptz, from the phone's clock), `workout_date` (computed at upload from `started_at`, `app/dates.py`: user's timezone, 4 AM rollover), notes, `source` (`liftlog` or `hevy_import`), `import_id`, for imports `import_key` (unique per user) and `import_hash`, for uploads `upload_hash` (the first upload's; edits never change it), `edit_revision` (0, plus one per change log row), `deleted_at` (soft delete). Finished ones are immutable (see below). |
| `workout_exercises` | Position, `superset_group`, notes, `logged_name` (the name then; display uses the exercise's current name), `rest_seconds` (the rest it used; for a superset's first exercise, the rest after each round; null for imports). |
| `sets` | Position, `set_type` (normal, warmup, drop, failure), weight as entered (`weight_value`, exact numeric) plus `weight_unit` plus `weight_kg`, reps, RPE (6 to 10 in half steps), duration, distance as entered plus `distance_m`, `completed_at` (null for imports). For assisted bodyweight, weight is the assistance. Upload limits under Set field limits. |
| `workout_changes` | The record for edits to finished workouts (before, after, reason `edit` or `delete`), written only by `edit_finished_workout()`. An audit trail only: no screen reads it. |
| `imports` | One per import run: file SHA-256, time, workouts and sets added, skipped, conflicting. The CSV itself is never stored. |
| `hevy_title_mappings` | A Hevy exercise title resolved to one of the user's exercises, so later imports don't ask again. |
| `routine_folders` | A program ("Upper/Lower", "PPL"). Name, `position` (user order), `archived`. |
| `routines` | One day ("Day 4: Deadlift"), in a folder or not (`folder_id` null). Name, `position` within its folder, `archived`, `current_version_id`. |
| `routine_versions` | Immutable content of a routine: `number` (1, 2, 3 per routine), `parent_version_id` (the version it was edited from; a plain id with no foreign key, since that version is usually pruned), `superset_rests` (JSONB, group to seconds). Only the current version and versions a workout used are kept. |
| `routine_exercises` | Per version: position, user exercise, `superset_group` (up to three adjacent exercises, numbered 0, 1, 2 per version), notes, `rest_seconds`. |
| `routine_sets` | Per-set targets, all optional: `set_type`, `reps_min`/`reps_max` (equal for a fixed number), weight as entered plus unit plus kg, RPE, duration, distance as entered plus meters. |
| `bars` | A user's bars (or sleds): name, weight as entered plus unit plus kg (0 to 2,000, at most 2 decimals so plate math stays in whole hundredths; 0 is allowed for a sled). |
| `plate_sets` | A user's plate sets, by name. |
| `measure_sites` | A user's places to measure: name (unique per user, case-insensitive), `paired` (left and right), `archived`, `position` (standard sites first, then custom in the order added). |
| `measure_checkins` | One date's measurements, at most one per user per date: `date`, `body_fat_pct` (1 to 75, at most 2 decimals) with `body_fat_method` (`calipers`, `smart_scale`, `dexa`, `navy_tape`, `visual`, `other`; both or neither), `notes`. |
| `measure_values` | Per check-in: `site_id` (ON DELETE RESTRICT), `side` (`left`/`right` on a paired site, null on a single one; unique per check-in and site, nulls not distinct), `value` as entered (exact numeric, at most 2 decimals) plus `unit` (`in` or `cm`) plus `value_cm` (1 to 300). Deleted with their check-in. |
| `plates` | The plate sizes in a set: name (defaults to the weight, like "45 lb"), weight as entered plus unit plus kg (above 0), `enabled`, `pair_count` (1 to 99, null for unlimited). Deleted with their set. |

`workouts.routine_version_id` (null for imports and empty workouts; foreign key ON DELETE RESTRICT, added in `0005`) records the version a workout started from. The upload writes it. Workouts from the API (and in the offline copy) also carry `routine_name`, `routine_version_number`, and `routine_version_created_at`, so the detail page can name the version offline. `GET /api/routines/{id}/versions` lists, per version, the caller's workouts that used it (`workouts`: id, title, date, newest first); another user's routine is 404.

Migrations: `0010` is the latest as of Spec 7; the next is `0011`.

**Finished workouts are immutable in Postgres** (`0007`). Triggers reject UPDATE and DELETE on a workout with `ended_at` set, and INSERT, UPDATE, and DELETE on its `workout_exercises` and `sets`, with two exceptions: the transaction that created the workout (an insert trigger records its id in the transaction-local setting `liftlog.new_workouts`; that's how the upload and the Hevy import write their rows), and `edit_finished_workout(change_id, workout_id, reason, after)`, which applies `after` (a `workout_snapshot()`-shaped document: title, notes, times, date, and when present all exercises and sets) and writes the matching `workout_changes` row with the before and after, signalling the triggers through the transaction-local setting `liftlog.editing_workout`. Any future edit flow must go through that function. A hand-run `UPDATE` in psql is rejected. Deleting a user with finished workouts is refused too. Since `0009`, `edit_revision` and `deleted_at` change only inside that function (a trigger refuses any other write to them, even in the creating transaction, and a new workout must start at revision 0, not deleted); the function bumps `edit_revision` on every call, sets `deleted_at` when `after` has it, and refuses a deleted workout.

Copying a catalog exercise tagged shoulders turns shoulders into the delts its name suggests (`catalog.suggest_delts`: rear delt, reverse fly, face pull are rear; lateral or side raise is side; press and front raise are front) and sets `needs_review`. Saving the muscles (library edit, or "these delts are right" on the import screen) clears it.

## 18. Editing and deleting finished workouts

Routes in `app/routers/workouts.py`: `POST /api/workouts/{id}/edit` and `DELETE /api/workouts/{id}`. Pages: `WorkoutEdit.tsx` (`/workouts/{id}/edit`, laid out like the routine editor; form and save body in `lib/edit.ts`), Edit and Delete on `WorkoutView.tsx`.

- **What can be edited:** only workouts the server has (imports too; they keep their imported label). Queued and Needs attention workouts are fixed with Reopen. Title, notes, start date and time (the user's timezone), duration (hours and minutes; `ended_at` is start plus duration), exercises (added from the library, removed, reordered with `reorder.ts`, superset grouping, notes), and per set: add, remove, move, type, and weight, reps, RPE, time, distance by logging type. Not the rest, not the routine version link. No rest timer, no plate math. Set inputs are the workout screen's (`components/NumField.tsx`, `INPUT`, `setProblem`). Values a set holds that its logging type doesn't show are kept, never dropped.
- **Needs a connection** (web and app), like routines and gear. Offline, Edit and Delete are disabled with a reason.
- **Times:** a start unchanged to the minute keeps the stored `started_at` (seconds and all), and an unchanged duration keeps `ended_at`, so a save with no time edit changes no time. Duration must be over zero, `ended_at` can't be in the future, no upper limit. A new start recomputes `workout_date` (4 AM rule).
- **Validation is the upload's:** the same field limits and 422 `bad_set` reason, plus at least one exercise and a set in every exercise (removing everything is Delete). Nothing is written on a 422. The heavy weight warning shows inline and on the save confirm screen, against history without this workout.
- **Saving** sends the whole workout with `base_revision`. Not the current `edit_revision`: 409 `edit_conflict`, nothing written; the editor offers to load the latest. Otherwise the server compares the submission with what's stored (text as it would store it, superset groups after renumbering, values normalized); identical is a no-op with no row. A real change goes through `edit_finished_workout()` in one transaction: one `workout_changes` row (`edit`, full before and after). Kept sets keep `completed_at`; added sets have none and count like any other.
- **Delete** is soft: `deleted_at` through the same function (`delete`, with the before), after a confirmation. No undo. A deleted workout is left out of every read: history, the detail page (404), the offline copy (so records, the finish summary, prefill, rest, the last-session strip, the heavy weight warning, body-part volume, and the calendar), both exports, save as routine, and the Versions list. It still references its routine version, so that version is never pruned and its routine can only be archived. A Hevy re-import still sees its `import_key`, so it's skipped and never comes back.
- **Uploads after an edit or delete:** a PUT under a deleted id is 410 `workout_deleted` and writes nothing; the phone drops it from the queue (not Needs attention). A PUT matching the first upload (`upload_hash`, which edits never change) is still 200 and changes nothing; anything else is 409 as before.
- **The phone's copy:** the device that saved puts the edited workout in its copy (or takes the deleted one out) at once, then refreshes; other devices catch up on their next refresh, which replaces the whole history. History and the detail page show "Edited" with the last edit's date (`edited_at`).
- Another user's workout is 404 to edit and delete.

## 19. Hevy import

`app/hevy.py`, routes in `app/routers/imports.py`, page `src/pages/Import.tsx`. Parsing is adapted from Foodlog's importer (copied, not shared).

1. **Preview** (`POST /api/imports/hevy/preview`, the file): parses every row (any unreadable row rejects the whole file), detects lb or kg and mi or km from the column names, reads Hevy's zoneless times as the user's local time, groups each run of rows for the same exercise into one workout exercise, and classifies each workout by its key (start time to the minute plus title): new, skipped (key exists, same content hash), or conflicting (key exists, different content; never overwritten). It lists every exercise title in the new workouts that has no saved mapping, with the top three catalog matches and similar exercises of the user's.
2. **Review**: per title, accept a match, search the catalog, merge into an existing exercise, or make a custom one; confirm delts for shoulder exercises.
3. **Import** (`POST /api/imports/hevy`, the file again plus the choices): refuses with 422 and writes nothing unless every title is resolved, then creates the exercises, saves the title mappings, writes the import record and every new workout, and commits it all in one transaction.

Mapping: `superset_id` to superset group, `set_type` to ours (`dropset` to `drop`), `rpe`, `exercise_notes` (Hevy's literal `\n` becomes a line break), workout `description` to notes.

## 20. Routines

Routes in `app/routers/routines.py`; pages `Routines.tsx`, `RoutineView.tsx` (`/routines/{id}`, read-only, with Edit), `RoutineEdit.tsx` (`/routines/{id}/edit`), `RoutineVersions.tsx`; save as routine is on `WorkoutView.tsx` and lands on the view page with a confirmation naming the folder.

- **Versioning and pruning.** Every save of a routine's content (`POST /api/routines/{id}/versions`) writes a new version and moves `current_version_id`. In the same transaction it deletes the version it replaced, unless a workout references it (`workouts.routine_version_id`). So a routine keeps its current version plus every version a workout used, and nothing else. Versions never change once written (a trigger rejects UPDATE), and Postgres refuses to delete one a workout references (RESTRICT). Renaming, moving, archiving, and reordering change the routine row only. `0006` pruned every existing non-current version once. Pruned versions can't be restored.
- **Conflicts.** A save sends `parent_version_id`. The check runs before pruning and compares it to the routine's current version: if it isn't current (including when that parent has since been pruned), the answer is 409 `version_conflict` and nothing is written or pruned; the editor offers to load the latest. Never overwrite. This is what makes offline editing (after v1) safe.
- **Ids.** Folder, routine, version, exercise, and set ids may come from the client (UUIDv7). A retry with the caller's own id returns the existing row; someone else's id is 409.
- **Delete or archive.** A routine or folder can be deleted only if no workout references any of its versions (`workouts.routine_version_id`); deleting a folder deletes its routines. Otherwise only archive (409 `in_use`; the RESTRICT foreign key refuses it in Postgres too). Restoring a routine restores its folder.
- **Supersets.** The API rejects a split group or more than three; a group of one is dropped. Save as routine splits a workout's groups into runs of three.
- **Superset move rules** (`frontend/app/src/lib/reorder.ts`, pure, tested in `frontend/app/tests/reorder.test.ts`; use it wherever exercises are reordered or removed, including the workout Overview): moving an exercise within its own superset keeps it in the group. Moving it past the group's first or last exercise takes it out; with the buttons, one step past an edge leaves the group and stays next to it. A lone exercise never lands inside another superset; it goes past the whole group. A whole superset moves as one unit from its header, by drag and by buttons. The rest after each round stays with the group's first exercise. Every move is announced to screen readers (`describeExercise`, `describeUnit`). Removing an exercise (`removeExercise`) keeps the rest of its superset grouped when two or more remain; a lone survivor becomes standalone. The editor's reorder mode is `components/ExerciseOrder.tsx`, also used by the workout Overview.
- **Save as routine** (`POST /api/routines/from-workout`): exercises, order, supersets, notes, set types, and each set's weight and reps (plus duration and distance) become fixed targets. RPE is not copied.

## 21. Plate math and gear

Gear routes in `app/routers/gear.py` (`GET /api/gear`, `PATCH /api/gear/defaults`, `POST/PATCH/DELETE` for `/api/gear/bars[/{id}]`, `/api/gear/plate-sets[/{id}]`, `/api/gear/plate-sets/{id}/plates`, `/api/gear/plates/{id}`; every change answers with the whole gear), presets and seeding in `app/gear.py`, page `src/pages/Gear.tsx` (`/settings/gear`), math in `src/lib/plates.ts`, sheet in `components/PlateSheet.tsx`.

- **Gear is per user, on the server.** The first `GET /api/gear` or `GET /api/offline` copies in the v1 presets (`docs/v1-scope.md`) once (`users.gear_seeded`, under a row lock): the five bars in the user's weight unit and all three plate sets. Defaults become the Olympic barbell and the Olympic plates in their unit. Users add, rename, change, and delete bars, plate sets, and plates, turn plates on or off, and set pair counts. The current default bar or plate set can't be deleted (409 `is_default`). Deleting any other one sets exercises that used it back to the default.
- **Per exercise** (Library editor): Show plates (`plate_math`), bar, and plate set. Shown for logging types with a weight. Picking barbell equipment turns Show plates on.
- **Offline:** gear is in the offline copy (`gear`). Editing it needs a connection, like routines.
- **The rule** (`plateMath`, pure, tested in `tests/plates.test.ts`): exact search over pairs per side, never greedy, respecting pair counts, plates turned off, and the workout's left-out plates. Ties: fewest plates, then fewest distinct sizes, then heaviest plates first (90 lb per side is 45 and 45, not 55 and 35). Plates per side are listed heaviest first with counts, plus the bar and the total, as text. A target the plates can't make shows the nearest load below and above; tapping one sets that set's weight. A target under the bar says so, with the bar's weight, and shows the empty bar. When the bar, every plate in use, and the target share a unit, the math runs in whole hundredths of it, so 137.5 lb never becomes 137.49 (gear has at most 2 decimals; only a target typed with more makes the steps finer). Mixed units run in whole grams and show rounded to 0.1 in the set's unit, and since rounded grams of different units rarely line up (1.25 lb is 566.99 g), a load that shows as the target to 0.1 counts as an exact hit. A target past the heaviest load the plates can make shows that load and nothing above. Keep the file free of runtime imports.
- **At the gym:** the weight field's plate button (exercises with plate math on) opens the sheet. Plates unchecked there are left out for this workout only: saved in the workout in progress (`excluded_plates`), applied to every exercise in it, listed on the sheet, and gone when it finishes or is discarded. They never change the saved gear.

## 22. Export

Routes in `app/routers/export.py`: `GET /api/export?format=json|csv` (full history) and `GET /api/workouts/{id}/export?format=json|csv` (one workout; someone else's is 404). File downloads named with the date (`liftlog-history-<today in the user's timezone>`, `liftlog-workout-<workout date>`). Buttons on the History detail page and Settings, Export (`/settings/export`). Browser only: in the Android app those places show Open in browser (`components/ExportLinks.tsx`), a plain link to the same page on the server's host; Capacitor hands links to other hosts to the phone's browser, so there's no browser plugin. Workouts still on a phone appear once they upload. Deleted workouts never appear.

- **JSON** is the lossless backup: `schema: "liftlog-export"`, `schema_version` 2 (2 added measurements), `scope` (`history` or `workout`), the user's settings (with `length_unit`), the workouts with every stored field (weights as entered plus unit plus kg, ids, `routine_version_id` and `routine_id`, import and upload hashes, timezone-aware timestamps), every exercise, folders and routines (archived too) with each routine's current version, gear, and `measurements` (every site, archived too, with `created_at`, and every check-in with its values as entered plus unit plus cm). One workout exports the same document with only that workout. The CSV has no measurements.
- **CSV** is Hevy's workout export layout, verified against Trav's real export: the same 14 columns in the same order, text quoted and numbers bare, newest workout first, one row per set, `set_index` from 0 per exercise, `dropset` for drop sets, the superset group as `superset_id`, line breaks in notes as a literal `\n`, `\n` between rows and none after the last. Weights in the user's weight unit (`weight_lbs` or `weight_kg`), distances in their distance unit, each as entered when it's already in that unit, else converted from kg or meters and rounded to 0.01. Times in the user's timezone like `6 Oct 2026, 16:19`, no offset. Workouts only; exercises use their current names. Importing Trav's real file and exporting it gives the same bytes. The round trip through the Hevy importer is tested.

## 23. App updates

The Android app updates from the browser download on `/download`; nothing installs inside the app. Settings, About (`pages/Settings.tsx`, `AppUpdate`):

- **Version** is `__BUILD_ID__`: in the APK, its version name (`<code>-<commit>`, the same text `/download` shows, set by `scripts/android-build.sh`); on the web, the build's short commit.
- **Update app** (Android app only) is a plain link to `/download` on the server's host, so Capacitor opens it in the phone's browser, like Export. In a browser it's the plain `/download` link, Get the Android app.
- **Update available:** each time Settings opens in the app with a connection, it fetches `GET /api/app/latest` once (the same `data/apk/version.json` the `/download` page reads; no extra route) and compares `version_name` with the installed version (`newerVersion` and `checkForUpdate` in `lib/appUpdate.ts`, pure, tested). Any difference is an update, with no ordering. A difference shows "Update available", the new version, and its own button to `/download`. Offline, a failed fetch, no APK published, or no version: no notice. No polling, no notice anywhere else, no plugin or permission.

## 24. Offline model and sync

Live workouts run only in the Android app; the web build shows routines with no Start button. Code: `src/lib/idb.ts` (storage), `offline.ts` (copy, login check, queue), `active.ts` (workout in progress), `session.ts` (its shape and pure steps), `start.tsx`, `pages/Workout.tsx`, `WorkoutFinish.tsx`, `timer/useRest.ts`.

- **IndexedDB** (`liftlog`, version 1, no packages): `cache` (the copy from `GET /api/offline` under `copy`, with the login it belongs to), `active` (the one workout in progress), `queue` (finished workouts waiting to upload, by id). Writes use strict durability. A new store or index means a new version and an upgrade step.
- **The copy** is the user, every exercise, folders and routines (archived too), each routine's current version, gear (bars, plate sets, plates, defaults), body measurements (`body`: sites and check-ins), and the full workout history (never paged; Trav's is 72 workouts and about 1,000 sets). It refreshes at start, on resume, when the network returns, and after uploads. Pages that read routines, the routine view, and `useMe` use `cached()`: the server when it answers, else the copy. Editing routines still needs a connection. Queries and mutations run with `networkMode: "always"` so they fall back or fail plainly instead of pausing.
- **Login check** (`lib/offlineRules.ts`, pure, tested): the copy belongs to one login. A different login from `/api/offline` replaces it, unless the cached login still has unsynced workouts (queued, or one in progress); then nothing is cleared, refreshing stops, and a plain message asks to switch Tailscale back. Uploads only send workouts whose login matches `/api/me`.
- **In progress:** one at a time, on the device only. Every tap is written before the screen shows it (typing shows first and writes right after). Reopening the app goes back to it. Starting from a routine snapshots its current version (from the server if it answers within 2 s, else the copy), keeps that content with the workout, and records `routine_version_id`; prefill uses `prefill.ts` on the copy plus queued workouts. Empty workouts record none. Removing an exercise from a superset uses `removeExercise` in `reorder.ts` (the rest stay grouped when two or more remain).
- **Rest timer:** completing a set schedules the path A notification for an absolute end time saved with the workout. A superset rests only once every exercise in it has done that round's set, using the superset rest. Defaults: the routine's rest, else the exercise's rest from its most recent workout, else 90 s. The card's plus and minus 15 s change it for this workout. Uncompleting a set, skip, discard, and finish cancel the alert. While the app is in front it takes the alert over and plays it itself, like Spec 2.
- **Finish:** a confirm screen (sets not done and exercises with no done sets are dropped, and it says how many; title and notes editable), then one storage write moves the workout from `active` to `queue`, then an upload. Discard asks first, deletes it, and sends nothing.
- **Volume** (`lib/volume.ts`, pure, tested): completed normal, drop, and failure sets on weight and reps and weighted bodyweight, weight times reps summed exactly per entered unit and converted once into the user's unit. Warm-ups and bodyweight, assisted, duration, and distance exercises add nothing; no counted set is no data, not zero.
- **Set field limits** (the upload checks them in `check_sets()`, `app/routers/workouts.py`; the phone's inputs refuse anything else as it's typed, `INPUT` and `setProblem` in `session.ts`): weight 0 to 9999.99 in its unit with at most two decimals (a fifth digit before the point or a third decimal can't be typed); reps whole, 0 to 999; RPE 6 to 10 in half steps; duration 0 to 86,400 s; distance 0 to 1,000,000 m normalized, at most three decimals as entered. A bad set refuses the whole upload with 422 `bad_set` and a plain reason naming the exercise and the set as the phone numbers it ("Bench Press, set 1: the weight 225265 lb is over the limit of 9999.99."), and nothing is written. Bad input never causes a 5xx. Data already in the database isn't rechecked.
- **Set numbering** (`setLabels` in `lib/format.ts`; everywhere sets are listed: workout card, Overview, last-session strip, workout view, exercise page, routine view and versions (`SetRows`), and the routine editor): warm-ups show "W" and aren't counted, the rest are numbered from 1 in order, and drop and failure sets also get a small tag. Display only: stored positions and prefill matching don't change. The server's reasons use the same numbers ("warm-up 2", "set 3").
- **Heavy weight warning** (`heaviest`, `tooHeavy`, `heavySets` in `session.ts`, tested): a set whose weight is more than 1.5 times the heaviest weight ever logged for that exercise (any set type, compared exactly in kg, over `history()`, so queued workouts count) shows "Check this weight" under it. Never blocks. No history, no warning. The finish screen lists every flagged set; tapping one opens its card with the cursor in its weight.
- **Card flow:** the rest bar says what's on the next card ("Up next" over "Squat", or a superset's exercises), never the current exercise. The names wrap below "Up next" onto as many lines as they need, at body text size or larger, never truncated; on the last card it says "Last exercise", and Next exercise becomes Finish (opens the confirm screen; Finish at the top stays). RPE is set from the set's sheet (tap the set label) and shows under the row, which leaves the weight field room for 9999.99 at full size on a 360 px wide screen.
- **Sync contract:** `PUT /api/workouts/{id}` with the whole finished workout under its client UUIDv7 (title, notes, `started_at`, `ended_at`, `routine_version_id`, exercises with ids, superset groups, notes, rest, and done sets with ids). New: 201. Same id, same content (SHA-256 of the canonical body in `upload_hash`): 200, nothing changes. Same id, different content: 409 `workout_conflict`, never overwritten. A deleted workout's id: 410 `workout_deleted`, nothing written. After an edit, the first upload still matches (the hash is the first upload's). Someone else's id: 404. A taken exercise or set id: 409. The server computes `workout_date` and `logged_name`. The body also carries `routine_version`, the started-from version's content as the phone snapshotted it; it isn't part of the hash. **Recreation rule:** if `routine_version_id` no longer exists (the routine was edited elsewhere and the version pruned while the workout was offline), the server recreates it from that content under its original id, as an older version (not current, no parent, fresh ids for its exercises and sets, its old number unless taken), so the workout keeps its link and Versions lists it. Only when its routine belongs to the caller (someone else's routine or exercise is 404, and nothing is recreated) and no version has that id. If the routine was deleted, or the body has no version content, the workout is stored without the link.
- **Upload loop** (`lib/uploader.ts`, pure, tested): oldest first, only the signed-in login's workouts. No connection or a 5xx stops the loop and everything stays queued. A 410 (deleted on the server) drops the workout from the queue. Uploads run on finish, at start and resume, when the network returns, and from Retry in the waiting bar.
- **Needs attention:** a workout the server refuses (409 or any other 4xx) is marked with the reason and shown under Needs attention in the waiting bar. It isn't retried automatically and never blocks the rest of the queue. It shows the server's own reason (for 422, the `bad_set` message). Its actions: Reopen, Copy as JSON (clipboard), Retry (just that workout), and Remove from phone (asks first; it can't be recovered). Nothing is ever removed automatically.
- **Reopen** (`reopen` in `session.ts`, tested; `reopenQueued` in `active.ts`): one storage write moves the workout from `queue` back to `active` with the same id, `started_at`, and `ended_at` (`ActiveWorkout.ended_at`), its done sets, no rest timer, and no plates left out, so it's fixed on the normal workout screen. Finishing again keeps the original `ended_at` and queues it. Disabled, with the reason, while another workout is in progress. A 4xx means the server never stored it, so resending under the same id is a fresh upload (except a 409 `workout_conflict`, where the server holds a different workout under that id; that one stays refused).

## 25. Records, charts, body-part volume, and prefill

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

## 26. Stack, security, and design details

The full text of the standing rules that `CLAUDE.md` states briefly.

### Overview and product principles

Self-hosted workout tracker for a small household (Trav and his wife). Runs on the homelab via Docker Compose, beside Foodlog but fully separate from it, and is reachable only over Tailscale. Read `HANDOFF.md` for current state, deploy, backups, and restores. **Scope lives in `docs/v1-scope.md`.** If a request isn't in it, ask before building it.

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

### Stack

- Backend: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Postgres 17 (`backend/`)
- Frontend: React 19, TypeScript, Vite, Tailwind, TanStack Query, React Router, lucide-react icons (`frontend/app/`). ECharts 6.1.0 (pinned, tree-shaken in `components/EChart.tsx`, adapted from Foodlog's; the two chart pages load it lazily). The Android client is a Capacitor shell around this build (from Spec 2); desktop uses the plain web build.
- Serving: Caddy (static files plus `/api` reverse proxy), Tailscale sidecar with Tailscale Serve for HTTPS
- Containers (`docker-compose.yml`, project `liftlog`): `tailscale` (hostname `liftlog`, `tag:liftlog`), `web` (Caddy, shares the tailscale network namespace, 127.0.0.1:8080), `backend` (FastAPI :8000), `db` (Postgres, internal network only)
- Foodlog (`~/foodlog`) is the reference for patterns. Read its code and copy what fits. Never import from it, share code with it, or change it from this repo.

### Security posture

1. **No published host ports.** The app is exposed only through Tailscale Serve on 443, Funnel off (`tailscale/serve.json`). Never add `ports:` to any service.
2. **Auth is two layers and must stay that way.** Caddy overwrites `X-Liftlog-Proxy` with `PROXY_SECRET`; the backend middleware (`app/auth.py`) checks it with `hmac.compare_digest`, then checks `Tailscale-User-Login` against `ALLOWED_LOGINS`. It runs on every route, so new routes are covered automatically. Never trust a client-supplied identity, and never add a route that skips the middleware.
3. **The backend and database have no internet.** Both sit on internal networks; only the Tailscale container has a route out.
4. **Secrets live in `.env`** (chmod 600, gitignored). Never commit `.env`, `data/`, or anything under `data/`. Never print secret values in output. Every variable is listed, without values, in `.env.example`. Off-site backup credentials are root-only files in `/etc/restic`: never read or print anything there, and never ask for key values; Trav handles those himself.
5. **No new external service or outbound dependency without Trav's approval first.** That includes CDNs, APIs, analytics, fonts, and anything the backend or browser would call out to. Fonts and assets are self-hosted.
6. **Every schema change is an Alembic migration** in `backend/alembic/versions/`, numbered sequentially (`0010` is the latest; next is `0011`). Migrations must upgrade and downgrade cleanly. Deploy with `scripts/deploy.sh`, which takes a pg_dump before the backend starts and migrates.
7. **Every query on user data is scoped to the caller.** Get the user with the `CurrentUser` dependency (`app/users.py`) and filter on `user_id`, or load by id with `owned()`. Another user's object answers **404, never 403**, so ids never reveal what exists. User B getting 404 on user A's exercises, workouts, and imports is tested (`tests/test_data.py`), on folders, routines, and versions (`tests/test_routines.py`), on workout uploads and the offline copy (`tests/test_workouts.py`), on workout edits and deletes (`tests/test_edits.py`), and on exports (`tests/test_export.py`: another user's workout is 404, full history holds only the caller's workouts, exercises, gear, and measurements), and on measurement sites and check-ins (`tests/test_body.py`); extend those tests when adding a new kind of user object.

### RAM budget

The box is tight. Memory limits are in `docker-compose.yml`: db 256 MB, backend 256 MB, Caddy 64 MB, Tailscale 128 MB. Postgres runs with `shared_buffers=64MB` and `max_connections=20`, and the backend pool is small to match. Don't raise a limit or add a container without saying why and checking `docker stats`.

### Design system

- **Fonts:** Bricolage Grotesque (headings and numbers via `.display` and `.num`) and Atkinson Hyperlegible (body), self-hosted from `@fontsource` npm packages, never a CDN.
- **Colors:** Foodlog's earth palette as CSS variables in `src/styles.css`, light and dark. Dark follows the OS, and `data-theme` on the root overrides it. (Token table in `CLAUDE.md`.)

  Use them through Tailwind (`bg-surface`, `text-muted`, `border-line`, `text-accent-text`). Never hard-code a palette color in components. Keep WCAG AA contrast.
- **Layout:** mobile first, single column, max width `max-w-md`, safe-area insets respected. Size text and spacing in rem. Tap targets at least 44 px.
- **Accessibility:** labels on every input, screen-reader text on icon-only buttons and color-only indicators, `prefers-reduced-motion` respected. **One focus indicator per control:** the base-layer `:focus-visible` rule in `src/styles.css` (2px outline in `--accent-text`, at least 4:1 on every background in both themes). A component that draws its own ring on a wrapper uses `focus-within:outline-*` there and `outline-none` on the input. Never add a second ring, and never put focus styles outside the base layer, or they'll beat `outline-none`.

### Copy style

Plain, direct, friendly American English. No em dashes in UI text or docs. Keep copy short. No technical or developer text in the UI.

## 27. Tests, commands, and git

### Workflow and the current test list

- **One spec per session.** Each session implements exactly one spec, end to end: build, test, commit, deploy, update `HANDOFF.md`. Don't start the next spec or slip in unrelated work. If something out of scope comes up, note it in `HANDOFF.md` and ask.
- **Deploy status comes only from live checks:** the commit on `origin/main`, the migration `alembic current` reports, and the version `/download` offers (`data/apk/version.json`). The commands are in `HANDOFF.md`, section 3. Never write what's deployed into `HANDOFF.md` or anywhere else in the repo, and never trust an old note about it.
- **Minimal testing.** Test what would hurt if it broke silently: auth, privacy, and data integrity rules (today: auth and CORS, the 4 AM workout date with DST, user isolation, import dedupe and atomicity, exact weights, set type mapping, the muscle-map log, routine versioning, pruning, and conflicts, save as routine, the prefill rule, the superset move and remove rules, upload idempotency and the date at upload, the immutability triggers and change log function, the volume rules, the offline login check, queued workouts feeding prefill and rest, the upload loop and Needs attention, version recreation on upload, the plate math rule, export privacy, the CSV round trip through the Hevy importer, set field limits on upload, the heavy weight warning, Reopen, the record rules and Epley, the finish summary's records, hard sets per muscle and their weeks, the versions list's privacy, workout edits and deletes: the change log row, no-op saves, stale revisions, 422s, the date on a time edit, deleted workouts left out everywhere, 410 and the retry rule, re-import skipping a deleted import, isolation, the column trigger, records after an edit, the queue dropping a 410, and the cache update; the app update check: same version, different version, failed fetch, missing version; measurements: isolation, the value and body fat limits with nothing written, exact inches beside cm, one value per site per date, delete versus archive, changes since previous and first, body fat across methods). Don't write tests for layout, copy, or simple CRUD. Run the backend tests, the frontend tests, and the frontend build before every commit.
- **Ask Trav before:** anything touching auth or networking, deleting data, raising memory limits, or adding an external service or outbound dependency.

### Commands

All from the repo root (`~/liftlog`).

```bash
# Deploy: clean tree, build, verified pg_dump, then start (migrations run on backend start).
scripts/deploy.sh

# Backend tests, against a throwaway Postgres on an internal network (never the live one).
scripts/test-backend.sh

# Frontend unit tests (prefill, superset moves and removal, volume, the login check, queued history, the upload loop, plate math, the heavy weight warning, Reopen, records, 1RM, body-part volume, the cache after an edit or delete, the app update check, measurement changes and display).
cd frontend/app && docker run --rm -v "$PWD":/src:ro -w /src node:22-alpine npm test

# Frontend build check. Node isn't installed on the host.
cd frontend/app && docker run --rm -v "$PWD":/src:ro node:22-alpine sh -c \
  'mkdir /w && cd /src && tar cf - --exclude=node_modules --exclude=dist . | tar xf - -C /w && cd /w && npm ci && npm run build'
```

### Git

- Branch `main`, remote `origin` = private GitHub repo `liftlog` via the SSH alias `github-liftlog` (key `~/.ssh/github_liftlog`).
- Small, descriptive commits. `.env`, `data/`, `node_modules/`, `dist/` are ignored.

## 28. Body measurements

Server: `app/body.py` (seeding, checks, the doc), routes in `app/routers/body.py`. Phone: `src/lib/body.ts` (pure, tested in `tests/body.test.ts`; no runtime imports), `useBody` and `useBodyChange` in `lib/queries.ts`, pages `Body.tsx`, `BodyCheckin.tsx`, `BodySite.tsx`, `BodySites.tsx`.

- **Per user, on the server.** The first `GET /api/body`, `GET /api/offline`, or JSON export copies in the standard sites once (`users.body_seeded`, under a row lock). Users add custom sites (name, one value or left and right), rename and archive any site, and delete one with no values (409 `in_use` otherwise; RESTRICT in Postgres too). Every change answers with the whole doc: `length_unit`, every site (with `has_values`), every check-in newest first with its values.
- **Check-ins:** one per date, today by default (the user's timezone, 4 AM rollover, `today_for`), never in the future. `POST` adds to the check-in on that date if there is one; a site and side entered again replaces its value. `PUT` replaces a check-in's date, body fat, notes, and every value; a date another check-in holds is 409 `date_taken`. At least one value or body fat. Delete has no undo and no change log (by design: measurements are freely editable).
- **Limits** (server `check_value`, `check_body_fat`; phone `valueProblem`, `fatProblem`, `VALUE_INPUT`, `FAT_INPUT`; and the database): values 1 to 300 cm (0.4 to 118.11 in) with at most two decimals as entered; body fat 1 to 75 with at most two decimals and a method. A bad value is a 422 naming the site ("Arms, left: 301 cm is out of range. Enter 1 to 300 cm."), and nothing is written.
- **Display** (`valueText`, `inUnit`): exactly as entered when its unit is the display unit (`users.length_unit`, Settings), else converted from `value_cm` to 0.1. Switching units never rewrites stored values.
- **Changes** (`siteTrend`, `fatTrend`): per site and side, the latest value against the previous check-in that included it (check-ins that skipped it don't count) and against the first. Exact in hundredths when both are in the display unit, else from cm to 0.1. Body fat changes only between readings by the same method; otherwise none is shown and the page says why. No averages, no targets.
- **Offline:** `body` is in the offline copy, so the Body tab, site pages, and check-ins show offline (`cached()`). Adding, editing, deleting, and managing sites need a connection; offline the controls are disabled with "Adding and editing measurements need a connection."
- **Not here:** bodyweight (Foodlog's), derived metrics, goals, photos, reminders, CSV.
