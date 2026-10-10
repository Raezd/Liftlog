# Liftlog handoff

Current state of the project, how to run it, and what comes next. Rules for working on it are in `CLAUDE.md`; scope is in `docs/v1-scope.md`.

## 1. What exists (Spec 1: infrastructure)

- **App URL:** `https://liftlog.<tailnet>.ts.net`, via the Tailscale sidecar (hostname `liftlog`, `tag:liftlog`, userspace networking, Serve on 443, Funnel off).
- **Users:** Trav and his wife, both in `ALLOWED_LOGINS`. She reaches the node through a Tailscale device share.
- **Code:** `~/liftlog`, branch `main`, private GitHub repo `Raezd/Liftlog` via the deploy key `~/.ssh/github_liftlog` (SSH alias `github-liftlog`, write access).
- **Deployed:** `34dfde2` on October 9, 2026, at `https://liftlog.tail9d27a0.ts.net`. Idle memory at deploy: backend 62 MiB, db 15 MiB, tailscale 30 MiB, web 15 MiB, about 123 MiB total. Kuma push monitor `Liftlog` and the Homepage tile (Health group) are set up.
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

**Status:** accepted October 9, 2026. Built, deployed, and published as `6-52e57ce`; Trav reported every phone acceptance test passing on both phones. **Path A chosen; default alert follows the ringer.**

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

The remaining order: 3 data model, exercise library, and Hevy import (done, section 6); 4 routines (done, section 7); 5a workout card flow, offline storage and sync, finish (built, section 9); 5b plate math and export; 6 history, PRs, charts, body-part volume, editing finished workouts; 7 measurements and the Foodlog summary API.

## 6. Spec 3: data model, exercise library, Hevy import

**Status:** built, tested, and deployed as `688e3de` on October 9, 2026. Android app `10-688e3de` published to /download. Waiting on Trav's import and phone checks (table below).

### What exists

- **Schema** (migrations `0002` to `0004`; overview in `CLAUDE.md`, Data model): read-only exercise catalog (876 from free-exercise-db, commit `f00c92c`, Unlicense, in `backend/app/seed/free-exercise-db/`), muscle vocabulary (19: the dataset's groups with shoulders split into front, side, rear delts), users, user exercises, muscle-map change log, workouts, workout exercises, sets, workout change log, imports, Hevy title mappings. UUIDv7 keys; client ids accepted.
- **User scoping:** users are created on their first request from the Tailscale login. Every query filters on the caller; another user's object is a 404.
- **Routes:** `GET/PATCH /api/me` (login and settings), `GET /api/muscles`, `GET /api/catalog?q=`, `GET /api/catalog/{id}`, `GET/POST /api/exercises`, `GET/PATCH /api/exercises/{id}`, `GET /api/workouts?before=`, `GET /api/workouts/{id}`, `POST /api/imports/hevy/preview`, `POST /api/imports/hevy`, `GET /api/imports`, `GET /api/imports/{id}`.
- **Pages** (web and Android, bottom nav): History (newest first, imported label, tap for exercises and sets), Library (search, Needs review and Archived filters, add from catalog or custom, edit name, equipment, logging type, muscles, archive, muscle change history), Import (upload, counts, per-title review, delt confirmation, result), Settings (display name, timezone, units, play through silent mode, login and version). The hello page is gone; the timer test screen is under Settings in the app.
- **Hevy import** (flow in `CLAUDE.md`): columns verified against Trav's real export. Strong matches (score 1.1 or more) start out picked on the review screen; everything else needs a choice. Delts chosen on the review screen are applied; the exercise keeps Needs review unless "These delts are right" is ticked.
- **Deploy** now goes through `scripts/deploy.sh` (dump first). The first one wrote `predeploy/liftlog-20261009-211022-before-688e3de.dump` before `0002` to `0004` ran.
- **Memory after deploy:** backend 64 MiB, db 21 MiB, tailscale 30 MiB, web 13 MiB.

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
| Library, history, settings on desktop and both phones; wife sees none of Trav's data | isolation test passes; phones pending (install `10-688e3de`) |
| pg_dump before the migration; stack under memory limits | done (see above) |

## 7. Spec 4: routines

**Status:** built, tested, and deployed as `ef095a4` on October 9, 2026. Waiting on Trav's checks on the page and phones (table below). Android app `14-c478968` published to /download.

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
- **Deploy:** `scripts/deploy.sh` wrote `predeploy/liftlog-20261009-225136-before-ef095a4.dump` before `0005` ran. Memory after deploy: backend 65 MiB, db 23 MiB, tailscale 30 MiB, web 12 MiB, all well under their limits.

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
| Editor works on desktop and both phones, reordering by drag and by buttons | pending (Trav). Not checked in a browser this session (no browser tools). Install `14-c478968` on both phones |
| Tests pass | 44 backend, 6 frontend, build passes |
| Wife sees none of Trav's folders or routines and can make her own | isolation test passes; on her phone, pending |
| Dump before migrations; memory under limits | done (see above) |

## 8. Spec 4 fixes

**Status:** deployed as `266ac73` on October 9, 2026, and Android `16-266ac73` (same commit) published to /download. Waiting on Trav's checks (table below).

- **Deploy:** `predeploy/liftlog-20261009-232010-before-266ac73.dump` was written before `0006` ran. "Lower A" went from 7 versions to 1. Memory after: backend 65 MiB, db 23 MiB, tailscale 30 MiB, web 13 MiB.

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
| Web and APK report the same commit; both phones on the new APK | both `266ac73`; phones pending |
| Tests pass; dump before migration; memory under limits | 46 backend, 11 frontend; done |

## 9. Spec 5a: live workouts offline, sync, immutable history

**Status:** built, tested, and committed (`b305534` backend, `3a3e271` frontend, plus this HANDOFF commit). **Not deployed yet:** the deploy was blocked by Claude Code's permission check in this session, so Trav runs it (below). A test APK `19-3a3e271` was built to check the Java change compiles; it was not published.

### Deploy and publish (Trav)

```bash
cd ~/liftlog
scripts/deploy.sh             # dump first, then 0007 runs on backend start
scripts/android-build.sh      # from the same commit, so web and APK match
scripts/android-publish.sh
```

Then install the new APK on both phones from /download. After the deploy, check that the dump file name in `predeploy/` says `before-<hash>` and that `alembic current` prints `0007`.

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
| Tests pass; dump before migration; memory under limits | 56 backend, 18 frontend, build passes; deploy pending |

## 10. Spec 5a follow-ups: version recreation, Needs attention, sync tests

**Status:** built, tested, and committed. **Not deployed:** same as section 9, Trav runs `scripts/deploy.sh`, then `scripts/android-build.sh` and `scripts/android-publish.sh` from the same commit. No migration in this change.

- **Version recreation** (rule in `CLAUDE.md`, Offline model and sync): the phone keeps the started-from version's content with the workout and sends it as `routine_version`. If the server pruned that version meanwhile, it recreates it under its original id as an older, non-current version with no parent, and links the workout. Someone else's routine or version is 404 and recreates nothing; a deleted routine means no link.
- **Needs attention:** a workout refused with a 4xx shows in the waiting bar with the reason and Copy as JSON, Retry, and Remove from phone (confirmed). It's never retried or removed automatically and never blocks the queue. The summary screen says so too.
- **Start** waits at most 2 seconds for the server's current version, then uses the copy.
- **Refactor:** `session.ts` imports name their `.ts` files (`allowImportingTsExtensions` in `tsconfig.json`), and the upload loop is `lib/uploader.ts`, so Node's test runner loads both. One behavior difference from section 9: a 5xx or a non-HTTP failure now stops the loop like no connection does, instead of marking the workout refused.
- **Tests:** 60 backend, 24 frontend. New: a retry with trailing-zero lb weights and microsecond timestamps is 200 and leaves one workout; a queued workout feeds prefill, the last-session strip, and the rest lookup as the same routine (`tests/session.test.ts`); refused uploads don't block later ones, aren't retried on their own, and retry alone (`tests/uploader.test.ts`); a pruned version is recreated under its id as non-current and linked; another user's routine or version is 404 and recreates nothing; a deleted routine lands unlinked.

| Check | Result |
|---|---|
| Workout from a routine in progress in airplane mode, routine edited and saved on desktop, workout finished and uploaded: linked to its routine and its version, which Versions lists | recreation tested; pending on phone (Trav) |
| Start opens within about 2 seconds on weak signal | pending (Trav) |
| Tests pass; dump before migration; memory under limits; web and APK same commit | 60 backend, 24 frontend, build passes; deploy pending |

## 11. Known gaps

- Routine editing needs a connection. Offline editing comes after v1 (the conflict check and client ids are ready for it).
- History and the workout view are online only. A workout waiting to upload shows in the unsynced count, not in History, until it uploads.
- The triggers' escape hatch is a transaction-local setting, so someone with direct database access can still set it by hand. The rule they enforce is against accidents and app bugs, not the database owner.
- Deleting a user who has finished workouts is refused by the triggers (no flow deletes users).
- Reordering while archived routines are hidden leaves their positions alone, so a restored one can land between others.
- Weight targets keep the unit they were entered in. Changing your weight unit in Settings doesn't convert existing targets.
- The app uses Capacitor's default launcher icon and splash.
- `localStorage` still holds the last-seen play through silent setting (`timer/alertSetting.ts`); everything else on the phone is in IndexedDB.
- Muscle arrays are checked against the vocabulary in the API, not by a foreign key.
- Adding a catalog exercise you already have returns your copy; delt choices on the import screen don't change an existing copy.
- Re-importing a file with nothing new still writes an import record (all skipped), which is how the skip counts are reported.
