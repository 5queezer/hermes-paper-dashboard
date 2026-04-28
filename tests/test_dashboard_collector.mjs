import assert from 'node:assert/strict';
import { buildDashboardSnapshot } from '../scripts/collect_dashboard_snapshot.mjs';

const rows = {
  openPositions: [
    {
      id: 'trade-1',
      symbol: 'BTCUSDT',
      side: 'long',
      asset_class: 'crypto',
      planned_entry: '100',
      planned_stop: '95',
      planned_target: '110',
      risk_amount: '1',
      position_size: '0.2',
      opened_at: '2026-04-26T10:00:00.000Z',
      current_mark: '104'
    }
  ],
  closedTrades: [
    {
      id: 'trade-closed',
      symbol: 'ETHUSDT',
      side: 'long',
      planned_entry: '50',
      position_size: '1',
      realized_pnl: '-1',
      realized_r: '-1',
      outcome_label: 'controlled_loss',
      exit_reason: 'planned_stop_hit',
      setup_type: 'breakout',
      strategy_bucket: 'breakout_watchlist',
      opened_at: '2026-04-25T10:00:00.000Z',
      closed_at: '2026-04-25T11:00:00.000Z'
    },
    {
      id: 'trade-closed-win',
      symbol: 'SOLUSDT',
      side: 'long',
      planned_entry: '25',
      position_size: '1',
      realized_pnl: '0.5',
      realized_r: '0.5',
      outcome_label: 'clean_win',
      exit_reason: 'planned_target_hit',
      setup_type: 'trend_continuation',
      strategy_bucket: 'trend_continuation',
      opened_at: '2026-04-25T12:00:00.000Z',
      closed_at: '2026-04-25T13:00:00.000Z'
    }
  ],
  scanRuns: [
    {
      id: 'scan-1',
      universe: 'crypto',
      timeframe: '15m',
      mode: 'paper',
      created_at: '2026-04-26T10:10:00.000Z',
      candidates_created: '2',
      trades_opened: '1'
    }
  ],
  caps: {
    max_open_trades: 10,
    max_open_crypto_trades: 8,
    max_open_stock_trades: 4,
    max_total_open_notional_usd: 500,
    max_total_open_risk_usd: 10,
    max_new_trades_per_day: 8,
    new_trades_24h: 1
  }
};

const snapshot = buildDashboardSnapshot(rows, { generatedAt: '2026-04-26T12:00:00.000Z' });

assert.equal(snapshot.summary.mode, 'paper');
assert.equal(snapshot.summary.no_real_trades, true);
assert.equal(snapshot.summary.open_trades, 1);
assert.equal(snapshot.summary.closed_trades, 2);
assert.equal(snapshot.summary.open_notional_usd, 20);
assert.equal(snapshot.summary.open_unrealized_pnl_usd, 0.8);
assert.equal(snapshot.summary.realized_pnl_usd, -0.5);
assert.equal(snapshot.summary.total_marked_pnl_usd, 0.3);
assert.equal(snapshot.open_positions[0].unrealized_r, 0.8);
assert.equal(snapshot.risk_caps.open_trades.used, 1);
assert.equal(snapshot.risk_caps.open_trades.limit, 10);
assert.equal(snapshot.risk_caps.open_notional_usd.used, 20);
assert.equal(snapshot.risk_caps.open_notional_usd.limit, 500);
assert.ok(Array.isArray(snapshot.pnl_timeseries));
assert.ok(snapshot.pnl_timeseries.length >= 2);
assert.equal(snapshot.scan_runs[0].candidates_created, 2);
assert.equal(snapshot.trade_history[0].realized_pnl_usd, -1);
assert.equal(snapshot.bucket_metrics.breakout_watchlist.sample_size, 1);
assert.equal(snapshot.bucket_metrics.breakout_watchlist.expectancy_r, -1);
assert.equal(snapshot.bucket_metrics.breakout_watchlist.auto_open_enabled, false);
assert.equal(snapshot.bucket_metrics.trend_continuation.win_rate, 1);
assert.equal(snapshot.bucket_metrics.trend_continuation.expectancy_r, 0.5);
console.log('dashboard_collector_test=passed');
