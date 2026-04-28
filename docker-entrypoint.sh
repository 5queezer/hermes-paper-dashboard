#!/bin/sh
set -eu
: "${COLLECT_INTERVAL_SECONDS:=60}"

mkdir -p /app/public/data /run/nginx

AUTH_SNIPPET=""
if [ -n "${DASHBOARD_BASIC_AUTH_USER:-}" ] && [ -n "${DASHBOARD_BASIC_AUTH_PASSWORD:-}" ]; then
  htpasswd -bc /etc/nginx/.paper-dashboard.htpasswd "$DASHBOARD_BASIC_AUTH_USER" "$DASHBOARD_BASIC_AUTH_PASSWORD" >/dev/null
  AUTH_SNIPPET='auth_basic "Hermes Paper Dashboard"; auth_basic_user_file /etc/nginx/.paper-dashboard.htpasswd;'
fi

cat > /etc/nginx/http.d/default.conf <<EOF
server {
  listen 80;
  server_name _;
  root /app/public;
  index index.html;
  ${AUTH_SNIPPET}
  location / { try_files \$uri \$uri/ /index.html; }
  location /data/ { add_header Cache-Control "no-store"; try_files \$uri =404; }
}
EOF

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
