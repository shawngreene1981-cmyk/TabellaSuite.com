// Road-trip shop notes for the mall map. Public read; writes need the ADMIN_KEY secret.
// Stored as one small JSON list in the TABELLA KV under "trip:shops". Nothing is ever deleted:
// "Hide from map" sets s = 'x' so it can be brought back.

const KEY = 'trip:shops';

export async function handleTrips(request, env, url, json, cors) {
  const p = url.pathname;
  if (!p.startsWith('/trip/')) return null;
  try {
    if (!env.TABELLA) return json({ error: 'Storage is not set up.' }, 500, cors);
    if (p === '/trip/shops' && request.method === 'GET') {
      return new Response(JSON.stringify({ shops: await load(env) }), { headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'public, max-age=30' }, cors) });
    }
    if (p === '/trip/check' && request.method === 'POST') { await auth(request, env); return json({ ok: true }, 200, cors); }
    if (p === '/trip/shops' && request.method === 'POST') {
      await auth(request, env);
      const b = await request.json().catch(() => ({}));
      const name = clean(b.name, 90), town = clean(b.town, 60);
      if (!name || !town) throw err(400, 'Add the shop name and the town, like "Nixa, MO".');
      if (!/^.+,\s*[A-Za-z]{2}$/.test(town)) throw err(400, 'Write the town with its state, like "Nixa, MO".');
      const s = ['v', 'r', 'x'].includes(b.s) ? b.s : 'r';
      const best = clean(b.best, 300);
      if (s === 'v' && !best) throw err(400, 'Add a line on what the shop is best for, so the map can show it.');
      const visited = /^\d{4}-\d{2}-\d{2}$/.test(b.visited || '') ? b.visited : '';
      const list = await load(env), id = slug(name + ' ' + town);
      let e = list.find(x => x.id === id);
      if (!e) { e = { id, name, town, created: Date.now() }; list.push(e); }
      Object.assign(e, { name, town, s, best, visited, updated: Date.now() });
      if (b.known === false && !e.ll) e.ll = await geocode(town);
      await env.TABELLA.put(KEY, JSON.stringify(list));
      return json({ ok: true, shop: e }, 200, cors);
    }
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

async function load(env) { try { return JSON.parse((await env.TABELLA.get(KEY)) || '[]'); } catch (e) { return []; } }

async function auth(request, env) {
  if (!env.ADMIN_KEY) throw err(500, 'The ADMIN_KEY secret is not set in Cloudflare yet.');
  const ip = request.headers.get('CF-Connecting-IP') || 'x', rk = 'rlt:' + ip;
  const fails = Number(await env.TABELLA.get(rk)) || 0;
  if (fails >= 10) throw err(429, 'Too many wrong keys. Try again in an hour.');
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!same(got, env.ADMIN_KEY)) { await env.TABELLA.put(rk, String(fails + 1), { expirationTtl: 3600 }); throw err(401, 'That key is not right.'); }
}

function same(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }

async function geocode(town) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(town),
    { headers: { 'User-Agent': 'TabellaSuite mall map (contact@tabellasuite.com)' } }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => []) : [];
  if (!d[0]) throw err(400, 'Could not find "' + town + '" on the map. Check the spelling, like "Nixa, MO".');
  return [Math.round(Number(d[0].lat) * 1e4) / 1e4, Math.round(Number(d[0].lon) * 1e4) / 1e4];
}

function clean(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function slug(t) { return t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120); }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
