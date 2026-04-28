# Hermes Paper Trader Dashboard

A tiny read-only static dashboard for Hermes paper/research trading.

## Files

- `scripts/collect_dashboard_snapshot.mjs` queries Supabase/Postgres and writes sanitized JSON under `public/data/`.
- `public/index.html`, `public/app.js`, `public/style.css` render the dashboard in-browser.
- `Dockerfile` runs the collector loop plus nginx for Coolify.

## Local collection

```bash
node scripts/collect_dashboard_snapshot.mjs
```

Required runtime env for the collector only:

```text
SUPABASE_PROJECT_URL
SUPABASE_PASSWORD
```

Optional:

```text
COLLECT_INTERVAL_SECONDS=60
PAPERBOT_MAX_OPEN_TRADES=10
PAPERBOT_MAX_OPEN_CRYPTO_TRADES=8
PAPERBOT_MAX_OPEN_STOCK_TRADES=4
PAPERBOT_MAX_TOTAL_OPEN_NOTIONAL_USD=500
PAPERBOT_MAX_TOTAL_OPEN_RISK_USD=10
PAPERBOT_MAX_NEW_TRADES_PER_DAY=8
```

The browser never receives database credentials. Generated JSON is read-only/sanitized trading state.

## Serve locally

```bash
node scripts/collect_dashboard_snapshot.mjs
cd public
python3 -m http.server 8090 --bind 127.0.0.1
```

## Coolify deployment

Deploy this directory as a Docker app. Expose container port `80`.

Recommended subdomain examples:

```text
paper.vasudev.xyz
trader.vasudev.xyz
paper-trader.vasudev.xyz
```

Set environment variables in Coolify secrets/env, not in the repo. Protect the subdomain with Cloudflare Access or Coolify auth/reverse-proxy auth. This UI is read-only, but it can still reveal strategy state and portfolio history.
