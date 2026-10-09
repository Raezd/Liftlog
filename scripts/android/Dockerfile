# Build image for the Android app: JDK 21 for Gradle, Node for the web build
# and the Capacitor CLI. The Android SDK isn't in the image: it lives on
# /mnt/storage with the Gradle and npm caches (see scripts/android-build.sh),
# because build caches are disposable and the internal NVMe is small.
FROM node:22.23.3-bookworm-slim AS node

FROM eclipse-temurin:21.0.12_8-jdk-noble
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl unzip \
 && rm -rf /var/lib/apt/lists/*
