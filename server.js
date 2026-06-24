/*
  JADE SUPREMA — Trailing Stop Server
  Runs on Render.com free tier, 24/7.
  Every 60 seconds it checks Zerodha and ratchets trailing SL GTTs
  so you don't need to keep your screen open.

  NO database, NO complex setup.
  State is stored in a simple JSON file (state.json) on the server.
*/

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// ── Config ────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const ZD_WORKER  = 'https://jade-kite.sundeep1080.workers.dev'; // your existing Worker

// ── Trail engine constants — mirror HTML exactly ──────────────────
const TRAIL_STEP = 0.5;  // % move before SL re-ratchets

function trailDistanceFor(gainPct, atrPct) {
  const base   = atrPct ? Math.min(2.2, Math.max(0.8, atrPct * 1.1)) : 1.5;
  const growth = 1 + 0.6 * (1 - Math.exp(-gainPct / 8));
  return parseFloat((base * growth).toFixed(2));
}

// ── Simple state file — replaces KV/database ─────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch(e) { log('State load error: ' + e.message); }
  return { trailState: {}, auth: null };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch(e) { log('State save error: ' + e.message); }
}

// ── Logging ───────────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// ── HTTP helper — calls Zerodha via your existing Worker ──────────
function kiteCall(method, kitePath, bodyStr, auth) {
  return new Promise((resolve) => {
    const url      = new URL(`${ZD_WORKER}/kite/${kitePath}`);
    const headers  = {
      'X-Kite-Version': '3',
      'Authorization' : `token ${auth.api_key}:${auth.token}`
    };
    if (bodyStr) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const options = {
      hostname: url.hostname,
      path    : url.pathname + url.search,
      method,
      headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Fetch LTP for all trailing symbols in one Kite call ──────────
async function fetchLTPs(syms, auth) {
  if (!syms.length) return {};
  const query = syms.map(s => `i=NSE%3A${encodeURIComponent(s)}`).join('&');
  const j     = await kiteCall('GET', `quote?${query}`, null, auth);
  if (!j || j.status !== 'success') return {};
  const ltps = {};
  Object.entries(j.data || {}).forEach(([key, val]) => {
    ltps[key.replace('NSE:', '')] = val.last_price;
  });
  return ltps;
}

// ── Place a single-leg trailing SL GTT ───────────────────────────
async function placeTrailSL(st, slPx, isBuy, auth) {
  const r10    = v => Math.round(v * 10) / 10;
  slPx         = r10(slPx);
  const exitTxn = isBuy ? 'SELL' : 'BUY';
  const cond   = { exchange: 'NSE', tradingsymbol: st.sym,
                   trigger_values: [slPx], last_price: st.entry };
  const orders = [{ exchange: 'NSE', tradingsymbol: st.sym,
                    transaction_type: exitTxn, quantity: st.qty,
                    order_type: 'LIMIT', product: st.product, price: slPx }];
  const params = new URLSearchParams({
    type: 'single',
    condition: JSON.stringify(cond),
    orders   : JSON.stringify(orders)
  });
  const j = await kiteCall('POST', 'gtt/triggers', params.toString(), auth);
  if (j && j.status === 'success' && j.data && j.data.trigger_id) {
    return String(j.data.trigger_id);
  }
  log(`PlaceTrailSL FAILED ${st.sym}: ${j ? j.message : 'null response'}`);
  return null;
}

// ── Cancel a GTT ─────────────────────────────────────────────────
async function cancelGTT(gttId, auth) {
  if (!gttId) return;
  await kiteCall('DELETE', `gtt/triggers/${gttId}`, null, auth);
}

// ═════════════════════════════════════════════════════════════════
// THE MAIN TRAILING ENGINE
// This runs every 60 seconds and does what your browser used to do.
// ═════════════════════════════════════════════════════════════════
async function runTrailingEngine() {
  const state = loadState();
  const { auth, trailState } = state;

  // No auth yet — browser hasn't logged in and sent the token
  if (!auth || !auth.api_key || !auth.token) {
    log('Engine: no auth token yet — waiting for browser login');
    return;
  }

  const ids = Object.keys(trailState);
  if (!ids.length) {
    log('Engine: no active trailing positions');
    return;
  }

  log(`Engine: checking ${ids.length} position(s)`);

  // Fetch GTT list once for all positions
  const gttResp = await kiteCall('GET', 'gtt/triggers', null, auth);
  const gttList = (gttResp && gttResp.status === 'success')
    ? (gttResp.data || []) : [];

  // Fetch all LTPs in one batch
  const syms = [...new Set(ids.map(id => trailState[id].sym))];
  const ltps = await fetchLTPs(syms, auth);

  let changed = false;

  for (const logId of ids) {
    const st    = trailState[logId];
    if (!st) continue;
    const ltp   = ltps[st.sym];
    const isBuy = st.dir === 'BUY';

    // ── Stage: fixed ─────────────────────────────────────────────
    // Waiting for GTT-A TP to fire. Once it does, cancel GTT-B and
    // move to tp_hit so we place the floor SL next cycle.
    if (st.stage === 'fixed') {
      const gttA = gttList.find(g => String(g.id) === String(st.gttAId));
      if (!gttA) continue;
      if (gttA.status !== 'triggered') {
        log(`${st.sym}: fixed stage, GTT-A not triggered yet`);
        continue;
      }

      // Confirmed fill price from broker
      const fill = (gttA.orders && gttA.orders[0] &&
                    gttA.orders[0].average_price > 0)
                   ? gttA.orders[0].average_price : null;

      // Was it TP or SL that fired?
      const tv  = (gttA.condition && gttA.condition.trigger_values) || [];
      let isTP  = true;
      if (tv.length === 2) {
        const mid = (tv[0] + tv[1]) / 2;
        isTP = fill ? (fill > mid) : true;
      }

      if (!isTP) {
        log(`${st.sym}: SL hit — removing from trail`);
        delete trailState[logId];
        changed = true;
        continue;
      }

      const confirmedFloor = fill || st.floor;
      log(`${st.sym}: TP hit @ ₹${confirmedFloor} — cancelling GTT-B, advancing to tp_hit`);
      await cancelGTT(st.gttBId, auth);
      st.stage = 'tp_hit';
      st.floor = confirmedFloor;
      st.peak  = confirmedFloor;
      changed  = true;
      continue;
    }

    // ── Stage: tp_hit ─────────────────────────────────────────────
    // Place the floor SL GTT immediately. Retries next cycle if it fails.
    if (st.stage === 'tp_hit') {
      log(`${st.sym}: placing floor SL @ ₹${st.floor}`);
      const newSl = await placeTrailSL(st, st.floor, isBuy, auth);
      if (newSl) {
        st.slGttId = newSl;
        st.peak    = ltp || st.floor;
        st.stage   = 'trailing';
        st.active  = true;
        log(`${st.sym}: floor SL GTT ${newSl} placed — now trailing ✅`);
        changed = true;
      } else {
        log(`${st.sym}: floor SL place failed — will retry next minute`);
      }
      continue;
    }

    // ── Stage: trailing ───────────────────────────────────────────
    // Check if SL GTT fired (position closed). If not, ratchet up.
    if (st.stage === 'trailing') {
      // Check if trailing SL itself got triggered
      if (st.slGttId) {
        const slGtt = gttList.find(g => String(g.id) === String(st.slGttId));
        if (slGtt && (slGtt.status === 'triggered' ||
                      slGtt.status === 'disabled')) {
          log(`${st.sym}: trailing SL triggered — position closed, removing`);
          delete trailState[logId];
          changed = true;
          continue;
        }
      }

      if (!ltp) { log(`${st.sym}: no LTP — skipping this cycle`); continue; }

      // Has price made a new peak?
      const movedUp = isBuy ? ltp > st.peak : ltp < st.peak;
      if (!movedUp) {
        log(`${st.sym}: ltp ₹${ltp} | peak ₹${st.peak} | SL ₹${st.lastSlPx || st.floor} — no new high`);
        continue;
      }

      const peakMovePct = isBuy
        ? ((ltp - st.peak) / st.peak * 100)
        : ((st.peak - ltp) / st.peak * 100);

      if (peakMovePct < TRAIL_STEP) {
        log(`${st.sym}: new high but only +${peakMovePct.toFixed(2)}% — waiting for ${TRAIL_STEP}%`);
        continue;
      }

      // Compute new SL using ATR-adjusted trail distance
      const gainPct     = isBuy
        ? ((ltp - st.entry) / st.entry * 100)
        : ((st.entry - ltp) / st.entry * 100);
      const trailPct    = trailDistanceFor(gainPct, st.atrPct);
      const candidateSl = isBuy
        ? parseFloat((ltp * (1 - trailPct / 100)).toFixed(2))
        : parseFloat((ltp * (1 + trailPct / 100)).toFixed(2));
      const newFloor = isBuy
        ? Math.max(candidateSl, st.floor)
        : Math.min(candidateSl, st.floor);

      // Skip if change is trivially small
      if (Math.abs(newFloor - (st.lastSlPx || st.floor)) < 0.05) continue;

      log(`${st.sym}: ratcheting SL ₹${st.lastSlPx || st.floor} → ₹${newFloor} (ltp ₹${ltp}, gain +${gainPct.toFixed(1)}%)`);

      // Place new SL first, then cancel old — position never unprotected
      const oldSlId = st.slGttId;
      const newSl   = await placeTrailSL(st, newFloor, isBuy, auth);
      if (newSl) {
        await cancelGTT(oldSlId, auth);
        st.slGttId  = newSl;
        st.peak     = ltp;
        st.lastSlPx = newFloor;
        log(`${st.sym}: SL ratcheted → ₹${newFloor} GTT ${newSl} ✅`);
        changed = true;
      } else {
        log(`${st.sym}: ratchet GTT place failed — keeping old SL, retry next minute`);
      }
    }
  }

  if (changed) {
    state.trailState = trailState;
    saveState(state);
    log('State saved.');
  }
}

// ═════════════════════════════════════════════════════════════════
// HTTP SERVER
// Render requires an HTTP server to keep the process alive.
// Also receives trail state and auth from your HTML.
// ═════════════════════════════════════════════════════════════════

// ── Secret key — set this as an environment variable on Render ──
// Render Dashboard → your service → Environment → Add environment variable
// Key: TRAIL_SECRET   Value: pick any long random string e.g. jade2024sundeep
// Your HTML must send the same value in every request header.
// Anyone without this key gets a 401 — even if they know your URL.
const TRAIL_SECRET = process.env.TRAIL_SECRET || null;

function checkSecret(req, res) {
  // If no secret is configured, warn in logs but allow (backwards compat)
  if (!TRAIL_SECRET) {
    log('WARNING: TRAIL_SECRET not set — endpoints are unprotected. Set it on Render.');
    return true;
  }
  const incoming = req.headers['x-trail-secret'] || '';
  if (incoming !== TRAIL_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"status":"error","message":"unauthorized"}');
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  // CORS headers — allow your HTML to talk to this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Trail-Secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const url = req.url.split('?')[0];

  // ── GET /state — HTML reads current trail state ───────────────
  // Protected: requires X-Trail-Secret header
  // Returns trailState only — never returns auth/token to the caller
  if (req.method === 'GET' && url === '/state') {
    if (!checkSecret(req, res)) return;
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state.trailState || {}));
    return;
  }

  // ── POST /state — HTML sends updated trail state + auth ───────
  // Protected: requires X-Trail-Secret header
  if (req.method === 'POST' && url === '/state') {
    if (!checkSecret(req, res)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const state   = loadState();
        if (payload.state !== undefined) state.trailState = payload.state;
        // Store auth but never echo it back in any response
        if (payload.auth && payload.auth.api_key) state.auth = payload.auth;
        saveState(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      } catch(e) {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // ── GET /ping — health check — public, but shows no sensitive data ──
  if (req.method === 'GET' && url === '/ping') {
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status   : 'ok',
      has_auth : !!(state.auth && state.auth.token),
      positions: Object.keys(state.trailState || {}).length,
      time     : new Date().toISOString()
    }));
    return;
  }

  // ── GET / — simple status page — public, shows no sensitive data ──
  if (req.method === 'GET' && url === '/') {
    const state    = loadState();
    const positions = Object.values(state.trailState || {});
    const html = `<!DOCTYPE html><html>
<head><title>Jade Suprema Trail Engine</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{background:#07090d;color:#9ab8cc;font-family:monospace;padding:20px;max-width:600px;margin:0 auto}
  h2{color:#f0c040}
  .ok{color:#22d46e} .warn{color:#f0c040} .card{background:#0c111a;border:1px solid #2a3f58;border-radius:8px;padding:14px;margin:10px 0}
  table{width:100%;border-collapse:collapse} td,th{padding:6px 10px;border-bottom:1px solid #1a2a3a;text-align:left}
</style></head>
<body>
<h2>🪂 Jade Suprema — Trail Engine</h2>
<div class="card">
  <div>Status: <span class="ok">● Running</span></div>
  <div>Auth: <span class="${state.auth ? 'ok' : 'warn'}">${state.auth ? '✅ Token present' : '⚠ No token — open HTML and connect Kite'}</span></div>
  <div>Active positions: <strong class="ok">${positions.length}</strong></div>
  <div>Server time: ${new Date().toLocaleString('en-IN')}</div>
</div>
${positions.length ? `
<div class="card">
<table>
<tr><th>Symbol</th><th>Stage</th><th>Entry</th><th>Floor SL</th><th>Peak</th></tr>
${positions.map(p => `<tr>
  <td><strong>${p.sym}</strong></td>
  <td>${p.stage}</td>
  <td>₹${p.entry}</td>
  <td>₹${p.lastSlPx || p.floor}</td>
  <td>₹${p.peak || '—'}</td>
</tr>`).join('')}
</table>
</div>` : '<div class="card warn">No positions being trailed right now.</div>'}
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  log(`Trail engine server started on port ${PORT}`);
  log(`Status page: http://localhost:${PORT}`);
});

// ── Run engine every 60 seconds ───────────────────────────────────
log('Trail engine starting — first run in 10 seconds...');
setTimeout(() => {
  runTrailingEngine();
  setInterval(runTrailingEngine, 60 * 1000);
}, 10000);
