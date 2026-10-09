#!/usr/bin/env bash
# One time: makes the release keystore and its password, outside the repo.
# Both are in the nightly off-site backup (scripts/offsite-backup.sh).
# Losing the keystore means every update needs an uninstall, which wipes the
# app's data on the phone, so this refuses to overwrite one.
set -Eeuo pipefail

KEYDIR="${LIFTLOG_SIGNING_DIR:-$HOME/.liftlog-signing}"
IMAGE=liftlog-android-build:1
REPO="$(cd "$(dirname "$0")/.." && pwd)"

[ ! -e "$KEYDIR/liftlog-release.p12" ] || { echo "A keystore already exists in $KEYDIR. Not touching it." >&2; exit 1; }

umask 077
mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR"
[ -s "$KEYDIR/keystore-password" ] || openssl rand -hex 24 > "$KEYDIR/keystore-password"
chmod 600 "$KEYDIR/keystore-password"

docker build -q -t "$IMAGE" - < "$REPO/scripts/android/Dockerfile" >/dev/null
docker run --rm -u "$(id -u):$(id -g)" -v "$KEYDIR:/keys" "$IMAGE" \
  keytool -genkeypair -keystore /keys/liftlog-release.p12 -storetype PKCS12 \
    -storepass:file /keys/keystore-password -alias liftlog \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Liftlog, O=Liftlog" >/dev/null
chmod 600 "$KEYDIR/liftlog-release.p12"
ls -l "$KEYDIR"
