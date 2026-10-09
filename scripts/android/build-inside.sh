#!/usr/bin/env bash
# Runs inside the build container (scripts/android-build.sh starts it).
# Never run with `bash -x`: it would echo the keystore password.
set -Eeuo pipefail

SDK=/sdk
# Android command-line tools, pinned by build number and checksum.
CLT_BUILD=15859902
CLT_SHA1=040d3996a65543d22ec4bf73e4c37aa37a8d4af4
SDK_PACKAGES=("platforms;android-36" "build-tools;35.0.0")

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "== Installing Android command-line tools into the SDK cache"
  curl -fsSL -o /tmp/clt.zip "https://dl.google.com/android/repository/commandlinetools-linux-${CLT_BUILD}_latest.zip"
  echo "$CLT_SHA1  /tmp/clt.zip" | sha1sum -c -
  rm -rf /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt
  mkdir -p "$SDK/cmdline-tools" && rm -rf "$SDK/cmdline-tools/latest"
  mv /tmp/clt/cmdline-tools "$SDK/cmdline-tools/latest"
fi
export ANDROID_HOME="$SDK"
SDKM="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKM" --licenses >/dev/null 2>&1 || true
"$SDKM" --install "${SDK_PACKAGES[@]}" >/tmp/sdkmanager.log 2>&1 || { cat /tmp/sdkmanager.log; exit 1; }

echo "== Web build for the app (API at $API_BASE)"
# Build from a copy: the source is mounted read-only.
W=/tmp/w
mkdir -p "$W"
cd /src
tar cf - --exclude=./node_modules --exclude=./dist --exclude=./android/app/build \
  --exclude=./android/build --exclude=./android/.gradle . | tar xf - -C "$W"
cd "$W"
npm ci --no-audit --no-fund
VITE_API_BASE="$API_BASE" BUILD_ID="$VERSION_NAME" npm run build
npx cap sync android

echo "== Gradle release build $VERSION_NAME (code $VERSION_CODE)"
cd android
export LIFTLOG_KEYSTORE=/keys/liftlog-release.p12
LIFTLOG_KEYSTORE_PASSWORD="$(cat /keys/keystore-password)"
export LIFTLOG_KEYSTORE_PASSWORD
./gradlew --no-daemon --console=plain -q assembleRelease \
  -PliftlogVersionCode="$VERSION_CODE" -PliftlogVersionName="$VERSION_NAME"
unset LIFTLOG_KEYSTORE_PASSWORD

APK=app/build/outputs/apk/release/app-release.apk
echo "== Verifying the signature"
"$SDK/build-tools/35.0.0/apksigner" verify --print-certs "$APK" | grep -E 'Signer #1 certificate (DN|SHA-256)'
out="/out/liftlog-$VERSION_NAME"
cp "$APK" "$out.apk"
printf '{"version_name": "%s", "version_code": %s, "size": %s, "sha256": "%s", "built_at": "%s"}\n' \
  "$VERSION_NAME" "$VERSION_CODE" "$(stat -c %s "$out.apk")" "$(sha256sum "$out.apk" | cut -d' ' -f1)" \
  "$(date -u +%FT%TZ)" > "$out.json"
cat "$out.json"
