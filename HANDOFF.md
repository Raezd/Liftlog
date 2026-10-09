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

## 5. Spec 2

**Capacitor shell and rest timer prototype** (`docs/v1-scope.md`, build order step 2). Wrap the React build in a Capacitor Android shell, add CORS for the Capacitor origin, and prove the rest timer works before any feature builds on it: it must fire on time with the phone locked, in airplane mode, with a custom sound, on both phones. Trav's phone locks between sets, which is why a pure PWA timer is ruled out. No data model yet; that's Spec 3.

The remaining order: 3 data model, exercise library, and Hevy import; 4 routines; 5 workout card flow, offline storage and sync, plate math, finish and export; 6 history, PRs, charts, body-part volume; 7 measurements and the Foodlog summary API.

## 6. Known gaps

- None yet beyond what's listed under Spec 2.
