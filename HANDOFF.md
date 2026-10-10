# Liftlog handoff

Current state of the project, how to run it, and what comes next. Rules for working on it are in `CLAUDE.md`; scope is in `docs/v1-scope.md`.

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

- **Schema** (migrations `0002` to `0004`; overview in `CLAUDE.md`, Data model): read-only exercise catalog (876 from free-exercise-db, commit `f00c92c`, Unlicense, in `backend/app/seed/free-exercise-db/`), muscle vocabulary (19: the dataset's groups with shoulders split into front, side, rear delts), users, user exercises, muscle-map change log, workouts, workout exercises, sets, workout change log, imports, Hevy title mappings. UUIDv7 keys; client ids accepted.
- **User scoping:** users are created on their first request from the Tailscale login. Every query filters on the caller; another user's object is a 404.
- **Routes:** `GET/PATCH /api/me` (login and settings), `GET /api/muscles`, `GET /api/catalog?q=`, `GET /api/catalog/{id}`, `GET/POST /api/exercises`, `GET/PATCH /api/exercises/{id}`, `GET /api/workouts?before=`, `GET /api/workouts/{id}`, `POST /api/imports/hevy/preview`, `POST /api/imports/hevy`, `GET /api/imports`, `GET /api/imports/{id}`.
- **Pages** (web and Android, bottom nav): History (newest first, imported label, tap for exercises and sets), Library (search, Needs review and Archived filters, add from catalog or custom, edit name, equipment, logging type, muscles, archive, muscle change history), Import (upload, counts, per-title review, delt confirmation, result), Settings (display name, timezone, units, play through silent mode, login and version). The hello page is gone; the timer test screen is under Settings in the app.
- **Hevy import** (flow in `CLAUDE.md`): columns verified against Trav's real export. Strong matches (score 1.1 or more) start out picked on the review screen; everything else needs a choice. Delts chosen on the review screen are applied; the exercise keeps Needs review unless "These delts are right" is ticked.
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

- **Schema** (`0005`): `routine_folders`, `routines`, `routine_versions`, `routine_exercises`, `routine_sets`, all scoped per user, plus `workouts.routine_version_id` (empty until Spec 5). A trigger makes versions, their exercises, and their sets immutable. Model and rules are in `CLAUDE.md` (Routines).
- **Routes:** `GET /api/routines?archived=`, `PUT /api/routines/layout` (folder order, and each folder's routines in order), `POST/PATCH/DELETE /api/folders[/{id}]`, `POST /api/folders/{id}/duplicate`, `POST /api/routines`, `GET/PATCH/DELETE /api/routines/{id}`, `POST /api/routines/{id}/duplicate`, `POST /api/routines/{id}/versions` (409 `version_conflict` on a stale parent), `GET /api/routines/{id}/versions[/{vid}]`, `POST /api/routines/from-workout`.
- **Pages:** the bottom nav is now Routines, History, Library, Settings. Import moved to Settings (`/settings/import`).
  - **Routines** (`/`): folders with their routines in order, "Not in a folder" below. Options per folder or routine: rename, move to another folder, duplicate, archive or restore, delete (only if no workout used it), earlier versions. Reorder mode: drag handles plus move up and move down buttons, with each move read out for screen readers. Show archived on demand.
  - **Editor** (`/routines/new`, `/routines/{id}`): add from your library (several at once), reorder by buttons on each card or in reorder mode (drag or buttons), supersets with "Superset with the next exercise" (up to three, a rest after each round), rest and notes per exercise. Per set: add (copies the last set), remove, move, set type, reps fixed or a range, and weight, RPE, time, or distance depending on the logging type. Save makes a new version; leaving with unsaved changes asks first; a conflict offers to load the latest and never overwrites.
  - **Versions** (`/routines/{id}/versions`): the kept versions, newest first, each readable as it was saved. Since the Spec 4 fixes (section 8), only the current version and versions a workout used are kept.
  - **Save as routine:** a button at the bottom of a workout in History. Name defaults to the workout title; pick a folder, no folder, or a new one.
- **Prefill rule:** `frontend/app/src/lib/prefill.ts`, exported for Spec 5, not used by any screen yet. Rule in `CLAUDE.md`.
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

- **Superset moves** (`src/lib/reorder.ts`, rules in `CLAUDE.md`): moving an exercise within its superset keeps it there; past the first or last exercise takes it out; a lone exercise skips past a whole superset instead of landing inside it; a superset moves as one unit from its header. Works by drag and by buttons in reorder mode (`components/ExerciseOrder.tsx`, with a line showing where it will land and "In superset A" or "Not in a superset" on the dragged row), and by the buttons on each card (the first card of a superset has the group's buttons). Every move is announced.
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

- **Backend.** `PUT /api/workouts/{id}` (the upload; contract in `CLAUDE.md`, Offline model and sync), `GET /api/offline` (everything the phone caches), and `GET /api/workouts/{id}` now also returns `routine_version_id`, `routine_id`, each exercise's `rest_seconds`, and each set's `completed_at`.
- **Migration `0007`.** `workout_exercises.rest_seconds`, `workouts.upload_hash`, the immutability triggers on `workouts`, `workout_exercises`, and `sets`, `workout_snapshot()`, and `edit_finished_workout()` (writes `workout_changes`; nothing calls it until Spec 6). Rules in `CLAUDE.md`. Downgrades and upgrades cleanly (checked once against the test database, with data in it).
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

- **Version recreation** (rule in `CLAUDE.md`, Offline model and sync): the phone keeps the started-from version's content with the workout and sends it as `routine_version`. If the server pruned that version meanwhile, it recreates it under its original id as an older, non-current version with no parent, and links the workout. Someone else's routine or version is 404 and recreates nothing; a deleted routine means no link.
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

**Status:** built and tested with its fixes. Rules are in `CLAUDE.md` (Plate math and gear, Export).

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

**Status:** built and tested. No migration. Rules are in `CLAUDE.md` (Offline model and sync: set field limits, set numbering, heavy weight warning, card flow, Needs attention, Reopen; Export).

- **Set numbering:** warm-ups show W, the rest count from 1 skipping warm-ups, drop and failure sets carry a small tag. On the workout card, the Overview (a row of set labels per exercise, filled when done), and the last-session strip ("W: 95 x 10, 1: 185 x 5, 3 drop: 135 x 8"). Display only.
- **Card flow:** the rest bar names the next card ("Up next: ..."), or "Last exercise". On the last card Next exercise becomes Finish.
- **Weight field and limits:** the weight field is at least 5.375rem wide (9999.99 at 18 px is 69 px of text; checked in headless Chromium at 360 px wide with the real font and CSS, no page overflow, not kept). Typing past the limits does nothing; `setProblem` checks them again before a set is completed. To make room, RPE moved from its own column into the set's sheet (tap the set label) and shows under the row as "RPE 8".
- **Heavy weight warning:** inline under the set, and listed on the finish screen (tap to jump). It compares against everything on the phone, so a reopened workout doesn't count against itself (it's out of the queue while open).
- **Server:** `PUT /api/workouts/{id}` checks every set field and answers 422 `bad_set` with the reason. The old Pydantic bounds (weight up to 10,000, reps 10,000, duration 172,800, distance 100,000) are gone from the model, so every range answer is the plain one; the hash is unchanged (types are the same). One-off check, not kept: NaN, Infinity, `1e1000000`, `1e-1000000`, 10^30 reps, absurd RPE and distances, a missing unit, and non-integer reps all answer 422 and write nothing.
- **Needs attention:** shows the server's reason (it already did for `{code, message}` errors; the generic text came from Pydantic's list errors, which these fields no longer produce). **Reopen** puts it back in progress (rules in `CLAUDE.md`).
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

**Status:** built and tested. No migration. Not deployed by this session; check what's live with the commands in section 3. Phone and browser checks are Trav's (table below). Rules are in `CLAUDE.md` (Records, charts, and body-part volume).

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

**Status:** built and tested. Migration `0009`. Rules are in `CLAUDE.md` (Editing and deleting finished workouts). What's deployed comes only from the live checks in section 3.

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

**Status:** built and tested. No migration, no new route, no plugin or permission. Rules are in `CLAUDE.md` (App updates). What's deployed comes only from the live checks in section 3.

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
- Adding a catalog exercise you already have returns your copy; delt choices on the import screen don't change an existing copy.
- Re-importing a file with nothing new still writes an import record (all skipped), which is how the skip counts are reported.
