#!/usr/bin/env bash
# Nightly Liftlog database backup to the external SSD.
#
# Retention: 7 daily, 4 weekly (Sundays), 12 monthly (1st of month).
# Weekly and monthly copies are hard links, so they cost no extra space
# until the daily copy they point at is pruned.
#
# Fails loudly (Discord alert, nonzero exit) instead of silently writing to the
# internal disk when the external drive isn't mounted.
set -Eeuo pipefail

LIFTLOG_DIR="${LIFTLOG_DIR:?LIFTLOG_DIR must be set}"
MOUNT="/mnt/storage"
DEST="$MOUNT/backups/liftlog"
COMPOSE=(docker compose --project-directory "$LIFTLOG_DIR")

# Read only the webhook from .env rather than sourcing the whole file.
WEBHOOK="$(grep -E '^DISCORD_WEBHOOK_URL=' "$LIFTLOG_DIR/.env" | cut -d= -f2- || true)"

notify() {
  [ -n "$WEBHOOK" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "{\"content\": \"[liftlog] $1\"}" "$WEBHOOK" >/dev/null || true
}

TMP=""
fail() {
  [ -n "$TMP" ] && rm -f "$TMP"
  notify "Backup FAILED on $(hostname) at $(date '+%F %T'): $1"
  echo "backup failed: $1" >&2
  exit 1
}
trap 'fail "command failed on line $LINENO"' ERR

# The trap: if the drive is unplugged, /mnt/storage is just an empty folder on
# the internal disk and a backup would "succeed" there. Refuse instead.
mountpoint -q "$MOUNT" || fail "$MOUNT is not mounted"

mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/monthly"

STAMP="$(date +%F)"
OUT="$DEST/daily/liftlog-$STAMP.dump"
TMP="$DEST/daily/.liftlog-$STAMP.partial"

# Custom-format dump: compressed, and restorable table by table if needed.
"${COMPOSE[@]}" exec -T db pg_dump -U liftlog -d liftlog -Fc > "$TMP"

# Prove the file is a readable archive before trusting it.
"${COMPOSE[@]}" exec -T db pg_restore --list < "$TMP" > /dev/null \
  || fail "dump written but not readable"

mv "$TMP" "$OUT"
TMP=""

[ "$(date +%u)" = 7 ]  && ln -f "$OUT" "$DEST/weekly/"
[ "$(date +%d)" = 01 ] && ln -f "$OUT" "$DEST/monthly/"

prune() {  # keep the newest $2 files in $1
  find "$1" -maxdepth 1 -name 'liftlog-*.dump' -printf '%T@ %p\n' \
    | sort -rn | tail -n +"$(( $2 + 1 ))" | cut -d' ' -f2- | xargs -r rm -f
}
prune "$DEST/daily" 7
prune "$DEST/weekly" 4
prune "$DEST/monthly" 12

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
