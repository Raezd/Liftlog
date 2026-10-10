# Liftlog: rules for Claude Code

Self-hosted workout tracker for Trav and his wife. Runs on the homelab with Docker Compose and is reachable only over Tailscale. Scope is in `docs/v1-scope.md`; if a request isn't in it, ask before building it. `HANDOFF.md` holds current state, how things work, and how to run them. Read only the sections this file points to.

## Product principles

From `docs/v1-scope.md`, which wins if the two disagree:

- **Standalone.** Own data, UI, Compose project, Postgres, and Tailscale hostname. Foodlog (`~/foodlog`) is a reference: copy patterns from it, never import from it, share code with it, or change it.
- **Private and per user.** Every row is scoped to a user, identified by Tailscale login. All data is private.
- **Offline-first.** Every workout tap writes to the device at once. Sync never blocks logging.
- **History never silently changes.** Starting a workout snapshots the routine. Editing a finished workout is explicit and recorded.
- **Weights never drift.** Store the value and unit as entered plus normalized kg. Default unit lb, per user.
- **Workout date:** the user's timezone with a 4 AM rollover.
- **Honest numbers.** Label estimates. Show no data as no data, never zero.
- **Bodyweight and TDEE belong to Foodlog.** Never store bodyweight here or send exercise calories to Foodlog.
- **Copy:** short, plain, friendly American English. No em dashes in UI text or docs. No developer text in the UI.

## Security posture (non-negotiable)

1. **No published host ports.** Exposed only through Tailscale Serve on 443, Funnel off. Never add `ports:` to a service.
2. **Two-layer auth on every route.** Caddy sets `X-Liftlog-Proxy` to `PROXY_SECRET`; the middleware in `app/auth.py` checks it, then checks `Tailscale-User-Login` against `ALLOWED_LOGINS`. Never trust a client-supplied identity or add a route that skips the middleware.
3. **The backend and database have no internet.** Only the Tailscale container has a route out.
4. **Secrets live in `.env`** (600, gitignored). Never commit `.env` or `data/`, never print secret values, and list every variable without values in `.env.example`. Never read or print anything in `/etc/restic` or ask for key values.
5. **No new external service or outbound dependency without Trav's approval first:** CDNs, APIs, analytics, fonts, anything the backend or browser would call out to. Fonts and assets are self-hosted.
6. **Every schema change is a sequentially numbered Alembic migration** in `backend/alembic/versions/` (next number after the highest file there) that upgrades and downgrades cleanly.

## User scoping

Every query on user data is scoped to the caller: get the user with `CurrentUser` (`app/users.py`) and filter on `user_id`, or load by id with `owned()`. **Another user's object answers 404, never 403**, for reads, edits, deletes, exports, and workout uploads. Client-supplied UUIDv7 ids elsewhere: the caller's own id returns the existing row; someone else's is 409. Add an isolation test for every new kind of user object (HANDOFF.md section 27 lists the current ones).

## Sync contract

`PUT /api/workouts/{id}` uploads a whole finished workout under its client UUIDv7:

- New: 201. Same id and same content as the first upload (`upload_hash`, never changed by edits): 200, nothing changes.
- Same id, different content: 409 `workout_conflict`, never overwritten. A taken exercise or set id: 409.
- **A deleted workout's id: 410 `workout_deleted`, nothing written; the phone drops it from the queue** (not Needs attention).
- Someone else's id: 404.
- A bad set: 422 `bad_set` with a plain reason, nothing written. Bad input never causes a 5xx.
- The server computes `workout_date` and `logged_name`. If the started-from routine version was pruned, the server recreates it from the body's `routine_version` (caller's routine only).
- On the phone: no connection or a 5xx stops the loop and keeps everything queued. Any other 4xx goes to Needs attention, is never retried or removed automatically, and never blocks the queue.

Before changing sync, the offline copy, or the upload loop, read HANDOFF.md section 24.

## Finished workouts are immutable

- Postgres triggers reject changes to a finished workout (`ended_at` set), its `workout_exercises`, and its `sets`, except in the transaction that created it.
- **Every edit or delete goes through `edit_finished_workout()`**, which writes the `workout_changes` row. Never write those rows another way. `edit_revision` and `deleted_at` change only inside that function.
- Delete is soft (`deleted_at`). A deleted workout is left out of every read: history, detail (404), the offline copy, exports, save as routine, and Versions.

Before changing workouts, edits, or the triggers, read HANDOFF.md sections 17 and 18.

## Stack

- Backend: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Postgres 17 (`backend/`).
- Frontend: React 19, TypeScript, Vite, Tailwind, TanStack Query, React Router, lucide-react, ECharts 6.1.0 pinned (`frontend/app/`). Android is a Capacitor shell around the same build.
- Serving: Caddy (static files plus `/api` proxy) behind a Tailscale sidecar. Containers: `tailscale`, `web`, `backend`, `db`.
- Memory limits in `docker-compose.yml` are tight. Don't raise one or add a container without asking Trav.

## Design system

- **Fonts:** Bricolage Grotesque (headings and numbers, `.display` and `.num`) and Atkinson Hyperlegible (body), self-hosted.
- **Colors:** CSS variables in `src/styles.css`, used through Tailwind (`bg-surface`, `text-muted`, `border-line`, `text-accent-text`). Never hard-code a palette color. Keep WCAG AA contrast. Dark follows the OS; `data-theme` on the root overrides it.

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

- **Layout:** mobile first, single column, `max-w-md`, safe-area insets, rem sizing, tap targets at least 44 px.
- **Accessibility:** a label on every input, screen-reader text on icon-only buttons and color-only indicators, respect `prefers-reduced-motion`. One focus ring per control, from the base-layer `:focus-visible` rule; see HANDOFF.md section 26 before changing focus styles.

## Workflow

- **One spec per session**, end to end: build, test, commit, update `HANDOFF.md`. Don't start the next spec or slip in unrelated work. Note anything out of scope in `HANDOFF.md` and ask.
- **Claude Code never deploys, publishes the APK, or pushes.** A hook blocks it. Commit only; Trav runs deploy, publish, and push.
- **Deploy status comes only from live checks:** the commit on `origin/main`, `alembic current` on the live database, and `data/apk/version.json`. Never write deploy status into the repo or trust an old note about it. The commands are in HANDOFF.md section 3.
- **Minimal testing.** Test what would hurt if it broke silently: auth, privacy, and data integrity. No tests for layout, copy, or simple CRUD. Run the backend tests, frontend tests, and frontend build before every commit (commands in HANDOFF.md section 27).
- **Ask Trav before** anything touching auth or networking, deleting data, raising memory limits, or adding an external service or outbound dependency.
- Small, descriptive commits on `main`.

## Read before working in an area

| Area | HANDOFF.md section |
|---|---|
| Deploy and live status | 3 |
| Backups and restores | 4 |
| Android build, signing, rest alerts | 5 |
| Data model, tables, immutability details | 17 |
| Editing and deleting finished workouts | 18 |
| Hevy import | 19 |
| Routines, versions, superset moves | 20 |
| Plate math and gear | 21 |
| Export | 22 |
| App updates | 23 |
| Offline model, sync, workout screen | 24 |
| Records, charts, body-part volume, prefill | 25 |
| Stack, security, and design details; RAM budget | 26 |
| Tests, commands, git | 27 |
