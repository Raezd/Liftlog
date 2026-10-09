#!/usr/bin/env bash
# Liftlog health check, run every 5 minutes by liftlog-health.timer.
#
# Passes only if backend is running and healthy and db and web are running.
# On pass it pings an Uptime Kuma push monitor. On fail it sends nothing, so
# Kuma alerts on the missing beat. That also covers the host being down.
#
# The push URL is a secret. systemd reads it from a root-only EnvironmentFile
# (/etc/liftlog/health.env) as KUMA_PUSH_URL. It's passed to curl on stdin so
# it never shows up in the process list or the journal.
set -Eeuo pipefail

LIFTLOG_DIR="${LIFTLOG_DIR:?LIFTLOG_DIR must be set}"
: "${KUMA_PUSH_URL:?KUMA_PUSH_URL must be set (see HANDOFF.md)}"

# One line per running container: "service state health".
status="$(docker compose --project-directory "$LIFTLOG_DIR" ps \
  --format '{{.Service}} {{.State}} {{.Health}}')"

problems=()
check() {
  local service="$1" want="$2" line
  line="$(grep -E "^$service " <<<"$status" || true)"
  if [ -z "$line" ]; then
    problems+=("$service is not running")
  elif ! grep -qE "^$service $want\$" <<<"$line"; then
    problems+=("$service is '${line#"$service "}', want '$want'")
  fi
}
check backend "running healthy"
check db "running( .*)?"
check web "running( .*)?"

if [ "${#problems[@]}" -gt 0 ]; then
  printf 'health check failed: %s\n' "${problems[@]}" >&2
  exit 1
fi

curl -fsS -m 10 -o /dev/null -K - <<<"url = \"$KUMA_PUSH_URL\""
echo "healthy, pinged Kuma"
