#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pg;
try {
  pg = require('pg');
} catch {
  pg = require('/opt/data/paperbot/node_modules/pg');
}
const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(PUBLIC_DIR, 'data');

const DEFAULT_CAPS = {
  max_open_trades: Number(process.env.PAPERBOT_MAX_OPEN_TRADES || 10),
  max_open_crypto_trades: Number(process.env.PAPERBOT_MAX_OPEN_CRYPTO_TRADES || 8),
  max_open_stock_trades: Number(process.env.PAPERBOT_MAX_OPEN_STOCK_TRADES || 4),
  max_total_open_notional_usd: Number(process.env.PAPERBOT_MAX_TOTAL_OPEN_NOTIONAL_USD || 500),
  max_total_open_risk_usd: Number(process.env.PAPERBOT_MAX_TOTAL_OPEN_RISK_USD || 10),
  max_new_trades_per_day: Number(process.env.PAPERBOT_MAX_NEW_TRADES_PER_DAY || 8),
};

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function round(value, digits = 2) {
  const x = n(value);
  const factor = 10 ** digits;
  return Math.round((x + Number.EPSILON) * factor) / factor;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function computePosition(row) {
  const entry = n(row.planned_entry);
  const stop = n(row.planned_stop);
  const target = row.planned_target == null ? null : n(row.planned_target);
  const quantity = n(row.position_size);
  const risk = n(row.risk_amount, Math.abs(entry - stop) * quantity || 1);
  const mark = row.current_mark == null ? entry : n(row.current_mark, entry);
  const direction = row.side === 'short' ? -1 : 1;
  const unrealized = (mark - entry) * quantity * direction;
  const notional = entry * quantity;
  const stopDistancePct = entry ? ((mark - stop) / entry) * 100 * direction : 0;
  const targetDistancePct = target && entry ? ((target - mark) / entry) * 100 * direction : null;
  return {
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    asset_class: row.asset_class || 'other',
    entry: round(entry, 6),
    stop: round(stop, 6),
    target: target == null ? null : round(target, 6),
    mark: round(mark, 6),
    quantity: round(quantity, 8),
    notional_usd: round(notional, 2),
    risk_usd: round(risk, 2),
    unrealized_pnl_usd: round(unrealized, 2),
    unrealized_r: risk ? round(unrealized / risk, 2) : 0,
    distance_to_stop_pct: round(stopDistancePct, 2),
    distance_to_target_pct: targetDistancePct == null ? null : round(targetDistancePct, 2),
    opened_at: iso(row.opened_at),
    age_hours: row.opened_at ? round((Date.now() - new Date(row.opened_at).getTime()) / 36e5, 1) : null,
  };
}

function buildPnlTimeseries(closedTrades, openUnrealized, generatedAt) {
  const ordered = [...closedTrades].sort((a, b) => String(a.closed_at || '').localeCompare(String(b.closed_at || '')));
  let realized = 0;
  const points = [];
  for (const row of ordered) {
    realized += n(row.realized_pnl ?? row.net_pnl ?? row.gross_pnl);
    points.push({ t: iso(row.closed_at || row.opened_at), realized_pnl_usd: round(realized, 2), total_marked_pnl_usd: round(realized, 2) });
  }
  points.push({ t: generatedAt, realized_pnl_usd: round(realized, 2), open_unrealized_pnl_usd: round(openUnrealized, 2), total_marked_pnl_usd: round(realized + openUnrealized, 2) });
  return points.filter(p => p.t);
}

function bucketFor(row) {
  const bucket = row.strategy_bucket || row.bucket || row.policy_bucket || row.features?.policy_v2?.bucket || row.setup_type || 'unknown';
  return bucket === 'breakout' ? 'breakout_watchlist' : bucket;
}

function isMetricsExcluded(row) {
  const exitReason = String(row.exit_reason || '').toLowerCase();
  const outcome = String(row.outcome_label || '').toLowerCase();
  return exitReason.includes('duplicate_open_closed_after_dedupe_fix') || outcome === 'duplicate_cleanup';
}

function newBucketMetric(bucket, autoOpenDefault = true) {
  return {
    bucket,
    sample_size: 0,
    metrics_excluded_count: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    expectancy_r: 0,
    avg_mfe_r: null,
    avg_mae_r: null,
    avg_hold_hours: null,
    auto_open_enabled: autoOpenDefault,
    promotion_eligible: false,
    promotion_min_sample: 30,
    promotion_sample_ready: false,
    promotion_sample_shortfall: 30,
  };
}

function buildBucketMetrics(closedTrades) {
  const buckets = {};
  for (const b of ['trend_continuation', 'breakout_watchlist', 'breakout_confirmed', 'high_rvol_experimental']) {
    buckets[b] = newBucketMetric(b, b !== 'breakout_watchlist' && b !== 'high_rvol_experimental');
  }
  for (const row of closedTrades || []) {
    const b = bucketFor(row);
    buckets[b] ||= newBucketMetric(b, true);
    const m = buckets[b];
    if (isMetricsExcluded(row)) {
      m.metrics_excluded_count += 1;
      continue;
    }
    const r = n(row.realized_r ?? row.r_multiple);
    m.sample_size += 1;
    m.expectancy_r += r;
    if (r > 0) m.wins += 1; else if (r < 0) m.losses += 1;
    m._mfe = (m._mfe || 0) + n(row.max_favorable_excursion, 0);
    m._mae = (m._mae || 0) + n(row.max_adverse_excursion, 0);
    if (row.opened_at && row.closed_at) m._hold = (m._hold || 0) + ((new Date(row.closed_at) - new Date(row.opened_at)) / 36e5);
  }
  for (const m of Object.values(buckets)) {
    if (m.sample_size) {
      m.win_rate = round(m.wins / m.sample_size, 3);
      m.expectancy_r = round(m.expectancy_r / m.sample_size, 2);
      m.avg_mfe_r = round((m._mfe || 0) / m.sample_size, 2);
      m.avg_mae_r = round((m._mae || 0) / m.sample_size, 2);
      m.avg_hold_hours = round((m._hold || 0) / m.sample_size, 2);
    }
    m.promotion_sample_ready = m.sample_size >= m.promotion_min_sample;
    m.promotion_sample_shortfall = Math.max(0, m.promotion_min_sample - m.sample_size);
    if (m.sample_size >= 10 && m.expectancy_r < -0.25) m.auto_open_enabled = false;
    if (m.sample_size < 30 && (m.bucket === 'breakout_watchlist' || m.bucket === 'high_rvol_experimental')) m.auto_open_enabled = false;
    if (m.promotion_sample_ready && m.expectancy_r > 0) { m.promotion_eligible = true; m.auto_open_enabled = m.bucket !== 'breakout_watchlist'; }
    delete m._mfe; delete m._mae; delete m._hold;
  }
  return buckets;
}

export function buildDashboardSnapshot(rows, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const openPositions = (rows.openPositions || []).map(computePosition).sort((a, b) => Math.abs(b.unrealized_r) - Math.abs(a.unrealized_r));
  const tradeHistory = (rows.closedTrades || []).map(row => ({
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    entry: round(row.planned_entry, 6),
    quantity: round(row.position_size, 8),
    realized_pnl_usd: round(row.realized_pnl ?? row.net_pnl ?? row.gross_pnl, 2),
    realized_r: round(row.realized_r ?? row.r_multiple, 2),
    bucket: bucketFor(row),
    outcome_label: row.outcome_label || null,
    exit_reason: row.exit_reason || null,
    opened_at: iso(row.opened_at),
    closed_at: iso(row.closed_at),
  }));
  const openNotional = openPositions.reduce((s, p) => s + p.notional_usd, 0);
  const openRisk = openPositions.reduce((s, p) => s + p.risk_usd, 0);
  const openUnrealized = openPositions.reduce((s, p) => s + p.unrealized_pnl_usd, 0);
  const realized = tradeHistory.reduce((s, t) => s + t.realized_pnl_usd, 0);
  const caps = { ...DEFAULT_CAPS, ...(rows.caps || {}) };
  const byClass = openPositions.reduce((acc, p) => { acc[p.asset_class] = (acc[p.asset_class] || 0) + 1; return acc; }, {});
  const riskCaps = {
    open_trades: { used: openPositions.length, limit: n(caps.max_open_trades), breached: openPositions.length >= n(caps.max_open_trades) },
    open_crypto_trades: { used: byClass.crypto || 0, limit: n(caps.max_open_crypto_trades), breached: (byClass.crypto || 0) >= n(caps.max_open_crypto_trades) },
    open_stock_trades: { used: byClass.equity || byClass.stock || 0, limit: n(caps.max_open_stock_trades), breached: (byClass.equity || byClass.stock || 0) >= n(caps.max_open_stock_trades) },
    open_notional_usd: { used: round(openNotional, 2), limit: n(caps.max_total_open_notional_usd), breached: openNotional >= n(caps.max_total_open_notional_usd) },
    open_risk_usd: { used: round(openRisk, 2), limit: n(caps.max_total_open_risk_usd), breached: openRisk >= n(caps.max_total_open_risk_usd) },
    new_trades_24h: { used: n(caps.new_trades_24h), limit: n(caps.max_new_trades_per_day), breached: n(caps.new_trades_24h) >= n(caps.max_new_trades_per_day) },
  };
  return {
    generated_at: generatedAt,
    summary: {
      mode: 'paper',
      no_real_trades: true,
      open_trades: openPositions.length,
      closed_trades: tradeHistory.length,
      open_notional_usd: round(openNotional, 2),
      open_risk_usd: round(openRisk, 2),
      open_unrealized_pnl_usd: round(openUnrealized, 2),
      realized_pnl_usd: round(realized, 2),
      total_marked_pnl_usd: round(realized + openUnrealized, 2),
      last_scan_at: iso((rows.scanRuns || [])[0]?.created_at || (rows.scanRuns || [])[0]?.started_at),
    },
    risk_caps: riskCaps,
    open_positions: openPositions,
    trade_history: tradeHistory,
    pnl_timeseries: buildPnlTimeseries(rows.closedTrades || [], openUnrealized, generatedAt),
    bucket_metrics: buildBucketMetrics(rows.closedTrades || []),
    scan_runs: (rows.scanRuns || []).map(r => ({
      id: r.id,
      universe: r.universe,
      timeframe: r.timeframe,
      mode: r.mode,
      started_at: iso(r.created_at || r.started_at),
      completed_at: iso(r.completed_at),
      candidates_created: n(r.candidates_created),
      trades_opened: n(r.trades_opened),
    })),
    tradingview_alerts: (rows.alerts || []).map(a => ({
      id: a.id,
      received_at: iso(a.received_at),
      symbol: a.symbol,
      event_type: a.event_type,
      interval: a.interval,
      price: a.price == null ? null : round(a.price, 6),
      alert_name: a.alert_name,
      status: a.status,
    })),
  };
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'hermes-paper-dashboard/0.1' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function fetchMarks(openRows) {
  const entries = await Promise.all(openRows.map(async row => {
    if (row.current_mark != null) return [row.symbol, n(row.current_mark)];
    if ((row.asset_class || '').toLowerCase() === 'crypto' || row.symbol.endsWith('USDT')) {
      const data = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(row.symbol)}`);
      return [row.symbol, data?.price == null ? n(row.planned_entry) : n(data.price, n(row.planned_entry))];
    }
    const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(row.symbol)}?interval=1m&range=1d`);
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return [row.symbol, price == null ? n(row.planned_entry) : n(price, n(row.planned_entry))];
  }));
  return Object.fromEntries(entries);
}

async function connectClient() {
  const url = process.env.SUPABASE_PROJECT_URL;
  const password = process.env.SUPABASE_PASSWORD;
  if (!url || !password) throw new Error('SUPABASE_PROJECT_URL/SUPABASE_PASSWORD missing');
  const ref = new URL(url).hostname.split('.')[0];
  const client = new Client({ host: `db.${ref}.supabase.co`, port: 5432, database: 'postgres', user: 'postgres', password, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

export async function collectRows(client) {
  const open = await client.query(`
    select pt.id, pt.symbol, pt.side, pt.planned_entry, pt.planned_stop, pt.planned_target,
           pt.risk_amount, pt.position_size, pt.opened_at, coalesce(tc.asset_class, 'other') as asset_class
    from paper_trades pt
    left join trade_candidates tc on tc.id = pt.candidate_id
    where pt.status = 'open'
    order by pt.opened_at desc nulls last
  `);
  const marks = await fetchMarks(open.rows);
  const openPositions = open.rows.map(r => ({ ...r, current_mark: marks[r.symbol] }));

  const closed = await client.query(`
    select pt.id, pt.symbol, pt.side, pt.planned_entry, pt.position_size, pt.exit_reason,
           pt.opened_at, pt.closed_at, coalesce(toc.net_pnl, toc.gross_pnl, 0) as realized_pnl,
           toc.r_multiple as realized_r, toc.outcome_label, toc.max_favorable_excursion, toc.max_adverse_excursion,
           tc.setup_type, tc.features, coalesce(tc.features->'policy_v2'->>'bucket', tc.setup_type, 'unknown') as strategy_bucket
    from paper_trades pt
    left join trade_outcomes toc on toc.paper_trade_id = pt.id
    left join trade_candidates tc on tc.id = pt.candidate_id
    where pt.status = 'closed'
    order by pt.closed_at desc nulls last, pt.opened_at desc nulls last
    limit 250
  `);
  const scanRuns = await client.query(`
    select sr.id, sr.universe, sr.timeframe, sr.mode, sr.started_at, sr.completed_at,
           count(tc.id)::int as candidates_created,
           count(pt.id)::int as trades_opened
    from scan_runs sr
    left join trade_candidates tc on tc.scan_run_id = sr.id
    left join paper_trades pt on pt.candidate_id = tc.id
    group by sr.id
    order by sr.started_at desc
    limit 50
  `);
  const daily = await client.query(`select count(*)::int as new_trades_24h from paper_trades where opened_at >= now() - interval '24 hours'`);
  let alerts = { rows: [] };
  try {
    alerts = await client.query(`select id, received_at, symbol, event_type, interval, price, alert_name, status from tradingview_alerts order by received_at desc limit 50`);
  } catch {}
  return { openPositions, closedTrades: closed.rows, scanRuns: scanRuns.rows, alerts: alerts.rows, caps: { ...DEFAULT_CAPS, new_trades_24h: daily.rows[0]?.new_trades_24h || 0 } };
}

async function writeJson(name, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  let client;
  try {
    client = await connectClient();
    const rows = await collectRows(client);
    const snapshot = buildDashboardSnapshot(rows);
    await writeJson('snapshot.json', snapshot);
    await writeJson('summary.json', snapshot.summary);
    await writeJson('open_positions.json', snapshot.open_positions);
    await writeJson('risk_caps.json', snapshot.risk_caps);
    await writeJson('trade_history.json', snapshot.trade_history);
    await writeJson('pnl_timeseries.json', snapshot.pnl_timeseries);
    await writeJson('bucket_metrics.json', snapshot.bucket_metrics);
    await writeJson('scan_runs.json', snapshot.scan_runs);
    await writeJson('tradingview_alerts.json', snapshot.tradingview_alerts);
    console.log(JSON.stringify({ ok: true, generated_at: snapshot.generated_at, open_trades: snapshot.summary.open_trades, total_marked_pnl_usd: snapshot.summary.total_marked_pnl_usd, output: DATA_DIR, no_real_trades: true }, null, 2));
  } finally {
    if (client) await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(JSON.stringify({ ok: false, error: err.message, no_secrets_printed: true }, null, 2));
    process.exit(1);
  });
}
