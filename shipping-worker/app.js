// Tabella dealer app API: accounts, items, photos, payouts.
// Storage: the TABELLA KV namespace (see wrangler.toml).
//   user:<email>            account login record (password hash, never returned)
//   dealer:<id>             shop profile (name, Stripe account, private ship-from address)
//   sess:<token>            signed-in session -> dealer id (30 days)
//   item:<dealer>:<item>    an item
//   itemix:<item>           item -> dealer lookup
//   pub:<item>              listing in the public shop (summary kept in KV metadata, so the shop reads it in one call)
//   img:<key>               photo bytes (JPEG)
//   rl:<email>              failed sign-in counter

import { createRecipient, recipientLink, recipientReady } from './stripe.js';

const SESSION_TTL = 60 * 60 * 24 * 30;
const MAX_PHOTO = 1.5 * 1024 * 1024;
const CATEGORIES = ['Decor', 'Furniture', 'Glassware', 'Seasonal', 'Lighting', 'Art', 'Kitchen', 'Jewelry', 'Toys', 'Books', 'Other'];

export async function handleApp(request, env, url, json, cors) {
  const p = url.pathname;
  if (p.startsWith('/img/') && request.method === 'GET') return image(env, p.slice(5), cors);
  if (!p.startsWith('/app/')) return null;
  if (!env.TABELLA) return json({ error: 'The TABELLA store is not set up yet.' }, 500, cors);
  try {
    if (p === '/app/signup' && request.method === 'POST') return json(await signup(env, await body(request)), 200, cors);
    if (p === '/app/login' && request.method === 'POST') return json(await login(env, await body(request)), 200, cors);

    const me = await session(env, request);
    if (!me) return json({ error: 'Please sign in again.', signin: true }, 401, cors);

    if (p === '/app/logout' && request.method === 'POST') { await env.TABELLA.delete('sess:' + me.token); return json({ ok: true }, 200, cors); }
    if (p === '/app/me' && request.method === 'GET') return json({ dealer: publicDealer(me.dealer), categories: CATEGORIES }, 200, cors);
    if (p === '/app/me' && request.method === 'PUT') return json({ dealer: publicDealer(await updateDealer(env, me.dealer, await body(request))) }, 200, cors);
    if (p === '/app/photo' && request.method === 'POST') return json(await savePhoto(env, me.dealer, request), 200, cors);
    if (p === '/app/items' && request.method === 'GET') return json({ items: await listItems(env, me.dealer.id) }, 200, cors);
    if (p === '/app/items' && request.method === 'POST') return json({ item: await saveItem(env, me.dealer, null, await body(request)) }, 200, cors);
    const m = p.match(/^\/app\/items\/(T[0-9A-Z]{6})$/);
    if (m && request.method === 'PUT') return json({ item: await saveItem(env, me.dealer, m[1], await body(request)) }, 200, cors);
    if (p === '/app/payouts' && request.method === 'POST') return json(await payouts(env, me.dealer, url, await body(request)), 200, cors);
    if (p === '/app/payouts' && request.method === 'GET') return json(await payoutStatus(env, me.dealer), 200, cors);
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

// ---------- accounts ----------
async function signup(env, b) {
  const email = cleanEmail(b.email), shop = clean(b.shop, 60), pw = String(b.password || '');
  if (!email) throw err(400, 'Enter a valid email.');
  if (!shop) throw err(400, 'Enter your shop name.');
  if (pw.length < 8) throw err(400, 'Use a password of at least 8 characters.');
  if (await env.TABELLA.get('user:' + email)) throw err(409, 'There is already an account for that email. Sign in instead.');
  const id = 'd' + rand(10), salt = rand(16);
  await env.TABELLA.put('user:' + email, JSON.stringify({ id, email, salt, hash: await hashPw(pw, salt), created: Date.now() }));
  const dealer = { id, email, name: shop, created: Date.now() };
  await env.TABELLA.put('dealer:' + id, JSON.stringify(dealer));
  return { token: await newSession(env, id), dealer: publicDealer(dealer) };
}
async function login(env, b) {
  const email = cleanEmail(b.email), pw = String(b.password || '');
  if (!email || !pw) throw err(400, 'Enter your email and password.');
  const fails = Number(await env.TABELLA.get('rl:' + email) || 0);
  if (fails >= 8) throw err(429, 'Too many tries. Wait 15 minutes and try again.');
  const u = JSON.parse(await env.TABELLA.get('user:' + email) || 'null');
  if (!u || (await hashPw(pw, u.salt)) !== u.hash) {
    await env.TABELLA.put('rl:' + email, String(fails + 1), { expirationTtl: 900 });
    throw err(401, 'That email and password don’t match.');
  }
  await env.TABELLA.delete('rl:' + email);
  const dealer = JSON.parse(await env.TABELLA.get('dealer:' + u.id) || 'null');
  return { token: await newSession(env, u.id), dealer: publicDealer(dealer) };
}
async function newSession(env, id) { const t = rand(40); await env.TABELLA.put('sess:' + t, id, { expirationTtl: SESSION_TTL }); return t; }
async function session(env, request) {
  const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-z0-9]{40}$/.test(t)) return null;
  const id = await env.TABELLA.get('sess:' + t);
  if (!id) return null;
  const dealer = JSON.parse(await env.TABELLA.get('dealer:' + id) || 'null');
  return dealer ? { token: t, dealer } : null;
}
async function updateDealer(env, d, b) {
  if (b.name != null) { const n = clean(b.name, 60); if (!n) throw err(400, 'Enter your shop name.'); d.name = n; }
  if (b.shipFrom) {
    const a = {};
    for (const f of ['name', 'street1', 'street2', 'city', 'state', 'zip', 'phone']) if (b.shipFrom[f] != null && String(b.shipFrom[f]).trim()) a[f] = clean(b.shipFrom[f], 80);
    for (const f of ['street1', 'city', 'state', 'zip']) if (!a[f]) throw err(400, 'The ship-from address needs ' + ({ street1: 'a street', zip: 'a ZIP code' }[f] || 'a ' + f) + '.');
    if (!/^\d{5}(-\d{4})?$/.test(a.zip)) throw err(400, 'The ZIP code looks wrong.');
    if (!/^[A-Za-z]{2}$/.test(a.state)) throw err(400, 'Use the two-letter state code, like MO.');
    a.state = a.state.toUpperCase(); if (!a.name) a.name = d.name;
    d.shipFrom = a;
  }
  await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  await refreshListings(env, d);
  return d;
}
function publicDealer(d) {
  if (!d) return null;
  return { id: d.id, name: d.name, email: d.email, payouts: !!d.payoutsReady, hasShipFrom: !!(d.shipFrom && d.shipFrom.zip),
    shipFrom: d.shipFrom ? { city: d.shipFrom.city, state: d.shipFrom.state, zip: d.shipFrom.zip, street1: d.shipFrom.street1, street2: d.shipFrom.street2 || '', phone: d.shipFrom.phone || '' } : null };
}

// ---------- photos ----------
async function savePhoto(env, d, request) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw err(400, 'Send the photo as a JPEG.');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) throw err(400, 'The photo was empty.');
  if (buf.byteLength > MAX_PHOTO) throw err(413, 'That photo is too big. The app shrinks photos first; try again.');
  const key = d.id + '-' + rand(12);
  await env.TABELLA.put('img:' + key, buf, { metadata: { type, dealer: d.id } });
  return { key, url: '/img/' + key };
}
async function image(env, key, cors) {
  if (!env.TABELLA || !/^d[a-z0-9]{10}-[a-z0-9]{12}$/.test(key)) return new Response('Not found', { status: 404 });
  const r = await env.TABELLA.getWithMetadata('img:' + key, { type: 'arrayBuffer' });
  if (!r || !r.value) return new Response('Not found', { status: 404 });
  return new Response(r.value, { headers: Object.assign({ 'content-type': (r.metadata && r.metadata.type) || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable' }, cors) });
}

// ---------- items ----------
async function listItems(env, dealerId) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'item:' + dealerId + ':', cursor });
    const vals = await Promise.all(l.keys.map(k => env.TABELLA.get(k.name)));
    vals.forEach(v => { if (v) out.push(JSON.parse(v)); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out.sort((a, b) => b.created - a.created);
}
async function saveItem(env, d, id, b) {
  let it;
  if (id) {
    it = JSON.parse(await env.TABELLA.get('item:' + d.id + ':' + id) || 'null');
    if (!it) throw err(404, 'That item isn’t in your shop.');
    if (it.status === 'sold' && b.status !== 'available') {
      // A sold item can still have its notes corrected, but not be relisted by accident.
      const allowed = { notes: b.notes };
      b = allowed;
    }
  } else {
    it = { id: await newItemId(env), dealer: d.id, created: Date.now(), status: 'available', photos: [] };
  }
  if (b.title != null) it.title = clean(b.title, 120);
  if (!it.title) throw err(400, 'Add a short description, like "Fenton hobnail bowl".');
  if (b.category != null) it.category = CATEGORIES.includes(b.category) ? b.category : 'Other';
  if (b.price !== undefined) it.price = money(b.price, 'List price');
  if (b.paid !== undefined) it.paid = money(b.paid, 'What you paid');
  if (b.weightLb !== undefined) { const w = b.weightLb === '' || b.weightLb == null ? null : Number(b.weightLb); if (w != null && !(w > 0 && w <= 150)) throw err(400, 'Packed weight should be between 0.1 and 150 pounds.'); it.weightLb = w; }
  if (b.box !== undefined) { const bx = Array.isArray(b.box) ? b.box.map(Number) : null; if (bx && !(bx.length === 3 && bx.every(v => v > 0 && v <= 108))) throw err(400, 'Box size needs three measurements in inches.'); it.box = bx; }
  if (b.online !== undefined) it.online = !!b.online;
  if (b.notes !== undefined) it.notes = clean(b.notes, 500);
  if (b.status !== undefined && ['available', 'sold', 'hold'].includes(b.status)) it.status = b.status;
  if (Array.isArray(b.photos)) {
    const ph = b.photos.filter(k => typeof k === 'string' && k.startsWith(d.id + '-')).slice(0, 6);
    if (!ph.length && !it.photos.length) throw err(400, 'Add a photo.');
    if (ph.length) it.photos = ph;
  }
  if (!it.photos.length) throw err(400, 'Add a photo.');
  it.updated = Date.now();
  await env.TABELLA.put('item:' + d.id + ':' + it.id, JSON.stringify(it));
  await env.TABELLA.put('itemix:' + it.id, d.id);
  await listing(env, d, it);
  return it;
}
async function newItemId(env) {
  for (let i = 0; i < 6; i++) { const id = 'T' + rand(6, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); if (!(await env.TABELLA.get('itemix:' + id))) return id; }
  throw err(500, 'Could not make an item number. Try again.');
}
// Keep the public shop listing in step with the item.
async function listing(env, d, it) {
  const show = it.online && it.status === 'available' && it.price > 0 && it.photos.length;
  if (!show) { await env.TABELLA.delete('pub:' + it.id); return; }
  const ships = !!(it.weightLb && it.box && d.payoutsReady && d.shipFrom && d.shipFrom.zip);
  await env.TABELLA.put('pub:' + it.id, '', { metadata: { t: it.title.slice(0, 120), p: it.price, c: it.category || 'Other', d: d.id, n: d.name.slice(0, 60), ph: it.photos[0], s: ships ? 1 : 0 } });
}
async function refreshListings(env, d) { for (const it of await listItems(env, d.id)) await listing(env, d, it); }

// Used by the shop: all listed dealer items, from listing metadata alone.
export async function dealerListings(env) {
  if (!env.TABELLA) return [];
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'pub:', cursor });
    l.keys.forEach(k => { const m = k.metadata || {}; out.push({ id: k.name.slice(4), title: m.t, price: m.p, category: m.c, dealer: m.d, dealerName: m.n, photo: '/img/' + m.ph, shippable: !!m.s }); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
// Used by checkout: the full item and its dealer, checked server-side.
export async function dealerItem(env, id) {
  if (!env.TABELLA || !/^T[0-9A-Z]{6}$/.test(id)) return null;
  const did = await env.TABELLA.get('itemix:' + id); if (!did) return null;
  const [it, d] = await Promise.all([env.TABELLA.get('item:' + did + ':' + id), env.TABELLA.get('dealer:' + did)]);
  return it && d ? { item: JSON.parse(it), dealer: JSON.parse(d) } : null;
}
export async function markDealerItemSold(env, id, ref) {
  const x = await dealerItem(env, id); if (!x) return;
  x.item.status = 'sold'; x.item.soldAt = Date.now(); x.item.order = ref;
  await env.TABELLA.put('item:' + x.dealer.id + ':' + id, JSON.stringify(x.item));
  await env.TABELLA.delete('pub:' + id);
}

// ---------- payouts (Stripe Connect) ----------
async function payouts(env, d, url, b) {
  if (!d.stripeAccount) {
    const a = await createRecipient(env, { email: d.email, name: d.name, role: 'dealer', dealerId: d.id });
    d.stripeAccount = a.id;
    await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  }
  const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
  const link = await recipientLink(env, d.stripeAccount, site + '/dealer/?payouts=back', url.origin);
  return { url: link.url };
}
async function payoutStatus(env, d) {
  if (!d.stripeAccount) return { ready: false, started: false };
  const ready = await recipientReady(env, d.stripeAccount);
  if (ready !== !!d.payoutsReady) { d.payoutsReady = ready; await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d)); await refreshListings(env, d); }
  return { ready, started: true };
}

// ---------- helpers ----------
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function rand(n, abc) { abc = abc || 'abcdefghijklmnopqrstuvwxyz0123456789'; const b = crypto.getRandomValues(new Uint8Array(n)); let s = ''; for (const x of b) s += abc[x % abc.length]; return s; }
function cleanEmail(e) { e = String(e || '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 120 ? e : ''; }
function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function money(v, label) { if (v === '' || v == null) return null; const n = Math.round(Number(v) * 100) / 100; if (!isFinite(n) || n < 0 || n > 50000) throw err(400, label + ' looks wrong.'); return n; }
function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
async function body(request) { try { return await request.json(); } catch (e) { return {}; } }
