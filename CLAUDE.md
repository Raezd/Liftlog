# Liftlog: instructions for Claude Code

Self-hosted workout tracker for a small household (Trav and his wife). Runs on the homelab via Docker Compose, beside Foodlog but fully separate from it, and is reachable only over Tailscale. Read `HANDOFF.md` for current state, deploy, backups, and restores. **Scope lives in `docs/v1-scope.md`.** If a request isn't in it, ask before building it.

## Product principles

- **Accuracy and integrity over convenience.** Logged history never silently changes. Anything that would rewrite past data needs Trav's explicit approval.
- **Private by default.** Each person's data is theirs. Nothing is shared without an explicit opt-in, and privacy is enforced on the server, not in the UI.
- **No public exposure.** Tailscale only, no open ports, two layers of identity checking.
- **Honest feedback.** Uncertain or missing data is labeled, never shown as zero.
- **Fast at the gym.** Mobile first, one hand, big tap targets, few steps per set.
- **Short, plain UI copy.** Plain American English, no developer text, no em dashes.

## Stack

- Backend: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Postgres 17 (`backend/`)
- Frontend: React 19, TypeScript, Vite, Tailwind (`frontend/app/`)
- Serving: Caddy (static files plus `/api` reverse proxy), Tailscale sidecar with Tailscale Serve for HTTPS
- Containers (`docker-compose.yml`, project `liftlog`): `tailscale` (hostname `liftlog`, `tag:liftlog`), `web` (Caddy, shares the tailscale network namespace, 127.0.0.1:8080), `backend` (FastAPI :8000), `db` (Postgres, internal network only)
- Foodlog (`~/foodlog`) is the reference for patterns. Read its code and copy what fits. Never import from it, share code with it, or change it from this repo.

## Security posture (non-negotiable)

1. **No published host ports.** The app is exposed only through Tailscale Serve on 443, Funnel off (`tailscale/serve.json`). Never add `ports:` to any service.
2. **Auth is two layers and must stay that way.** Caddy overwrites `X-Liftlog-Proxy` with `PROXY_SECRET`; the backend middleware (`app/auth.py`) checks it with `hmac.compare_digest`, then checks `Tailscale-User-Login` against `ALLOWED_LOGINS`. It runs on every route, so new routes are covered automatically. Never trust a client-supplied identity, and never add a route that skips the middleware.
3. **The backend and database have no internet.** Both sit on internal networks; only the Tailscale container has a route out.
4. **Secrets live in `.env`** (chmod 600, gitignored). Never commit `.env`, `data/`, or anything under `data/`. Never print secret values in output. Every variable is listed, without values, in `.env.example`. Off-site backup credentials are root-only files in `/etc/restic`: never read or print anything there, and never ask for key values; Trav handles those himself.
5. **No new external service or outbound dependency without Trav's approval first.** That includes CDNs, APIs, analytics, fonts, and anything the backend or browser would call out to. Fonts and assets are self-hosted.
6. **Every schema change is an Alembic migration** in `backend/alembic/versions/`, numbered sequentially (`0001` is the empty baseline; next is `0002`). Migrations must upgrade and downgrade cleanly.

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
- **Accessibility:** labels on every input, screen-reader text on icon-only buttons and color-only indicators, `prefers-reduced-motion` respected.

## Workflow

- **One spec per session.** Each session implements exactly one spec, end to end: build, test, commit, deploy, update `HANDOFF.md`. Don't start the next spec or slip in unrelated work. If something out of scope comes up, note it in `HANDOFF.md` and ask.
- **Minimal testing.** Test what would hurt if it broke silently: auth, privacy, and data integrity rules. Don't write tests for layout, copy, or simple CRUD. Run the backend tests and the frontend build before every commit.
- **Ask Trav before:** anything touching auth or networking, deleting data, raising memory limits, or adding an external service or outbound dependency.

## Commands

All from the repo root (`~/liftlog`).

```bash
# Deploy (migrations run automatically on backend start). Dump first once there's data.
BUILD_ID=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps                       # backend should be "healthy"
docker stats --no-stream $(docker compose ps -q)

# Backend tests (auth only today, no database needed). Tests aren't in the image.
docker run --rm -v "$PWD/backend":/src -w /src -e PYTHONPATH=/src -e PYTHONDONTWRITEBYTECODE=1 python:3.12-slim \
  sh -c 'pip install -q --root-user-action=ignore -r requirements-dev.txt && pytest -q -p no:cacheprovider'

# Frontend build check. Node isn't installed on the host.
cd frontend/app && docker run --rm -v "$PWD":/src:ro node:22-alpine sh -c \
  'mkdir /w && cd /src && tar cf - --exclude=node_modules --exclude=dist . | tar xf - -C /w && cd /w && npm ci && npm run build'
```

## Git

- Branch `main`, remote `origin` = private GitHub repo `liftlog` via the SSH alias `github-liftlog` (key `~/.ssh/github_liftlog`).
- Small, descriptive commits. `.env`, `data/`, `node_modules/`, `dist/` are ignored.

## Copy style

Plain, direct, friendly American English. No em dashes in UI text or docs. Keep copy short. No technical or developer text in the UI.
