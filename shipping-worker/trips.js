// Road-trip shop notes for the mall map. Public read; writes need the ADMIN_KEY secret.
// Stored as one small JSON list in the TABELLA KV under "trip:shops". Nothing is ever deleted:
// "Hide from map" sets s = 'x' so it can be brought back.

import { sendEmail, opsEmail, noteEmail } from './mail.js';
import { geocode, limit, buildState, nextState } from './places.js';

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
      const s = ['v', 'r', 'x', 'o'].includes(b.s) ? b.s : 'r';
      const best = clean(b.best, 300);
      if (s === 'v' && !best) throw err(400, 'Add a line on what the shop is best for, so the map can show it.');
      const visited = /^\d{4}-\d{2}-\d{2}$/.test(b.visited || '') ? b.visited : '';
      const list = await load(env), id = slug(name + ' ' + town);
      let e = list.find(x => x.id === id);
      if (!e) { e = { id, name, town, created: Date.now() }; list.push(e); }
      Object.assign(e, { name, town, s, best, visited, updated: Date.now() });
      if (b.known === false && !e.ll) { const g = await geocode(env, town); e.ll = [g.lat, g.lon]; }
      await env.TABELLA.put(KEY, JSON.stringify(list));
      return json({ ok: true, shop: e }, 200, cors);
    }
    // ----- Fill in the nationwide shop list now, one state per call (the timer does the same every 5 minutes).
    if (p === '/trip/build' && request.method === 'POST') {
      await auth(request, env);
      const meta = JSON.parse((await env.TABELLA.get('osm:states')) || '{}'), now = Date.now();
      const b = await request.json().catch(() => ({}));
      const st = /^[A-Z]{2}$/.test(b.state || '') ? b.state : nextState(meta, now);
      const done = Object.keys(meta).filter(x => meta[x].t).length;
      if (!st) return json({ result: 'all fresh', done, of: 51, meta }, 200, cors);
      const result = await buildState(env, st, meta, now);
      return json({ result, state: st, done: Object.keys(meta).filter(x => meta[x].t).length, of: 51, meta }, 200, cors);
    }
    // ----- Listing claims: a shop owner asks to verify a listing and add their website. Shawn approves each one.
    if (p === '/trip/claim' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      if (b.hp) return json({ ok: true }, 200, cors);
      await limit(env, request, 'rlc:', 5, 'Too many requests from here. Try again in an hour, or write to contact@tabellasuite.com.');
      const t = b.target || {}, o = b.owner || {};
      const target = { id: clean(t.id, 130), name: clean(t.name, 90), town: clean(t.town, 60), addr: clean(t.addr, 140),
        lat: num(t.lat, 90), lon: num(t.lon, 180) };
      if (!target.name) throw err(400, 'Add the shop name.');
      if (!/^.+,\s*[A-Za-z]{2}$/.test(target.town)) throw err(400, 'Add the town with its state, like "Nixa, MO".');
      if (!target.id) target.id = 'new';
      const owner = { name: clean(o.name, 80), role: clean(o.role, 60), email: clean(o.email, 120).toLowerCase(), phone: clean(o.phone, 30) };
      if (!owner.name) throw err(400, 'Add your name.');
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(owner.email)) throw err(400, 'Add an email address we can reply to.');
      const website = site(b.website), shopPhone = clean(b.shopPhone, 30), note = clean(b.note, 600);
      if (b.website && !website) throw err(400, 'That website address does not look right. Try one like relicsantiquemall.com.');
      if (target.id === 'new' && !target.addr) throw err(400, 'Add the shop street address so we can put it on the map.');
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const c = { id, created: Date.now(), status: 'pending', target, owner, website, shopPhone, note };
      await env.TABELLA.put('claim:' + id, JSON.stringify(c), { expirationTtl: 400 * 86400 });
      await sendEmail(env, { to: opsEmail(env), replyTo: owner.email, subject: 'Listing claim: ' + target.name + ', ' + target.town,
        html: noteEmail('New listing claim', [owner.name + (owner.role ? ' (' + owner.role + ')' : '') + ' wants to verify <b>' + h(target.name) + '</b> in ' + h(target.town) + '.',
          'Website: ' + h(website || 'none given') + '<br>Shop phone: ' + h(shopPhone || 'none given') + (target.addr ? '<br>Address: ' + h(target.addr) : ''),
          note ? 'Note: ' + h(note) : '', 'Review it at tabellasuite.com/trip/ under Listing claims.']) }).catch(() => null);
      return json({ ok: true }, 200, cors);
    }
    if (p === '/trip/claims' && request.method === 'GET') {
      await auth(request, env);
      const l = await env.TABELLA.list({ prefix: 'claim:' });
      const all = (await Promise.all(l.keys.map(k => env.TABELLA.get(k.name).then(v => v && JSON.parse(v))))).filter(Boolean).sort((a, b) => b.created - a.created);
      return json({ claims: all.slice(0, 100) }, 200, cors);
    }
    const mc = p.match(/^\/trip\/claims\/([a-z0-9]{6,20})$/);
    if (mc && request.method === 'POST') {
      await auth(request, env);
      const raw = await env.TABELLA.get('claim:' + mc[1]);
      if (!raw) throw err(404, 'That claim was not found.');
      const c = JSON.parse(raw), b = await request.json().catch(() => ({}));
      if (c.status !== 'pending') throw err(409, 'That claim was already ' + c.status + '.');
      if (b.action === 'decline') { c.status = 'declined'; c.decided = Date.now(); await env.TABELLA.put('claim:' + c.id, JSON.stringify(c), { expirationTtl: 400 * 86400 }); return json({ ok: true, claim: c }, 200, cors); }
      if (b.action !== 'approve') throw err(400, 'Choose approve or decline.');
      const website = b.website !== undefined ? site(b.website) : c.website;
      const list = await load(env), T = c.target;
      const id = T.id === 'new' ? slug(T.name + ' ' + T.town) : T.id;
      let e = list.find(x => x.id === id);
      if (!e) { e = { id, name: T.name, town: T.town, s: 'o', created: Date.now() }; list.push(e); }
      if (T.lat != null && T.lon != null) e.ll = [T.lat, T.lon];
      else if (T.id === 'new' || T.id.startsWith('osm-')) { const g = await geocode(env, T.addr ? T.addr + ', ' + T.town : T.town); e.ll = [g.lat, g.lon]; }
      Object.assign(e, { verified: true, website, phone: c.shopPhone || e.phone || '', addr: T.addr || e.addr || '', updated: Date.now() });
      if (T.id.startsWith('osm-')) e.osm = T.id;
      await env.TABELLA.put(KEY, JSON.stringify(list));
      c.status = 'approved'; c.decided = Date.now(); c.listing = id;
      await env.TABELLA.put('claim:' + c.id, JSON.stringify(c), { expirationTtl: 400 * 86400 });
      let mailed = null;
      if (b.emailOwner) mailed = await sendEmail(env, { to: c.owner.email, subject: T.name + ' is verified on Tabella',
        html: noteEmail('Your listing is verified', ['Hi ' + h(c.owner.name.split(' ')[0]) + ',', '<b>' + h(T.name) + '</b> now shows as verified on the Tabella mall map' + (website ? ', with a link to ' + h(website.replace(/^https?:\/\//, '').replace(/\/$/, '')) : '') + '.',
          'See it at tabellasuite.com/map.html. To change anything, reply to this email.']) }).catch(() => ({ error: 'send failed' }));
      return json({ ok: true, claim: c, shop: e, mailed }, 200, cors);
    }
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

async function load(env) { try { return JSON.parse((await env.TABELLA.get(KEY)) || '[]'); } catch (e) { return []; } }

export async function auth(request, env) {
  if (!env.ADMIN_KEY) throw err(500, 'The ADMIN_KEY secret is not set in Cloudflare yet.');
  const ip = request.headers.get('CF-Connecting-IP') || 'x', rk = 'rlt:' + ip;
  const fails = Number(await env.TABELLA.get(rk)) || 0;
  if (fails >= 10) throw err(429, 'Too many wrong keys. Try again in an hour.');
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!same(got, env.ADMIN_KEY)) { await env.TABELLA.put(rk, String(fails + 1), { expirationTtl: 3600 }); throw err(401, 'That key is not right.'); }
}

function same(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }


function site(v) {
  v = clean(v, 200); if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return ''; return u.origin + (u.pathname === '/' ? '' : u.pathname); } catch (e) { return ''; }
}
function num(v, m) { v = Number(v); return isFinite(v) && Math.abs(v) <= m && v !== 0 ? Math.round(v * 1e5) / 1e5 : null; }
function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clean(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function slug(t) { return t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120); }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
