#!/usr/bin/env bash
# Nightly encrypted off-site backup of Liftlog to Backblaze B2 with restic.
# Runs as root at 04:05: after the 03:45 Liftlog dump, and finished well
# before Foodlog's own off-site job at 04:30. Self-contained: shares only the
# restic repository and its credentials with the rest of the homelab.
#
# Backs up dumps and config, never the live database directory: a file copy of
# a running database can restore corrupt.
#
# Restic settings come from root-only files, never from the repo:
#   /etc/restic/env       RESTIC_REPOSITORY, B2_ACCOUNT_ID, B2_ACCOUNT_KEY,
#                         and optionally OFFSITE_LIMIT_UPLOAD (KiB/s)
#   /etc/restic/password  the repository password
# That B2 key cannot delete. Pruning happens monthly from Trav's PC with a
# separate key; `restic forget` groups snapshots by host and paths, so these
# get their own 7 daily, 4 weekly, 12 monthly retention.
# Never run this with `bash -x`: it would echo secrets to the journal.
set -Eeuo pipefail

LIFTLOG_DIR="${LIFTLOG_DIR:?LIFTLOG_DIR must be set}"
MOUNT="/mnt/storage"
# Override only to test the alert, for example MOUNT_CHECK=/nonexistent.
MOUNT_CHECK="${MOUNT_CHECK:-$MOUNT}"
DUMPS="$MOUNT/backups/liftlog"
# The Android release keystore and its password (scripts/android-keystore.sh).
# Without them, app updates need an uninstall that wipes the phone's data.
SIGNING_DIR="${LIFTLOG_SIGNING_DIR:-$(dirname "$LIFTLOG_DIR")/.liftlog-signing}"

# Read only the webhook from .env rather than sourcing the whole file.
WEBHOOK="$(grep -E '^DISCORD_WEBHOOK_URL=' "$LIFTLOG_DIR/.env" | cut -d= -f2- || true)"

# Messages are plain text built here. Never pass restic output or file
# contents, so nothing secret can reach Discord.
notify() {
  [ -n "$WEBHOOK" ] || return 0
  jq -cn --arg c "[liftlog offsite] $1" '{content: $c}' \
    | curl -fsS -m 10 -H 'Content-Type: application/json' -d @- "$WEBHOOK" >/dev/null || true
}

fail() {
  notify "Off-site backup FAILED on $(hostname) at $(date '+%F %T'): $1. Details: journalctl -u liftlog-offsite"
  echo "off-site backup failed: $1" >&2
  exit 1
}
trap 'fail "command failed on line $LINENO"' ERR

# One run at a time.
exec 9>/run/liftlog-offsite.lock
flock -n 9 || fail "another Liftlog off-site run is still going"

# If the drive is unplugged, /mnt/storage is an empty folder on the internal
# disk, and backing that up would look like everything was deleted.
mountpoint -q "$MOUNT_CHECK" || fail "$MOUNT_CHECK is not mounted"

[ -r /etc/restic/env ] && [ -r /etc/restic/password ] \
  || fail "/etc/restic/env or /etc/restic/password is missing or unreadable (run as root)"
set -a
# shellcheck disable=SC1091
. /etc/restic/env
set +a
export RESTIC_PASSWORD_FILE=/etc/restic/password
# Root services under systemd have no HOME, so pin the cache somewhere stable.
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
command -v restic >/dev/null || fail "restic is not installed"

# A stale dump is worth knowing about, but the rest is still worth backing up.
newest="$(find "$DUMPS/daily" -maxdepth 1 -name 'liftlog-*.dump' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 || true)"
if [ -z "$newest" ]; then
  notify "Warning on $(hostname): no Liftlog dump found. Check liftlog-backup.timer."
elif [ $(( $(date +%s) - ${newest%.*} )) -gt $(( 26 * 3600 )) ]; then
  notify "Warning on $(hostname): newest Liftlog dump is over 26 hours old. Check liftlog-backup.timer."
fi

PATHS=(
  "$DUMPS"
  "$LIFTLOG_DIR/.env"
  "$LIFTLOG_DIR/docker-compose.yml"
  "$LIFTLOG_DIR/tailscale/serve.json"
  # The liftlog node's Tailscale identity. Restoring it brings back the same
  # device, Serve URL, and device share instead of a re-register.
  "$LIFTLOG_DIR/data/tailscale"
  "$SIGNING_DIR/liftlog-release.p12"
  "$SIGNING_DIR/keystore-password"
)
for p in "${PATHS[@]}"; do
  [ -e "$p" ] || fail "expected path is missing: $p"
done

OPTS=(--tag liftlog --tag nightly --retry-lock 15m)
[ -n "${OFFSITE_LIMIT_UPLOAD:-}" ] && OPTS+=(--limit-upload "$OFFSITE_LIMIT_UPLOAD")

# Exit 3 means some files couldn't be read. The snapshot exists but is
# incomplete, so treat it as a failure like any other nonzero exit.
rc=0
restic backup "${OPTS[@]}" "${PATHS[@]}" || rc=$?
[ "$rc" = 0 ] || fail "restic backup exited with status $rc"

echo "off-site backup ok"
