#!/usr/bin/env bash
# Publishes a built APK to /download (data/apk, served by the backend).
#
#   scripts/android-publish.sh                 # the newest build
#   scripts/android-publish.sh path/to/x.apk   # a specific one (its .json beside it)
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${LIFTLOG_BUILD_CACHE:-/mnt/storage/liftlog-build}"
DEST="$REPO/data/apk"

die() { echo "android-publish: $*" >&2; exit 1; }

apk="${1:-$(ls -t "$CACHE"/out/liftlog-*.apk 2>/dev/null | head -1)}"
[ -n "$apk" ] && [ -f "$apk" ] || die "no APK found. Run scripts/android-build.sh first."
info="${apk%.apk}.json"
[ -f "$info" ] || die "missing $info"
[ "$(sha256sum "$apk" | cut -d' ' -f1)" = "$(jq -r .sha256 "$info")" ] || die "checksum doesn't match $info"
[ -w "$DEST" ] || die "$DEST is missing or not writable (see HANDOFF.md, Android app)"

# Copy, then rename, so a download in progress never sees half a file.
cp "$apk" "$DEST/.liftlog.apk.tmp" && mv -f "$DEST/.liftlog.apk.tmp" "$DEST/liftlog.apk"
cp "$info" "$DEST/.version.json.tmp" && mv -f "$DEST/.version.json.tmp" "$DEST/version.json"
echo "Published $(jq -r .version_name "$DEST/version.json") to /download"
