// Tabella shipping service (Cloudflare Worker).
// Holds the Shippo API key on the server and answers rate requests from Tabella pages.
//
// Secrets and settings (set in the Cloudflare dashboard, never in this file):
//   SHIPPO_API_KEY   required. Use the shippo_test_... key while testing.
//   ALLOWED_ORIGINS  optional. Comma-separated sites allowed to call this service.
//   SHOW_TEST_PAGE   optional. "true" shows a small test form at "/". Turn it off before using a live key.

const SHIPPO = 'https://api.goshippo.com';
const DEFAULT_ORIGINS = 'https://tabellasuite.com,https://www.tabellasuite.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/health') {
      return json({ ok: true, key: env.SHIPPO_API_KEY ? (isTestKey(env) ? 'test' : 'live') : 'missing' }, 200, cors);
    }

    if (url.pathname === '/' && request.method === 'GET') {
      if (String(env.SHOW_TEST_PAGE).toLowerCase() !== 'true') return new Response('Tabella shipping service', { headers: cors });
      return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/rates' && request.method === 'POST') {
      if (!env.SHIPPO_API_KEY) return json({ error: 'The SHIPPO_API_KEY secret is not set.' }, 500, cors);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Send JSON.' }, 400, cors); }
      const problem = checkRateRequest(body);
      if (problem) return json({ error: problem }, 400, cors);
      try {
        const rates = await getRates(env, body);
        return json({ testMode: isTestKey(env), rates }, 200, cors);
      } catch (e) {
        return json({ error: e.message || 'Shippo request failed.' }, 502, cors);
      }
    }

    return json({ error: 'Not found' }, 404, cors);
  }
};

function isTestKey(env) { return String(env.SHIPPO_API_KEY || '').startsWith('shippo_test_'); }

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}

const ADDRESS_FIELDS = ['name', 'street1', 'city', 'state', 'zip'];

function checkRateRequest(b) {
  if (!b || typeof b !== 'object') return 'Missing request body.';
  for (const side of ['from', 'to']) {
    const a = b[side];
    if (!a || typeof a !== 'object') return 'Missing "' + side + '" address.';
    for (const f of ADDRESS_FIELDS) if (!String(a[f] || '').trim()) return 'The "' + side + '" address needs ' + f + '.';
    if (!/^\d{5}(-\d{4})?$/.test(String(a.zip).trim())) return 'The "' + side + '" ZIP code looks wrong.';
  }
  const p = b.parcel;
  if (!p || typeof p !== 'object') return 'Missing parcel.';
  for (const f of ['length', 'width', 'height', 'weight']) {
    const n = Number(p[f]);
    if (!isFinite(n) || n <= 0) return 'Parcel ' + f + ' must be a number above 0.';
  }
  if (Number(p.weight) > 150) return 'Parcel weight is over 150 lb. Use freight.';
  return '';
}

function cleanAddress(a) {
  const out = { country: 'US' };
  for (const f of ['name', 'company', 'street1', 'street2', 'city', 'state', 'zip', 'phone', 'email']) {
    if (a[f] != null && String(a[f]).trim()) out[f] = String(a[f]).trim().slice(0, 100);
  }
  return out;
}

async function getRates(env, b) {
  const shipment = {
    address_from: cleanAddress(b.from),
    address_to: cleanAddress(b.to),
    parcels: [{
      length: String(Number(b.parcel.length)), width: String(Number(b.parcel.width)), height: String(Number(b.parcel.height)),
      distance_unit: 'in', weight: String(Number(b.parcel.weight)), mass_unit: 'lb'
    }],
    async: false
  };
  const res = await fetch(SHIPPO + '/shipments/', {
    method: 'POST',
    headers: { 'Authorization': 'ShippoToken ' + env.SHIPPO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(shipment)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && (data.detail || (data.messages && data.messages.map(m => m.text).join(' ')) || JSON.stringify(data).slice(0, 300));
    throw new Error('Shippo said: ' + (msg || res.status));
  }
  const rates = (data.rates || []).map(r => ({
    id: r.object_id,
    carrier: r.provider,
    service: r.servicelevel && r.servicelevel.name,
    amount: Number(r.amount),
    currency: r.currency,
    days: r.estimated_days == null ? null : r.estimated_days
  })).filter(r => isFinite(r.amount)).sort((x, y) => x.amount - y.amount);
  const notes = (data.messages || []).map(m => m.text).filter(Boolean);
  return { shipmentId: data.object_id, rates, notes };
}

const TEST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tabella shipping test</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1E2430}
fieldset{border:1px solid #ccc;border-radius:10px;margin:0 0 12px;padding:10px 12px}label{display:block;margin:6px 0;font-size:14px}
input{font:inherit;width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:8px}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}button{font:inherit;font-weight:600;padding:10px 16px;border-radius:10px;border:0;background:#2A4A7F;color:#fff;min-height:44px}
table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}.err{color:#B23A2E}</style></head>
<body><h1>Tabella shipping test</h1><p>Gets live rate quotes from Shippo using the key set on this service. With a test key, nothing is charged.</p>
<form id="f">
<fieldset><legend>Ship from</legend><label>Name<input name="fname" required></label><label>Street<input name="fstreet" required></label>
<div class="row"><label>City<input name="fcity" required></label><label>State<input name="fstate" maxlength="2" required></label><label>ZIP<input name="fzip" required></label></div></fieldset>
<fieldset><legend>Ship to</legend><label>Name<input name="tname" required></label><label>Street<input name="tstreet" required></label>
<div class="row"><label>City<input name="tcity" required></label><label>State<input name="tstate" maxlength="2" required></label><label>ZIP<input name="tzip" required></label></div></fieldset>
<fieldset><legend>Packed box</legend><div class="row"><label>Length (in)<input name="l" type="number" step="0.1" required></label><label>Width (in)<input name="w" type="number" step="0.1" required></label><label>Height (in)<input name="h" type="number" step="0.1" required></label><label>Weight (lb)<input name="wt" type="number" step="0.01" required></label></div></fieldset>
<button>Get rates</button></form><div id="out"></div>
<script>
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault(); var v = Object.fromEntries(new FormData(this)), out = document.getElementById('out'); out.textContent = 'Asking Shippo...';
  var body = { from: { name: v.fname, street1: v.fstreet, city: v.fcity, state: v.fstate, zip: v.fzip },
    to: { name: v.tname, street1: v.tstreet, city: v.tcity, state: v.tstate, zip: v.tzip },
    parcel: { length: v.l, width: v.w, height: v.h, weight: v.wt } };
  try {
    var r = await fetch('/rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json();
    if (!r.ok) { out.innerHTML = '<p class="err"></p>'; out.firstChild.textContent = d.error || 'Error'; return; }
    var t = document.createElement('table'); t.innerHTML = '<tr><th>Carrier</th><th>Service</th><th>Price</th><th>Days</th></tr>';
    d.rates.rates.forEach(function (x) { var tr = document.createElement('tr'); [x.carrier, x.service, '$' + x.amount.toFixed(2), x.days == null ? '' : x.days].forEach(function (c) { var td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }); t.appendChild(tr); });
    out.textContent = (d.testMode ? 'Test mode. ' : 'LIVE key. ') + d.rates.rates.length + ' rates.'; out.appendChild(t);
    if (d.rates.notes.length) { var p = document.createElement('p'); p.textContent = 'Shippo notes: ' + d.rates.notes.join(' '); out.appendChild(p); }
  } catch (err) { out.textContent = 'Could not reach the service: ' + err.message; }
});
</script></body></html>`;
