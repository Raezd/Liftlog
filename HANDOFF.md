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
- **Backend:** FastAPI with the two-layer auth as middleware on every route (`app/auth.py`). Routes: `GET /api/health` (`{"status", "database"}`, 503 when the database doesn't answer) and `GET /api/me` (`{"login"}`). Alembic has one empty baseline, `0001`. No tables yet.
- **Frontend:** Vite, React 19, TypeScript, Tailwind. One hello page showing the app name, your login, backend and database health, and the build version. Earth palette in light and dark, self-hosted fonts.
- **Tests:** the auth rules only (`backend/tests/test_auth.py`): missing header, wrong header, and an unlisted login get 403; an allowed login gets 200.
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
BUILD_ID=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps                                  # backend "healthy"
docker stats --no-stream $(docker compose ps -q)   # each under its limit
```

Migrations run on backend start. Once there's real data, take a dump first (`scripts/backup.sh`, see below).

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

**Status:** built, deployed, and published (`6-52e57ce`, October 9, 2026). Phone acceptance tests are **not run yet**, so the scheduling path is undecided (see the results table).

### What exists

- **App:** Capacitor 8.5.2 Android project in `frontend/app/android`, app id `io.github.raezd.liftlog` (permanent: changing it means uninstalling). Plugins pinned exactly: `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` 8.5.2, `@capacitor/local-notifications` 8.3.1. No iOS project. minSdk 26, target 36.
- **Offline:** web files are bundled in the APK, never loaded from the server. The API base (`https://liftlog.tail9d27a0.ts.net`) is set at build time from the stack's own Tailscale name (`VITE_API_BASE`). The web build uses relative paths.
- **CORS:** only `https://localhost` (the app's origin) gets CORS headers (`backend/app/main.py`). The desktop web build is same-origin. Auth wraps CORS, so preflights must pass both auth layers too. A disallowed preflight gets a bare 400 with no CORS headers. Tests are in `backend/tests/test_auth.py`.
- **Timer test screen** (`src/timer/`, temporary, removed when the workout screen is built): 10/60/90/180 s timers, five 2:30 rests 30 s apart, Done resting, Cancel, path A/B switch, alarm sound toggle, server status and login, permission help, and a results list showing how late each alert was posted.
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

| Test | Trav | Wife |
|---|---|---|
| Installs from /download, opens in airplane mode | | |
| Shows own login with network and Tailscale on; desktop web still works | | |
| 90 s timer, screen locked | | |
| Five-timer sequence, locked in a pocket | | |
| `adb shell dumpsys deviceidle force-idle`, three 60 s timers, **path A** | | |
| Same, **path B** | | |
| Fires after the app is swiped from recents | | |
| Cancelled early never fires | | |
| Audible in Bluetooth earbuds over music | | |
| On vibrate: default vibrates only; alarm toggle plays sound | | |
| Keystore and password in latest restic snapshot | `03eb37ba` | |
| CORS test passes | pass (13 backend tests) | |

**Scheduling path chosen:** not yet decided. Rule: if A passes every test, use A; if only B passes, use B. **Ringer default for v1:** to be decided from the vibrate test.

### The rest of v1

The remaining order: 3 data model, exercise library, and Hevy import; 4 routines; 5 workout card flow, offline storage and sync, plate math, finish and export; 6 history, PRs, charts, body-part volume; 7 measurements and the Foodlog summary API.

## 6. Known gaps

- Spec 2 phone acceptance tests and the path A/B decision (section 5).
- The app uses Capacitor's default launcher icon and splash.
- `localStorage` holds the timer test state only. Real on-device storage (IndexedDB) and sync are Spec 5.
