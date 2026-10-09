#!/usr/bin/env bash
# Deploy: build, take a verified pg_dump, then start the new containers.
# Migrations run when the backend starts, so the dump always comes first.
#
# Dumps go to /mnt/storage/backups/liftlog/predeploy (the newest 10 are kept),
# separate from the nightly dumps so neither overwrites the other.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

MOUNT=/mnt/storage
DEST="$MOUNT/backups/liftlog/predeploy"
export BUILD_ID="$(git rev-parse --short HEAD)"

[ -z "$(git status --porcelain)" ] || { echo "Commit first: the working tree isn't clean." >&2; exit 1; }
mountpoint -q "$MOUNT" || { echo "$MOUNT is not mounted, refusing to deploy without a dump." >&2; exit 1; }

echo "== building $BUILD_ID"
docker compose build

if [ -n "$(docker compose ps -q --status running db)" ]; then
  mkdir -p "$DEST"
  out="$DEST/liftlog-$(date +%Y%m%d-%H%M%S)-before-$BUILD_ID.dump"
  echo "== dumping to $out"
  docker compose exec -T db pg_dump -U liftlog -d liftlog -Fc > "$out.partial"
  docker compose exec -T db pg_restore --list < "$out.partial" > /dev/null
  mv "$out.partial" "$out"
  echo "   ok, $(du -h "$out" | cut -f1)"
  find "$DEST" -maxdepth 1 -name 'liftlog-*.dump' -printf '%T@ %p\n' | sort -rn | tail -n +11 | cut -d' ' -f2- | xargs -r rm -f
else
  echo "The database isn't running. Start it with 'docker compose up -d db' so it can be dumped first." >&2
  exit 1
fi

echo "== starting"
docker compose up -d
for _ in $(seq 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q backend)")" = healthy ] && break
  sleep 2
done
docker compose ps
docker compose exec -T backend alembic current 2>/dev/null | tail -1
docker stats --no-stream $(docker compose ps -q)
