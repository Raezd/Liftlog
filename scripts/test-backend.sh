#!/usr/bin/env bash
# Backend tests, against a throwaway Postgres that's deleted afterward.
# Never touches the live database. Usage: scripts/test-backend.sh [pytest args]
set -euo pipefail
cd "$(dirname "$0")/.."

id="liftlog-test-$$"
cleanup() { docker rm -f "$id-db" >/dev/null 2>&1 || true; docker network rm "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# An internal network: neither container gets a route out.
docker network create --internal "$id" >/dev/null
docker run -d --name "$id-db" --network "$id" -e POSTGRES_USER=liftlog -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=liftlog --tmpfs /var/lib/postgresql/data postgres:17.11-alpine3.24 >/dev/null

# Packages install on the default network first, then the tests run on the internal one.
# Cached in a volume, keyed by the requirements, so reruns skip the download.
key=$(cat backend/requirements.txt backend/requirements-dev.txt | sha256sum | cut -c1-12)
docker volume create liftlog-test-pip >/dev/null
docker run --rm -v liftlog-test-pip:/pip -v "$PWD/backend":/src:ro python:3.12.15-slim-bookworm \
  sh -c "[ -d /pip/$key ] || pip install -q --root-user-action=ignore --disable-pip-version-check --target /pip/$key -r /src/requirements-dev.txt"

until docker exec "$id-db" pg_isready -U liftlog -d liftlog >/dev/null 2>&1; do sleep 1; done
docker run --rm --network "$id" -v liftlog-test-pip:/pip:ro -v "$PWD/backend":/src:ro -w /src \
  -e PYTHONPATH=/src:/pip/$key -e PYTHONDONTWRITEBYTECODE=1 \
  -e TEST_DATABASE_URL="postgresql+psycopg://liftlog:test@$id-db:5432/liftlog" \
  python:3.12.15-slim-bookworm python -m pytest -q -p no:cacheprovider "$@"
