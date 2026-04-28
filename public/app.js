const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function cls(value) { return value > 0 ? 'good' : value < 0 ? 'bad' : ''; }
function money(value) { return fmtUsd.format(Number(value || 0)); }
function num(value) { return fmtNum.format(Number(value || 0)); }
function shortDate(value) { return value ? new Date(value).toLocaleString() : '—'; }

async function loadSnapshot() {
  const res = await fetch(`./data/snapshot.json?ts=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot http ${res.status}`);
  return res.json();
}

function renderSummary(summary) {
  const cards = [
    ['Open trades', summary.open_trades],
    ['Open notional', money(summary.open_notional_usd)],
    ['Open risk', money(summary.open_risk_usd)],
    ['Unrealized PnL', money(summary.open_unrealized_pnl_usd), cls(summary.open_unrealized_pnl_usd)],
    ['Realized PnL', money(summary.realized_pnl_usd), cls(summary.realized_pnl_usd)],
    ['Total marked PnL', money(summary.total_marked_pnl_usd), cls(summary.total_marked_pnl_usd)],
  ];
  document.querySelector('#summary-cards').innerHTML = cards.map(([label, value, klass='']) => `<article class="card"><div class="label">${label}</div><div class="value ${klass}">${value}</div></article>`).join('');
}

function renderCaps(caps) {
  document.querySelector('#risk-caps').innerHTML = Object.entries(caps).map(([key, cap]) => {
    const pct = cap.limit ? Math.min(150, (cap.used / cap.limit) * 100) : 0;
    const barClass = cap.breached ? 'badbar' : pct > 80 ? 'warnbar' : '';
    return `<div class="cap">
      <div class="cap-title"><span>${key.replaceAll('_', ' ')}</span><strong class="${cap.breached ? 'bad' : ''}">${num(cap.used)} / ${num(cap.limit)}</strong></div>
      <div class="bar"><div class="${barClass}" style="width:${Math.min(100, pct)}%"></div></div>
    </div>`;
  }).join('');
}

function table(el, columns, rows, empty='No rows') {
  const head = `<thead><tr>${columns.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;
  const body = rows.length ? `<tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r[c.key], r) : (r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody>` : `<tbody><tr><td colspan="${columns.length}">${empty}</td></tr></tbody>`;
  document.querySelector(el).innerHTML = head + body;
}

function renderTables(s) {
  const bucketRows = Object.values(s.bucket_metrics || {}).sort((a,b) => b.sample_size - a.sample_size);
  table('#bucket-metrics', [
    {key:'bucket', label:'Bucket'}, {key:'sample_size', label:'N'}, {key:'win_rate', label:'Win rate', render:v=>`${num(Number(v)*100)}%`},
    {key:'expectancy_r', label:'Expectancy', render:v=>`<span class="${cls(v)}">${num(v)}R</span>`},
    {key:'avg_mfe_r', label:'MFE', render:v=>v == null ? '—' : `${num(v)}R`}, {key:'avg_mae_r', label:'MAE', render:v=>v == null ? '—' : `${num(v)}R`},
    {key:'avg_hold_hours', label:'Hold h', render:v=>v == null ? '—' : num(v)}, {key:'auto_open_enabled', label:'Auto-open', render:v=>v ? '<span class="good">enabled</span>' : '<span class="bad">disabled</span>'},
    {key:'promotion_eligible', label:'Promote', render:v=>v ? '<span class="good">yes</span>' : 'no'},
  ], bucketRows, 'No bucket metrics yet');

  document.querySelector('#positions-caption').textContent = `${s.open_positions.length} open`;
  table('#open-positions', [
    {key:'symbol', label:'Symbol'}, {key:'side', label:'Side'}, {key:'asset_class', label:'Class'},
    {key:'entry', label:'Entry'}, {key:'mark', label:'Mark'}, {key:'stop', label:'Stop'}, {key:'target', label:'Target'},
    {key:'notional_usd', label:'Notional', render: money}, {key:'risk_usd', label:'Risk', render: money},
    {key:'unrealized_pnl_usd', label:'PnL', render:v=>`<span class="${cls(v)}">${money(v)}</span>`},
    {key:'unrealized_r', label:'R', render:v=>`<span class="${cls(v)}">${num(v)}R</span>`},
    {key:'distance_to_stop_pct', label:'Stop %', render:v=>`${num(v)}%`}, {key:'opened_at', label:'Opened', render:shortDate},
  ], s.open_positions, 'No open paper positions');

  table('#trade-history', [
    {key:'symbol', label:'Symbol'}, {key:'side', label:'Side'}, {key:'bucket', label:'Bucket'}, {key:'realized_pnl_usd', label:'PnL', render:v=>`<span class="${cls(v)}">${money(v)}</span>`},
    {key:'realized_r', label:'R', render:v=>`<span class="${cls(v)}">${num(v)}R</span>`}, {key:'outcome_label', label:'Outcome'}, {key:'exit_reason', label:'Exit'}, {key:'closed_at', label:'Closed', render:shortDate},
  ], s.trade_history, 'No closed trades yet');

  table('#scan-runs', [
    {key:'started_at', label:'Started', render:shortDate}, {key:'universe', label:'Universe'}, {key:'timeframe', label:'TF'}, {key:'candidates_created', label:'Candidates'}, {key:'trades_opened', label:'Trades'},
  ], s.scan_runs, 'No scan runs');

  table('#alerts', [
    {key:'received_at', label:'Received', render:shortDate}, {key:'symbol', label:'Symbol'}, {key:'event_type', label:'Event'}, {key:'interval', label:'TF'}, {key:'price', label:'Price'}, {key:'alert_name', label:'Alert'}, {key:'status', label:'Status'},
  ], s.tradingview_alerts, 'No TradingView alerts');
}

function drawChart(points) {
  const canvas = document.querySelector('#pnl-chart');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 36;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = '#253044'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, h-pad); ctx.lineTo(w-pad, h-pad); ctx.stroke();
  if (!points.length) return;
  const ys = points.flatMap(p => [p.realized_pnl_usd || 0, p.total_marked_pnl_usd || 0]);
  const min = Math.min(...ys, 0), max = Math.max(...ys, 0);
  const span = max - min || 1;
  const x = i => pad + (i / Math.max(1, points.length - 1)) * (w - pad*2);
  const y = v => h - pad - ((v - min) / span) * (h - pad*2);
  const draw = (key, color) => { ctx.strokeStyle=color; ctx.lineWidth=3; ctx.beginPath(); points.forEach((p,i)=>{ const yy=y(p[key]||0); if(i===0) ctx.moveTo(x(i),yy); else ctx.lineTo(x(i),yy); }); ctx.stroke(); };
  ctx.strokeStyle = '#475569'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(w-pad, y(0)); ctx.stroke();
  draw('realized_pnl_usd', '#38bdf8');
  draw('total_marked_pnl_usd', '#a78bfa');
  ctx.fillStyle = '#94a3b8'; ctx.font = '18px system-ui'; ctx.fillText(`${money(max)}`, 8, pad + 5); ctx.fillText(`${money(min)}`, 8, h - pad);
  document.querySelector('#pnl-caption').textContent = `Realized + total marked, ${points.length} points`;
}

async function main() {
  try {
    const snapshot = await loadSnapshot();
    renderSummary(snapshot.summary);
    renderCaps(snapshot.risk_caps);
    renderTables(snapshot);
    drawChart(snapshot.pnl_timeseries || []);
    document.querySelector('#freshness').textContent = `Updated ${shortDate(snapshot.generated_at)}`;
  } catch (err) {
    document.querySelector('#freshness').textContent = `Error: ${err.message}`;
    document.querySelector('#freshness').classList.add('bad');
  }
}

main();
setInterval(main, 60_000);
