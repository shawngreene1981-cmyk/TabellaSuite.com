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

import { createRecipient, recipientLink, recipientReady, stripeMode } from './stripe.js';
import { sendEmail, resetEmail, shippedEmail } from './mail.js';
import { sendWaiting } from './mall.js';

const SESSION_TTL = 60 * 60 * 24 * 30;
export const ITEM_ID = /^(T[0-9A-Z]{6}|SH-\d{4})$/;
const MAX_PHOTO = 1.5 * 1024 * 1024;
const CATEGORIES = ['Decor', 'Furniture', 'Glassware', 'Seasonal', 'Lighting', 'Art', 'Kitchen', 'Jewelry', 'Toys', 'Books', 'Other'];

export async function handleApp(request, env, url, json, cors, shippo) {
  const p = url.pathname;
  if (p.startsWith('/img/') && request.method === 'GET') return image(env, p.slice(5), cors);
  if (!p.startsWith('/app/')) return null;
  if (!env.TABELLA) return json({ error: 'The TABELLA store is not set up yet.' }, 500, cors);
  try {
    if (p === '/app/signup' && request.method === 'POST') return json(await signup(env, await body(request)), 200, cors);
    if (p === '/app/login' && request.method === 'POST') return json(await login(env, await body(request)), 200, cors);

    if (p === '/app/forgot' && request.method === 'POST') return json(await forgot(env, await body(request)), 200, cors);
    if (p === '/app/reset' && request.method === 'POST') return json(await resetPw(env, await body(request)), 200, cors);

    const me = await session(env, request);
    if (!me) return json({ error: 'Please sign in again.', signin: true }, 401, cors);

    if (p === '/app/logout' && request.method === 'POST') { await env.TABELLA.delete('sess:' + me.token); return json({ ok: true }, 200, cors); }
    if (p === '/app/me' && request.method === 'GET') return json({ dealer: publicDealer(me.dealer), categories: CATEGORIES }, 200, cors);
    if (p === '/app/me' && request.method === 'PUT') return json({ dealer: publicDealer(await updateDealer(env, me.dealer, await body(request))) }, 200, cors);
    if (p === '/app/account' && request.method === 'PUT') return json({ dealer: publicDealer(await updateAccount(env, me.dealer, await body(request))) }, 200, cors);
    if (p === '/app/photo' && request.method === 'POST') return json(await savePhoto(env, me.dealer, request), 200, cors);
    if (p === '/app/items' && request.method === 'GET') return json({ items: await listItems(env, me.dealer.id) }, 200, cors);
    if (p === '/app/items' && request.method === 'POST') return json({ item: await saveItem(env, me.dealer, null, await body(request)) }, 200, cors);
    if (p === '/app/import' && request.method === 'GET') return json(await importStatus(env, me.dealer), 200, cors);
    if (p === '/app/import' && request.method === 'POST') return json(await importBatch(env, me.dealer), 200, cors);
    if (p === '/app/export.csv' && request.method === 'GET') return exportCsv(env, me.dealer, cors);
    const mo = p.match(/^\/app\/items\/(T[0-9A-Z]{6}|SH-\d{4})\/order$/);
    if (mo && request.method === 'GET') return json(await itemOrder(env, me.dealer, mo[1]), 200, cors);
    const ml = p.match(/^\/app\/items\/(T[0-9A-Z]{6}|SH-\d{4})\/label$/);
    if (ml && request.method === 'POST') return json(await buyLabel(env, me.dealer, ml[1], shippo), 200, cors);
    const m = p.match(/^\/app\/items\/(T[0-9A-Z]{6}|SH-\d{4})$/);
    if (m && request.method === 'PUT') return json({ item: await saveItem(env, me.dealer, m[1], await body(request)) }, 200, cors);
    if (p === '/app/scan' && request.method === 'POST') return json(await scan(env, me.dealer, await body(request)), 200, cors);
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
  if (u.kind === 'mall') throw err(400, 'That is a mall account. Sign in at tabellasuite.com/mall/');
  const dealer = JSON.parse(await env.TABELLA.get('dealer:' + u.id) || 'null');
  return { token: await newSession(env, u.id), dealer: publicDealer(dealer) };
}
// Forgot password: always answers the same way, so it never reveals whether an email has an account.
async function forgot(env, b) {
  const email = cleanEmail(b.email);
  if (!email) throw err(400, 'Enter the email you sign in with.');
  const n = Number(await env.TABELLA.get('rlf:' + email) || 0);
  const known = n < 3 ? JSON.parse(await env.TABELLA.get('user:' + email) || 'null') : null;
  if (known) {
    await env.TABELLA.put('rlf:' + email, String(n + 1), { expirationTtl: 3600 });
    const t = rand(40);
    await env.TABELLA.put('rst:' + t, email, { expirationTtl: 3600 });
    const link = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '') + (known.kind === 'mall' ? '/mall/' : '/dealer/') + '?reset=' + t;
    const r = await sendEmail(env, Object.assign({ to: email }, resetEmail(link)));
    if (r.skipped) throw err(503, 'Password reset emails aren\u2019t switched on yet. Write to contact@tabellasuite.com.');
  }
  return { ok: true };
}
async function resetPw(env, b) {
  const t = String(b.token || ''), pw = String(b.password || '');
  if (!/^[a-z0-9]{40}$/.test(t)) throw err(400, 'That reset link isn\u2019t valid. Ask for a new one.');
  if (pw.length < 8) throw err(400, 'Use a password of at least 8 characters.');
  const email = await env.TABELLA.get('rst:' + t);
  if (!email) throw err(400, 'That reset link has expired or was already used. Ask for a new one.');
  const u = JSON.parse(await env.TABELLA.get('user:' + email) || 'null');
  if (!u) throw err(400, 'That account no longer exists.');
  u.salt = rand(16); u.hash = await hashPw(pw, u.salt);
  await env.TABELLA.put('user:' + email, JSON.stringify(u));
  await env.TABELLA.delete('rst:' + t); await env.TABELLA.delete('rl:' + email);
  if (u.kind === 'mall') return { token: await newSession(env, u.id), kind: 'mall' };
  const dealer = JSON.parse(await env.TABELLA.get('dealer:' + u.id) || 'null');
  return { token: await newSession(env, u.id), dealer: publicDealer(dealer) };
}
// The order behind a sold item, so the dealer knows where to ship it.
async function itemOrder(env, d, id) {
  const it = JSON.parse(await env.TABELLA.get('item:' + d.id + ':' + id) || 'null');
  if (!it) throw err(404, 'That item isn\u2019t in your shop.');
  if (!it.order || !env.ORDERS) return { order: null };
  const o = JSON.parse(await env.ORDERS.get('order:' + it.order) || 'null');
  if (!o) return { order: null };
  return { order: { ref: o.ref, paidAt: o.paidAt, shipTo: o.shipTo, shipping: o.shipping, label: o.label || null,
    pickup: o.pickup ? { name: o.pickup.name, booth: o.pickup.booth, pickedUpAt: o.pickup.pickedUpAt || null, buyer: o.shipTo && o.shipTo.name } : null, items: o.items.map(i => ({ id: i.id, title: i.title, price: i.price })) } };
}
// Buy the shipping label for a paid order. Uses the rate the buyer paid for; if Shippo has expired it,
// gets fresh rates for the same boxes and picks the same service (or the closest match, cheapest first).
async function buyLabel(env, d, id, shippo) {
  if (!env.ORDERS) throw err(500, 'The ORDERS store is not set up.');
  const it = JSON.parse(await env.TABELLA.get('item:' + d.id + ':' + id) || 'null');
  if (!it) throw err(404, 'That item isn\u2019t in your shop.');
  if (!it.order) throw err(400, 'This item doesn\u2019t have an online order to ship.');
  const key = 'order:' + it.order, o = JSON.parse(await env.ORDERS.get(key) || 'null');
  if (!o || o.status !== 'paid') throw err(400, 'That order isn\u2019t paid yet.');
  if (o.pickup) throw err(400, 'This order is a pickup at ' + o.pickup.name + '. Nothing to ship.');
  if (o.label && o.label.url) return { label: o.label, already: true };
  if (!d.shipFrom || !d.shipFrom.zip) throw err(400, 'Add your ship-from address first.');
  const lock = 'lbl:' + o.ref;
  if (await env.ORDERS.get(lock)) throw err(409, 'A label is already being made for this order. Wait a moment and reload.');
  await env.ORDERS.put(lock, '1', { expirationTtl: 120 });
  try {
    const from = Object.assign({ country: 'US', name: d.name, email: d.email }, d.shipFrom);
    const to = Object.assign({ email: o.email }, o.shipTo);
    let rateId = o.shipping && o.shipping.rateId, tx = null;
    const buy = async rid => shippo('/transactions/', 'POST', { rate: rid, label_file_type: 'PDF_4x6', async: false, metadata: 'Tabella ' + o.ref });
    if (rateId) { try { tx = await buy(rateId); } catch (e) { tx = null; } if (tx && tx.status !== 'SUCCESS') tx = null; }
    if (!tx) {
      // Fresh quote for the same items and boxes.
      const parcels = [];
      for (const i of o.items) {
        const rec = JSON.parse(await env.TABELLA.get('item:' + d.id + ':' + i.id) || 'null');
        if (!rec || !rec.weightLb || !rec.box) throw err(400, (i.title || i.id) + ' is missing its packed weight or box size.');
        parcels.push({ length: String(rec.box[0]), width: String(rec.box[1]), height: String(rec.box[2]), distance_unit: 'in', weight: String(rec.weightLb), mass_unit: 'lb' });
      }
      const sh = await shippo('/shipments/', 'POST', { address_from: from, address_to: to, parcels, async: false });
      const rates = (sh.rates || []).filter(r => isFinite(Number(r.amount))).sort((a, b) => Number(a.amount) - Number(b.amount));
      if (!rates.length) throw err(502, 'Shippo returned no rates for this address. ' + ((sh.messages || []).map(m => m.text).join(' ') || ''));
      const want = o.shipping || {};
      const pick = rates.find(r => want.token && r.servicelevel && r.servicelevel.token === want.token) ||
        rates.find(r => r.provider === want.carrier && r.servicelevel && r.servicelevel.name === want.service) ||
        rates.find(r => r.provider === want.carrier) || rates[0];
      tx = await buy(pick.object_id);
      if (tx.status !== 'SUCCESS') throw err(502, 'Shippo couldn\u2019t make the label: ' + ((tx.messages || []).map(m => m.text).join(' ') || tx.status) + (/phone/i.test(JSON.stringify(tx.messages || '')) ? ' Add a phone number to your ship-from address.' : ''));
      rateId = pick.object_id;
    }
    const rate = (tx.rate && typeof tx.rate === 'object') ? tx.rate : null;
    o.label = { url: tx.label_url, tracking: tx.tracking_number, trackingUrl: tx.tracking_url_provider, carrier: (rate && rate.provider) || (o.shipping && o.shipping.carrier),
      service: (rate && rate.servicelevel && rate.servicelevel.name) || (o.shipping && o.shipping.service), transaction: tx.object_id, rateId, at: Date.now() };
    o.test = o.test != null ? o.test : String(env.SHIPPO_API_KEY || '').startsWith('shippo_test_');
    await env.ORDERS.put(key, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 400 });
    for (const i of o.items) {
      const rec = JSON.parse(await env.TABELLA.get('item:' + d.id + ':' + i.id) || 'null');
      if (rec) { rec.shippedAt = Date.now(); rec.tracking = o.label.tracking; await env.TABELLA.put('item:' + d.id + ':' + i.id, JSON.stringify(rec)); }
    }
    if (o.email) { o.emails = Object.assign({}, o.emails, { shipped: await sendEmail(env, Object.assign({ to: o.email }, shippedEmail(o, d.name))) }); await env.ORDERS.put(key, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 400 }); }
    return { label: o.label };
  } finally { await env.ORDERS.delete(lock); }
}
// Change the sign-in email and/or password. Always needs the current password.
async function updateAccount(env, d, b) {
  const u = JSON.parse(await env.TABELLA.get('user:' + d.email) || 'null');
  if (!u || u.id !== d.id) throw err(500, 'Your account record could not be found.');
  if ((await hashPw(String(b.password || ''), u.salt)) !== u.hash) throw err(401, 'Your current password isn\u2019t right.');
  if (b.newPassword) {
    const np = String(b.newPassword);
    if (np.length < 8) throw err(400, 'Use a new password of at least 8 characters.');
    u.salt = rand(16); u.hash = await hashPw(np, u.salt);
  }
  let email = d.email;
  if (b.newEmail != null && String(b.newEmail).trim()) {
    const ne = cleanEmail(b.newEmail);
    if (!ne) throw err(400, 'Enter a valid new email.');
    if (ne !== d.email) {
      if (await env.TABELLA.get('user:' + ne)) throw err(409, 'Another account already uses that email.');
      email = ne;
    }
  }
  u.email = email;
  await env.TABELLA.put('user:' + email, JSON.stringify(u));
  if (email !== d.email) { await env.TABELLA.delete('user:' + d.email); d.email = email; await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d)); }
  return d;
}
export async function newSession(env, id) { const t = rand(40); await env.TABELLA.put('sess:' + t, id, { expirationTtl: SESSION_TTL }); return t; }
export async function session(env, request) {
  const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-z0-9]{40}$/.test(t)) return null;
  const id = await env.TABELLA.get('sess:' + t);
  if (!id) return null;
  const dealer = JSON.parse(await env.TABELLA.get('dealer:' + id) || 'null');
  if (dealer) await payoutMode(env, dealer);
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
    const digits = String(a.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (digits.length !== 10) throw err(400, 'Add a 10-digit phone number. UPS and FedEx print it on every label.');
    a.phone = digits.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    d.shipFrom = a;
  }
  await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  await refreshListings(env, d);
  return d;
}
function publicDealer(d) {
  if (!d) return null;
  return { id: d.id, name: d.name, email: d.email, payouts: !!d.payoutsReady, hasShipFrom: !!(d.shipFrom && d.shipFrom.zip),
    mall: d.mall ? { name: d.mall.name, booth: d.mall.booth } : null,
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
  // How shoppers can buy it online: shipped, picked up at the dealer's mall, or either. Big pieces are often pickup only.
  if (b.how !== undefined) it.how = ['ship', 'pickup', 'both'].includes(b.how) ? b.how : 'both';
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
export async function listing(env, d, it) {
  const show = it.online && it.status === 'available' && it.price > 0 && it.photos.length;
  if (!show) { await env.TABELLA.delete('pub:' + it.id); return; }
  const w = await ways(env, d, it);
  const md = { t: it.title.slice(0, 120), p: it.price, c: it.category || 'Other', d: d.id, n: d.name.slice(0, 60), ph: it.photos[0], s: w.ships ? 1 : 0 };
  if (w.pickup) Object.assign(md, { k: w.pickup.mall, mn: w.pickup.name.slice(0, 60), mc: w.pickup.city.slice(0, 40), bo: String(w.pickup.booth).slice(0, 12) });
  await env.TABELLA.put('pub:' + it.id, '', { metadata: md });
}
// Whether a piece can ship, be picked up at the dealer's mall, or both, right now.
// Pickup needs the dealer to be in a Tabella mall that has entered its street address, and payouts set up.
export async function ways(env, d, it) {
  const how = it.how || 'both';
  const ships = how !== 'pickup' && !!(it.weightLb && it.box && payoutsOk(env, d) && d.shipFrom && d.shipFrom.zip);
  let pickup = null;
  if (how !== 'ship' && d.mall && d.mall.id && payoutsOk(env, d)) {
    const m = JSON.parse(await env.TABELLA.get('mall:' + d.mall.id) || 'null');
    if (m && m.address && m.address.street1) pickup = { mall: m.id, name: m.name, city: m.address.city + ', ' + m.address.state, booth: d.mall.booth, address: m.address, email: m.email };
  }
  return { how, ships, pickup };
}
export async function refreshListings(env, d) { for (const it of await listItems(env, d.id)) await listing(env, d, it); }

// Used by the shop: all listed dealer items, from listing metadata alone.
export async function dealerListings(env) {
  if (!env.TABELLA) return [];
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'pub:', cursor });
    l.keys.forEach(k => { const m = k.metadata || {}; out.push({ id: k.name.slice(4), title: m.t, price: m.p, category: m.c, dealer: m.d, dealerName: m.n, photo: '/img/' + m.ph, shippable: !!m.s,
      pickup: m.k ? { mall: m.k, name: m.mn, city: m.mc, booth: m.bo } : null }); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
// Used by checkout: the full item and its dealer, checked server-side.
export async function dealerItem(env, id) {
  if (!env.TABELLA || !ITEM_ID.test(id)) return null;
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
// A refunded order puts the piece back on sale (only if it is still marked sold to that order).
export async function markDealerItemAvailable(env, id, ref) {
  const x = await dealerItem(env, id); if (!x || x.item.status !== 'sold' || (ref && x.item.order !== ref)) return;
  x.item.status = 'available'; delete x.item.soldAt; delete x.item.order; delete x.item.shippedAt; delete x.item.tracking;
  x.item.notes = ((x.item.notes || '') + ' Refunded ' + new Date().toISOString().slice(0, 10) + ' (order ' + ref + ').').trim().slice(0, 600);
  await env.TABELLA.put('item:' + x.dealer.id + ':' + id, JSON.stringify(x.item));
  await listing(env, x.dealer, x.item);
}

// ---------- one-time move of Shantiques' items into the app ----------
// Reads the published list (tabellasuite.com/shop/import/shantiques.json) and its photos, in batches so each
// request stays under the Worker's limit on outside fetches. Only a shop named Shantiques can run it, and only once.
const IMPORT_URL = 'https://tabellasuite.com/shop/import/shantiques.json', IMPORT_BATCH = 12;
async function importStatus(env, d) {
  const owner = await env.TABELLA.get('import:shantiques');
  const done = !!(await env.TABELLA.get('import:shantiques:done'));
  return { available: d.name.trim().toLowerCase() === 'shantiques' && (!owner || owner === d.id) && !done, done: done && owner === d.id };
}
async function importBatch(env, d) {
  const st = await importStatus(env, d);
  if (!st.available) throw err(403, st.done ? 'Your Shantiques items are already in the app.' : 'This import is only for the Shantiques shop.');
  await env.TABELLA.put('import:shantiques', d.id);
  const r = await fetch(IMPORT_URL, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw err(502, 'The Shantiques item list could not be loaded. Try again.');
  const list = (await r.json()).items || [];
  let added = 0, skipped = 0, left = 0;
  for (const s of list) {
    if (!ITEM_ID.test(s.id)) { skipped++; continue; }
    if (await env.TABELLA.get('itemix:' + s.id)) continue;
    if (added >= IMPORT_BATCH) { left++; continue; }
    const img = await fetch('https://tabellasuite.com/shop/img/' + s.id + '.jpg');
    if (!img.ok) { skipped++; continue; }
    const key = d.id + '-' + rand(12);
    await env.TABELLA.put('img:' + key, await img.arrayBuffer(), { metadata: { type: 'image/jpeg', dealer: d.id } });
    const it = { id: s.id, dealer: d.id, created: Date.now(), updated: Date.now(), status: 'available', photos: [key],
      title: clean(s.title, 120) || s.id, category: CATEGORIES.includes(s.category) ? s.category : 'Other',
      price: s.price > 0 ? Math.round(s.price * 100) / 100 : null, paid: null, online: !!s.online, notes: 'Moved from the Shantiques sheet',
      weightLb: s.weightLb > 0 ? s.weightLb : null, box: Array.isArray(s.box) && s.box.length === 3 ? s.box.map(Number) : null };
    await env.TABELLA.put('item:' + d.id + ':' + it.id, JSON.stringify(it));
    await env.TABELLA.put('itemix:' + it.id, d.id);
    await listing(env, d, it);
    added++;
  }
  if (!left) await env.TABELLA.put('import:shantiques:done', d.id);
  return { added, left, skipped, done: !left };
}
export async function shantiquesMoved(env) { return env.TABELLA ? { started: !!(await env.TABELLA.get('import:shantiques')), done: !!(await env.TABELLA.get('import:shantiques:done')) } : { started: false, done: false }; }

// ---------- spreadsheet export ----------
async function exportCsv(env, d, cors) {
  const rows = [['Item ID', 'Description', 'Category', 'What you paid', 'Price', 'Status', 'Listed online', 'Packed weight (lb)', 'Box (in)', 'Sold', 'Notes']];
  for (const it of (await listItems(env, d.id)).reverse()) rows.push([it.id, it.title, it.category || '', it.paid == null ? '' : it.paid, it.price == null ? '' : it.price, it.status,
    it.online ? 'Yes' : 'No', it.weightLb || '', it.box ? it.box.join(' x ') : '', it.soldAt ? new Date(it.soldAt).toISOString().slice(0, 10) : '', it.notes || '']);
  const csv = rows.map(r => r.map(v => { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
  return new Response(csv, { headers: Object.assign({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + d.name.replace(/[^A-Za-z0-9]+/g, '-') + '-items.csv"' }, cors) });
}

// ---------- price scanner (Claude, through Tabella's own API key) ----------
//   ANTHROPIC_API_KEY  secret, required. SCAN_MODEL optional. SCANS_PER_DAY optional (default 40 per dealer).
async function scan(env, d, b) {
  if (!env.ANTHROPIC_API_KEY) throw err(503, 'The price scanner isn\u2019t switched on yet.');
  const key = String(b.photo || '');
  if (!key.startsWith(d.id + '-')) throw err(400, 'Add a photo first.');
  const day = new Date().toISOString().slice(0, 10), ck = 'scan:' + d.id + ':' + day;
  const used = Number(await env.TABELLA.get(ck) || 0), cap = Number(env.SCANS_PER_DAY || 40);
  if (used >= cap) throw err(429, 'You\u2019ve used today\u2019s ' + cap + ' scans. They reset tomorrow.');
  const img = await env.TABELLA.getWithMetadata('img:' + key, { type: 'arrayBuffer' });
  if (!img || !img.value) throw err(404, 'That photo wasn\u2019t found. Choose it again.');
  const bytes = new Uint8Array(img.value); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const size = clean(b.size, 80);
  const prompt = 'You help a vintage and antique dealer price an item for resale online. Look at the photo' + (size ? ' (the dealer says it is about ' + size + ')' : '') + '.\n' +
    'Reply with JSON only, no other text: {"title": short listing title naming maker and pattern if you can tell, under 80 characters, ' +
    '"category": one of ' + JSON.stringify(CATEGORIES) + ', "low": number, "high": number, "suggested": number (a realistic asking price in US dollars for a one-off online sale, ' +
    'typically near the middle of the range), "why": one short sentence on what drives the value, "check": one short thing to verify, such as a maker\u2019s mark, damage or a reproduction tell}. ' +
    'Be conservative. If you cannot tell what it is, say so in "why" and give a wide range.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: env.SCAN_MODEL || 'claude-sonnet-5-5', max_tokens: 400,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: (img.metadata && img.metadata.type) || 'image/jpeg', data: btoa(bin) } }, { type: 'text', text: prompt }] }] })
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw err(502, 'The scanner had a problem: ' + ((out.error && out.error.message) || res.status));
  await env.TABELLA.put(ck, String(used + 1), { expirationTtl: 60 * 60 * 30 });
  const txt = ((out.content || []).find(c => c.type === 'text') || {}).text || '';
  let r; try { r = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { throw err(502, 'The scanner\u2019s answer couldn\u2019t be read. Try again.'); }
  const n = v => (isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
  return { title: clean(r.title, 120), category: CATEGORIES.includes(r.category) ? r.category : 'Other', low: n(r.low), high: n(r.high), suggested: n(r.suggested), why: clean(r.why, 240), check: clean(r.check, 240), left: cap - used - 1 };
}

// ---------- payouts (Stripe Connect) ----------
// A payout account belongs to one Stripe mode. When Tabella switches from the sandbox to live (or back), the old
// account is set aside so the dealer connects a real bank and nobody is paid to a test account.
export function payoutsOk(env, d) { return !!(d && d.payoutsReady && d.stripeAccount && (d.stripeMode || 'test') === stripeMode(env)); }
async function payoutMode(env, d) {
  if (!d.stripeAccount || (d.stripeMode || 'test') === stripeMode(env)) return;
  d.oldAccounts = (d.oldAccounts || []).concat([{ id: d.stripeAccount, mode: d.stripeMode || 'test', until: Date.now() }]).slice(-5);
  delete d.stripeAccount; d.payoutsReady = false; delete d.stripeMode;
  await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  await refreshListings(env, d);
}
async function payouts(env, d, url, b) {
  if (!d.stripeAccount) {
    const a = await createRecipient(env, { email: d.email, name: d.name, role: 'dealer', dealerId: d.id });
    d.stripeAccount = a.id; d.stripeMode = stripeMode(env);
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
  // Card sales from a mall register that waited for this dealer's bank are paid now.
  const waiting = ready ? await sendWaiting(env, d.id) : null;
  return { ready, started: true, waiting };
}

// ---------- helpers ----------
export async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function rand(n, abc) { abc = abc || 'abcdefghijklmnopqrstuvwxyz0123456789'; const b = crypto.getRandomValues(new Uint8Array(n)); let s = ''; for (const x of b) s += abc[x % abc.length]; return s; }
export function cleanEmail(e) { e = String(e || '').trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 120 ? e : ''; }
export function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function money(v, label) { if (v === '' || v == null) return null; const n = Math.round(Number(v) * 100) / 100; if (!isFinite(n) || n < 0 || n > 50000) throw err(400, label + ' looks wrong.'); return n; }
export function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
export async function body(request) { try { return await request.json(); } catch (e) { return {}; } }
