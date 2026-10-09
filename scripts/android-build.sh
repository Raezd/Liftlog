#!/usr/bin/env bash
# Builds the signed release APK in the build container. Run from anywhere:
#
#   scripts/android-build.sh            # then scripts/android-publish.sh
#
# The SDK, Gradle, and npm caches and the built APKs live under
# /mnt/storage/liftlog-build. The keystore and its password are read from
# ~/.liftlog-signing (scripts/android-keystore.sh makes them).
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${LIFTLOG_BUILD_CACHE:-/mnt/storage/liftlog-build}"
KEYDIR="${LIFTLOG_SIGNING_DIR:-$HOME/.liftlog-signing}"
IMAGE=liftlog-android-build:1

die() { echo "android-build: $*" >&2; exit 1; }

mountpoint -q /mnt/storage || die "/mnt/storage is not mounted"
echo "== Free space"
df -h / /mnt/storage
# Gradle plus the SDK want a few GB the first time; the image is on the NVMe.
[ "$(df --output=avail -k /mnt/storage | tail -1)" -gt $((8 * 1024 * 1024)) ] || die "less than 8 GB free on /mnt/storage"
[ "$(df --output=avail -k / | tail -1)" -gt $((4 * 1024 * 1024)) ] || die "less than 4 GB free on /"

[ -w "$CACHE" ] || die "$CACHE is missing or not writable (see HANDOFF.md, Android app)"
[ -r "$KEYDIR/liftlog-release.p12" ] && [ -r "$KEYDIR/keystore-password" ] \
  || die "no keystore in $KEYDIR. Run scripts/android-keystore.sh once."

cd "$REPO"
if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-}" != 1 ]; then
  die "uncommitted changes. Commit first, or set ALLOW_DIRTY=1 for a test build."
fi
VERSION_CODE="$(git rev-list --count HEAD)"
VERSION_NAME="$VERSION_CODE-$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain)" ] || VERSION_NAME="$VERSION_NAME-dirty"

# The API's address: this stack's own Tailscale name, unless overridden.
if [ -z "${LIFTLOG_API_BASE:-}" ]; then
  host="$(docker compose exec -T tailscale tailscale status --json | jq -r '.Self.DNSName')"
  [ -n "$host" ] && [ "$host" != null ] || die "couldn't read the Tailscale hostname. Set LIFTLOG_API_BASE."
  LIFTLOG_API_BASE="https://${host%.}"
fi

mkdir -p "$CACHE/android-sdk" "$CACHE/gradle" "$CACHE/npm" "$CACHE/out"
docker build -q -t "$IMAGE" - < scripts/android/Dockerfile >/dev/null

docker run --rm \
  -u "$(id -u):$(id -g)" \
  --memory 4g \
  -e HOME=/tmp/home \
  -e GRADLE_USER_HOME=/cache/gradle \
  -e npm_config_cache=/cache/npm \
  -e API_BASE="$LIFTLOG_API_BASE" \
  -e VERSION_CODE="$VERSION_CODE" \
  -e VERSION_NAME="$VERSION_NAME" \
  -v "$CACHE/android-sdk:/sdk" \
  -v "$CACHE/gradle:/cache/gradle" \
  -v "$CACHE/npm:/cache/npm" \
  -v "$CACHE/out:/out" \
  -v "$REPO/frontend/app:/src:ro" \
  -v "$REPO/scripts/android/build-inside.sh:/build.sh:ro" \
  -v "$KEYDIR:/keys:ro" \
  "$IMAGE" bash /build.sh

echo "== Built $CACHE/out/liftlog-$VERSION_NAME.apk"
echo "== Free space after"
df -h / /mnt/storage
du -sh "$CACHE"
