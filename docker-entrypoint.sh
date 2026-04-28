#!/bin/sh
set -eu
: "${COLLECT_INTERVAL_SECONDS:=60}"

mkdir -p /app/public/data

collect_once() {
  node /app/scripts/collect_dashboard_snapshot.mjs || true
}

collect_once
(
  while true; do
    sleep "$COLLECT_INTERVAL_SECONDS"
    collect_once
  done
) &

exec nginx -g 'daemon off;'
