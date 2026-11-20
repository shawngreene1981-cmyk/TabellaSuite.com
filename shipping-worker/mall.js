// Tabella for malls: mall accounts, dealer booths, the register (cash, or card on a Stripe reader) and the day report.
//
// Storage (TABELLA KV):
//   user:<email>                        sign-in record with kind "mall" (shares the dealer login table, so an email is one or the other)
//   mall:<id>                           mall profile and settings. The street address is private: it is only used for the card reader.
//   mallcode:<code>                     join code -> mall id. Dealers type it in the dealer app to put their booth in the mall.
//   booth:<mall>:<dealer>               a dealer's booth in the mall { booth, pct (commission override or null), joined }
//   msale:<mall>:<yyyymmdd>:<sale>      one register sale (money in cents)
//   msaleix:<sale>                      sale -> its msale key
//
// Money, per item, for in-store sales (the mall's own terms, set in its settings):
//   mall commission  = price x commission % (per booth override allowed)
//   card fee         = price x card fee %, card sales only (what the mall charges dealers for card sales)
//   dealer is owed   = price - commission - card fee
//   Sales tax is the mall's local rate on the subtotal. The mall files it under its own license.
// Cash stays in the mall's drawer, so the mall owes dealers their share (the day report lists it).
// Card money lands with Tabella: each dealer's share is paid straight to their payout account, and the mall gets
// its commission, the card fees and the tax, less Stripe's in-person processing fee. Tabella keeps nothing from
// in-store sales; malls pay Tabella by the booth.

import { session as dealerSession, hashPw, rand, cleanEmail, clean, err, body, newSession, dealerItem, listing, payoutsOk, ITEM_ID } from './app.js';
import { stripeApi, stripeMode, createRecipient, recipientLink, recipientReady } from './stripe.js';
import { sendEmail } from './mail.js';

const SESSION_TTL = 60 * 60 * 24 * 30;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STRIPE_IN_PERSON_PCT = 0.027, STRIPE_IN_PERSON_FIXED = 5; // US card-present rate, cents
const HOLD_SECONDS = 600;
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];

export async function handleMall(request, env, url, json, cors) {
  const p = url.pathname;
  if (!p.startsWith('/mall/') && !p.startsWith('/app/mall')) return null;
  if (!env.TABELLA) return json({ error: 'The TABELLA store is not set up yet.' }, 500, cors);
  try {
    // Dealer side: join or leave a mall from the dealer app.
    if (p.startsWith('/app/mall')) {
      const me = await dealerSession(env, request);
      if (!me) return json({ error: 'Please sign in again.', signin: true }, 401, cors);
      if (p === '/app/mall/join' && request.method === 'POST') return json(await joinMall(env, me.dealer, await body(request)), 200, cors);
      if (p === '/app/mall/leave' && request.method === 'POST') return json(await leaveMall(env, me.dealer), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    }

    if (p === '/mall/signup' && request.method === 'POST') return json(await signup(env, await body(request)), 200, cors);
    if (p === '/mall/login' && request.method === 'POST') return json(await login(env, await body(request)), 200, cors);

    const m = await mallSession(env, request);
    if (!m) return json({ error: 'Please sign in again.', signin: true }, 401, cors);

    if (p === '/mall/logout' && request.method === 'POST') { await env.TABELLA.delete('sess:' + m.token); return json({ ok: true }, 200, cors); }
    if (p === '/mall/me' && request.method === 'GET') return json({ mall: publicMall(env, m.mall) }, 200, cors);
    if (p === '/mall/me' && request.method === 'PUT') return json({ mall: publicMall(env, await updateMall(env, m.mall, await body(request))) }, 200, cors);
    if (p === '/mall/dealers' && request.method === 'GET') return json({ dealers: await listDealers(env, m.mall) }, 200, cors);
    const md = p.match(/^\/mall\/dealers\/(d[a-z0-9]{10})$/);
    if (md && request.method === 'PUT') return json(await setBooth(env, m.mall, md[1], await body(request)), 200, cors);
    if (md && request.method === 'DELETE') return json(await removeDealer(env, m.mall, md[1]), 200, cors);
    if (p === '/mall/item' && request.method === 'GET') return json({ item: await lookup(env, m.mall, url.searchParams.get('code')) }, 200, cors);
    if (p === '/mall/sale' && request.method === 'POST') return json({ sale: await startSale(env, m.mall, await body(request)) }, 200, cors);
    const ms = p.match(/^\/mall\/sale\/(S[0-9A-Z]{8,16})(\/[a-z-]+)?$/);
    if (ms && request.method === 'GET' && !ms[2]) return json({ sale: await checkSale(env, m.mall, ms[1]) }, 200, cors);
    if (ms && request.method === 'POST' && ms[2] === '/test-card') return json({ sale: await testCard(env, m.mall, ms[1], await body(request)) }, 200, cors);
    if (ms && request.method === 'POST' && ms[2] === '/retry') return json({ sale: await retrySale(env, m.mall, ms[1]) }, 200, cors);
    if (ms && request.method === 'POST' && ms[2] === '/cancel') return json({ sale: await cancelSale(env, m.mall, ms[1]) }, 200, cors);
    if (ms && request.method === 'POST' && ms[2] === '/refund') return json({ sale: await refundSale(env, m.mall, ms[1]) }, 200, cors);
    if (p === '/mall/report' && request.method === 'GET') return json(await report(env, m.mall, url.searchParams.get('day')), 200, cors);
    if (p === '/mall/report.csv' && request.method === 'GET') return reportCsv(env, m.mall, url.searchParams.get('day'), cors);
    if (p === '/mall/reader' && request.method === 'POST') return json({ mall: publicMall(env, await setupReader(env, m.mall, await body(request))) }, 200, cors);
    if (p === '/mall/payouts' && request.method === 'POST') return json(await payouts(env, m.mall, url), 200, cors);
    if (p === '/mall/payouts' && request.method === 'GET') return json(await payoutStatus(env, m.mall), 200, cors);
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

// ---------- accounts ----------
async function signup(env, b) {
  const email = cleanEmail(b.email), name = clean(b.name, 60), pw = String(b.password || '');
  const city = clean(b.city, 40), state = clean(b.state, 2).toUpperCase();
  if (!email) throw err(400, 'Enter a valid email.');
  if (!name) throw err(400, 'Enter the mall’s name.');
  if (!city || !/^[A-Z]{2}$/.test(state)) throw err(400, 'Enter the city and the two-letter state, like MO.');
  if (pw.length < 8) throw err(400, 'Use a password of at least 8 characters.');
  if (await env.TABELLA.get('user:' + email)) throw err(409, 'There is already an account for that email. Sign in instead, or use a different email for the mall.');
  const id = 'm' + rand(10), salt = rand(16);
  const mall = { id, email, name, city, state, commissionPct: 10, cardFeePct: 3, taxRate: null, tz: 'America/Chicago', code: await newCode(env, id), created: Date.now() };
  await env.TABELLA.put('user:' + email, JSON.stringify({ id, kind: 'mall', email, salt, hash: await hashPw(pw, salt), created: Date.now() }));
  await env.TABELLA.put('mall:' + id, JSON.stringify(mall));
  return { token: await newSession(env, id), mall: publicMall(env, mall) };
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
  if (u.kind !== 'mall') throw err(400, 'That is a dealer account. Sign in at tabellasuite.com/dealer/');
  const mall = JSON.parse(await env.TABELLA.get('mall:' + u.id) || 'null');
  return { token: await newSession(env, u.id), mall: publicMall(env, mall) };
}
async function mallSession(env, request) {
  const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-z0-9]{40}$/.test(t)) return null;
  const id = await env.TABELLA.get('sess:' + t);
  if (!id || id[0] !== 'm') return null;
  const mall = JSON.parse(await env.TABELLA.get('mall:' + id) || 'null');
  return mall ? { token: t, mall } : null;
}
async function newCode(env, id) {
  for (let i = 0; i < 8; i++) { const c = rand(6, CODE_ABC); if (!(await env.TABELLA.get('mallcode:' + c))) { await env.TABELLA.put('mallcode:' + c, id); return c; } }
  throw err(500, 'Could not make a join code. Try again.');
}
function mallPayoutsOk(env, m) { return !!(m.payoutsReady && m.stripeAccount && (m.stripeMode || 'test') === stripeMode(env)); }
function readerFor(env, m) { const t = m.terminal; return t && t.mode === stripeMode(env) && t.reader ? t : null; }
function publicMall(env, m) {
  if (!m) return null;
  const r = readerFor(env, m);
  return { id: m.id, name: m.name, email: m.email, city: m.city, state: m.state, commissionPct: m.commissionPct, cardFeePct: m.cardFeePct, taxRate: m.taxRate,
    tz: m.tz, code: m.code, address: m.address || null, payouts: mallPayoutsOk(env, m), reader: r ? { label: r.label, simulated: !!r.simulated } : null,
    mode: stripeMode(env), live: stripeMode(env) === 'live' && String(env.ALLOW_LIVE_PAYMENTS).toLowerCase() === 'true' };
}
async function updateMall(env, m, b) {
  if (b.name != null) { const n = clean(b.name, 60); if (!n) throw err(400, 'Enter the mall’s name.'); m.name = n; }
  if (b.city != null) { const c = clean(b.city, 40); if (c) m.city = c; }
  if (b.state != null) { const s = clean(b.state, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(s)) throw err(400, 'Use the two-letter state code, like MO.'); m.state = s; }
  if (b.commissionPct !== undefined) m.commissionPct = pct(b.commissionPct, 'Commission', 0, 60);
  if (b.cardFeePct !== undefined) m.cardFeePct = pct(b.cardFeePct, 'Card fee', 0, 10);
  if (b.taxRate !== undefined) m.taxRate = b.taxRate === '' || b.taxRate == null ? null : pct(b.taxRate, 'Sales tax rate', 0, 15, 3);
  if (b.tz != null) { if (!ZONES.includes(b.tz)) throw err(400, 'Pick a time zone from the list.'); m.tz = b.tz; }
  if (b.address) {
    const a = {};
    for (const f of ['street1', 'street2', 'city', 'state', 'zip']) if (b.address[f] != null && String(b.address[f]).trim()) a[f] = clean(b.address[f], 80);
    if (!a.street1 || !a.city || !a.state || !a.zip) throw err(400, 'The mall address needs a street, city, state and ZIP.');
    if (!/^\d{5}(-\d{4})?$/.test(a.zip)) throw err(400, 'The ZIP code looks wrong.');
    a.state = a.state.toUpperCase(); if (!/^[A-Z]{2}$/.test(a.state)) throw err(400, 'Use the two-letter state code, like MO.');
    if (JSON.stringify(a) !== JSON.stringify(m.address || {})) { m.address = a; if (m.terminal) m.terminal.locationStale = true; }
  }
  const renamed = b.name != null;
  await env.TABELLA.put('mall:' + m.id, JSON.stringify(m));
  if (renamed) for (const bt of await boothList(env, m.id)) {
    const d = JSON.parse(await env.TABELLA.get('dealer:' + bt.dealer) || 'null');
    if (d && d.mall && d.mall.id === m.id && d.mall.name !== m.name) { d.mall.name = m.name; await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d)); }
  }
  return m;
}
function pct(v, label, lo, hi, dp) {
  const n = Number(v), f = Math.pow(10, dp || 2);
  if (v === '' || v == null || !isFinite(n) || n < lo || n > hi) throw err(400, label + ' should be between ' + lo + '% and ' + hi + '%.');
  return Math.round(n * f) / f;
}

// ---------- dealers and booths ----------
async function joinMall(env, d, b) {
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const booth = clean(b.booth, 20);
  if (!code) throw err(400, 'Enter the join code your mall gave you.');
  if (!booth) throw err(400, 'Enter your booth number.');
  const mid = await env.TABELLA.get('mallcode:' + code);
  if (!mid) throw err(404, 'That join code didn’t match a mall. Check it with the mall office.');
  if (d.mall && d.mall.id !== mid) throw err(409, 'Your shop is already in ' + d.mall.name + '. Leave that mall first.');
  const m = JSON.parse(await env.TABELLA.get('mall:' + mid) || 'null');
  if (!m) throw err(404, 'That mall no longer exists.');
  const prev = JSON.parse(await env.TABELLA.get('booth:' + mid + ':' + d.id) || 'null');
  await env.TABELLA.put('booth:' + mid + ':' + d.id, JSON.stringify({ booth, pct: prev ? prev.pct : null, joined: prev ? prev.joined : Date.now() }));
  d.mall = { id: mid, name: m.name, booth };
  await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  return { mall: { name: m.name, booth } };
}
async function leaveMall(env, d) {
  if (!d.mall) return { mall: null };
  await env.TABELLA.delete('booth:' + d.mall.id + ':' + d.id);
  delete d.mall;
  await env.TABELLA.put('dealer:' + d.id, JSON.stringify(d));
  return { mall: null };
}
async function boothList(env, mid) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'booth:' + mid + ':', cursor });
    const vals = await Promise.all(l.keys.map(k => env.TABELLA.get(k.name)));
    l.keys.forEach((k, i) => { if (vals[i]) out.push(Object.assign({ dealer: k.name.split(':')[2] }, JSON.parse(vals[i]))); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
async function listDealers(env, m) {
  const booths = await boothList(env, m.id);
  const ds = await Promise.all(booths.map(b => env.TABELLA.get('dealer:' + b.dealer)));
  return booths.map((b, i) => { const d = ds[i] ? JSON.parse(ds[i]) : null;
    return { id: b.dealer, name: d ? d.name : '(removed account)', booth: b.booth, pct: b.pct, payouts: d ? payoutsOk(env, d) : false, joined: b.joined }; })
    .sort((a, b) => String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true }));
}
async function setBooth(env, m, did, b) {
  const key = 'booth:' + m.id + ':' + did, bt = JSON.parse(await env.TABELLA.get(key) || 'null');
  if (!bt) throw err(404, 'That dealer isn’t in your mall.');
  if (b.booth != null) { const v = clean(b.booth, 20); if (!v) throw err(400, 'Enter a booth number.'); bt.booth = v; }
  if (b.pct !== undefined) bt.pct = b.pct === '' || b.pct == null ? null : pct(b.pct, 'Commission', 0, 60);
  await env.TABELLA.put(key, JSON.stringify(bt));
  const d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
  if (d && d.mall && d.mall.id === m.id && d.mall.booth !== bt.booth) { d.mall.booth = bt.booth; await env.TABELLA.put('dealer:' + did, JSON.stringify(d)); }
  return { ok: true };
}
async function removeDealer(env, m, did) {
  await env.TABELLA.delete('booth:' + m.id + ':' + did);
  const d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
  if (d && d.mall && d.mall.id === m.id) { delete d.mall; await env.TABELLA.put('dealer:' + did, JSON.stringify(d)); }
  return { ok: true };
}

// ---------- the register ----------
// A Tabella tag's QR code reads "SQ1|BOOTH|ITEM-ID|PRICE|CATEGORY|RARITY"; the item number alone works too.
export function tagItemId(raw) {
  let s = String(raw || '').trim();
  if (s.includes('|')) s = (s.split('|')[2] || '');
  s = s.toUpperCase().replace(/\s+/g, '');
  return ITEM_ID.test(s) ? s : null;
}
async function lookup(env, m, raw) {
  const id = tagItemId(raw);
  if (!id) throw err(400, 'That isn’t a Tabella item number. They look like T7K2M9Q or SH-0012.');
  const x = await dealerItem(env, id);
  if (!x) throw err(404, id + ' isn’t in Tabella. Check the number on the tag.');
  const bt = JSON.parse(await env.TABELLA.get('booth:' + m.id + ':' + x.dealer.id) || 'null');
  if (!bt) throw err(403, id + ' belongs to ' + x.dealer.name + ', who hasn’t joined your mall in Tabella yet. Give them your join code.');
  const it = x.item;
  if (it.status === 'sold' || (env.ORDERS && await env.ORDERS.get('sold:' + id))) throw err(409, it.title + ' (' + id + ') is already marked sold.');
  if (it.status === 'hold') throw err(409, it.title + ' is on hold by the dealer.');
  if (!(it.price > 0)) throw err(400, it.title + ' has no price in Tabella. Ask the dealer to add one.');
  const held = env.ORDERS ? await env.ORDERS.get('hold:' + id) : null;
  if (held) throw err(409, it.title + ' is in another checkout right now (online or at a register). Try again in a few minutes.');
  return { id, title: it.title, price: it.price, dealer: x.dealer.id, dealerName: x.dealer.name, booth: bt.booth, photo: it.photos && it.photos[0] ? '/img/' + it.photos[0] : null };
}
function dayOf(m, t) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: m.tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }
  catch (e) { return new Date(t - 6 * 3600e3).toISOString().slice(0, 10); }
}
// Price everything for a sale. All money in cents.
async function priceSale(env, m, ids, method) {
  if (!Array.isArray(ids) || !ids.length) throw err(400, 'Scan at least one item.');
  if (ids.length > 50) throw err(400, 'That’s more than 50 items. Ring them up in two sales.');
  const uniq = [...new Set(ids.map(tagItemId))];
  if (uniq.some(x => !x)) throw err(400, 'One of the item numbers isn’t valid.');
  const items = [];
  for (const id of uniq) {
    const it = await lookup(env, m, id);
    const bt = JSON.parse(await env.TABELLA.get('booth:' + m.id + ':' + it.dealer) || 'null');
    const rate = bt && bt.pct != null ? bt.pct : (m.commissionPct || 0);
    const cents = Math.round(it.price * 100);
    const commission = Math.round(cents * rate / 100);
    const cardFee = method === 'card' ? Math.round(cents * (m.cardFeePct || 0) / 100) : 0;
    items.push({ id: it.id, title: it.title, price: cents, dealer: it.dealer, dealerName: it.dealerName, booth: it.booth, rate, commission, cardFee, owed: cents - commission - cardFee });
  }
  const subtotal = items.reduce((a, i) => a + i.price, 0);
  const taxRate = m.taxRate || 0, tax = Math.round(subtotal * taxRate / 100);
  return { items, subtotal, taxRate, tax, total: subtotal + tax };
}
async function saveSale(env, s) {
  await env.TABELLA.put(s.key, JSON.stringify(s));
}
async function getSale(env, m, id) {
  const key = await env.TABELLA.get('msaleix:' + id);
  if (!key || !key.startsWith('msale:' + m.id + ':')) throw err(404, 'That sale wasn’t found.');
  const s = JSON.parse(await env.TABELLA.get(key) || 'null');
  if (!s) throw err(404, 'That sale wasn’t found.');
  return s;
}
function publicSale(s) {
  const o = Object.assign({}, s); delete o.key; return o;
}
async function startSale(env, m, b) {
  const method = b.method === 'card' ? 'card' : b.method === 'cash' ? 'cash' : null;
  if (!method) throw err(400, 'Choose cash or card.');
  const priced = await priceSale(env, m, b.items, method);
  const at = Date.now(), id = 'S' + at.toString(36).toUpperCase() + rand(3, CODE_ABC), day = dayOf(m, at);
  const s = Object.assign({ id, mall: m.id, mallName: m.name, day, at, method, status: 'pending', test: stripeMode(env) !== 'live' },
    priced, { key: 'msale:' + m.id + ':' + day.replace(/-/g, '') + ':' + id });

  if (method === 'cash') {
    const given = Math.round(Number(b.cashGiven) * 100);
    if (!isFinite(given) || given < s.total) throw err(400, 'The cash given is less than the total of $' + (s.total / 100).toFixed(2) + '.');
    s.cashGiven = given; s.change = given - s.total; s.test = false;
    await env.TABELLA.put('msaleix:' + id, s.key);
    await finish(env, m, s);
    return publicSale(s);
  }

  // Card: send the total to the mall's Stripe reader.
  if (stripeMode(env) === 'missing') throw err(503, 'Card payments aren’t set up yet.');
  if (stripeMode(env) === 'live' && String(env.ALLOW_LIVE_PAYMENTS).toLowerCase() !== 'true') throw err(403, 'Tabella isn’t open for real card payments yet. Use cash, or wait for go-live.');
  const r = readerFor(env, m);
  if (!r) throw err(400, 'Set up your card reader first (Settings).');
  if (s.total < 50) throw err(400, 'Card sales need to be at least $0.50.');
  if (env.ORDERS) {
    for (const it of s.items) { const h = await env.ORDERS.get('hold:' + it.id); if (h && h !== id) throw err(409, it.title + ' is in another checkout right now.'); }
    await Promise.all(s.items.map(it => env.ORDERS.put('hold:' + it.id, id, { expirationTtl: HOLD_SECONDS })));
  }
  try {
    const pi = await stripeApi(env, 'POST', '/payment_intents', {
      amount: String(s.total), currency: 'usd', 'payment_method_types[]': 'card_present', capture_method: 'automatic',
      transfer_group: 'mall_' + id, description: 'In-store sale at ' + m.name,
      'metadata[sale]': id, 'metadata[mall]': m.id
    }, 'pi-' + id);
    s.pi = pi.id;
    await env.TABELLA.put('msaleix:' + id, s.key);
    await saveSale(env, s);
    await stripeApi(env, 'POST', '/terminal/readers/' + r.reader + '/process_payment_intent', { payment_intent: pi.id });
  } catch (e) {
    await releaseHolds(env, s);
    if (s.pi) { s.status = 'failed'; s.message = e.message; await saveSale(env, s); }
    throw err(502, readerProblem(e.message));
  }
  return publicSale(s);
}
function readerProblem(msg) {
  msg = String(msg || '');
  if (/busy|in progress/i.test(msg)) return 'The card reader is busy with another payment. Cancel that one on the reader, then try again.';
  if (/offline|unreachable|not connected/i.test(msg)) return 'The card reader is offline. Check that it is on and connected to Wi-Fi.';
  return 'The card reader had a problem: ' + msg;
}
// Polled by the register while the customer pays.
async function checkSale(env, m, id) {
  const s = await getSale(env, m, id);
  if (s.method !== 'card' || s.status !== 'pending') return publicSale(s);
  const pi = await stripeApi(env, 'GET', '/payment_intents/' + s.pi);
  if (pi.status === 'succeeded') { s.charge = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id; await finish(env, m, s); return publicSale(s); }
  if (pi.status === 'canceled') { s.status = 'cancelled'; await releaseHolds(env, s); await saveSale(env, s); return publicSale(s); }
  const r = readerFor(env, m);
  if (r) {
    const rd = await stripeApi(env, 'GET', '/terminal/readers/' + r.reader).catch(() => null);
    const a = rd && rd.action;
    if (a && a.status === 'failed' && a.process_payment_intent && a.process_payment_intent.payment_intent === s.pi) {
      return Object.assign(publicSale(s), { readerFailed: a.failure_message || 'The card was declined.' });
    }
  }
  return publicSale(s);
}
// Test mode only: tap Stripe's test card on the simulated reader. decline:true uses a card that is declined.
async function testCard(env, m, id, b) {
  if (stripeMode(env) !== 'test') throw err(403, 'Test cards only work in test mode.');
  const s = await getSale(env, m, id), r = readerFor(env, m);
  if (!r || !r.simulated) throw err(400, 'Test cards need the simulated reader.');
  if (s.status !== 'pending') return publicSale(s);
  await stripeApi(env, 'POST', '/test_helpers/terminal/readers/' + r.reader + '/present_payment_method',
    b && b.decline ? { type: 'card_present', 'card_present[number]': '4000000000000002' } : { type: 'card_present' });
  return checkSale(env, m, id);
}
async function retrySale(env, m, id) {
  const s = await getSale(env, m, id), r = readerFor(env, m);
  if (s.status !== 'pending' || !r) return publicSale(s);
  if (env.ORDERS) await Promise.all(s.items.map(it => env.ORDERS.put('hold:' + it.id, id, { expirationTtl: HOLD_SECONDS })));
  try { await stripeApi(env, 'POST', '/terminal/readers/' + r.reader + '/process_payment_intent', { payment_intent: s.pi }); }
  catch (e) { throw err(502, readerProblem(e.message)); }
  return publicSale(s);
}
async function cancelSale(env, m, id) {
  const s = await getSale(env, m, id);
  if (s.status !== 'pending') return publicSale(s);
  const r = readerFor(env, m);
  if (r) await stripeApi(env, 'POST', '/terminal/readers/' + r.reader + '/cancel_action', {}).catch(() => null);
  if (s.pi) {
    const pi = await stripeApi(env, 'GET', '/payment_intents/' + s.pi);
    if (pi.status === 'succeeded') { s.charge = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge && pi.latest_charge.id; await finish(env, m, s); return publicSale(s); }
    if (pi.status !== 'canceled') await stripeApi(env, 'POST', '/payment_intents/' + s.pi + '/cancel', {}).catch(() => null);
  }
  s.status = 'cancelled'; await releaseHolds(env, s); await saveSale(env, s);
  return publicSale(s);
}
async function releaseHolds(env, s) {
  if (!env.ORDERS) return;
  await Promise.all(s.items.map(async it => { if ((await env.ORDERS.get('hold:' + it.id)) === s.id) await env.ORDERS.delete('hold:' + it.id); }));
}

// Payment is in: mark every item sold everywhere (in the dealer app and off the online shop), then pay out card money.
async function finish(env, m, s) {
  if (s.status === 'paid') return;
  for (const it of s.items) {
    if (env.ORDERS) { await env.ORDERS.put('sold:' + it.id, s.id); if ((await env.ORDERS.get('hold:' + it.id)) === s.id) await env.ORDERS.delete('hold:' + it.id); }
    const x = await dealerItem(env, it.id);
    if (x) {
      x.item.status = 'sold'; x.item.soldAt = s.at; delete x.item.order;
      x.item.store = { mall: m.name, sale: s.id, method: s.method, price: it.price / 100, owed: it.owed / 100 };
      await env.TABELLA.put('item:' + x.dealer.id + ':' + it.id, JSON.stringify(x.item));
      await env.TABELLA.delete('pub:' + it.id);
    }
  }
  s.status = 'paid'; s.paidAt = Date.now();
  if (s.method === 'card') await payOut(env, m, s);
  await saveSale(env, s);
}
async function payOut(env, m, s) {
  s.stripeFee = Math.round(s.total * STRIPE_IN_PERSON_PCT) + STRIPE_IN_PERSON_FIXED;
  const byDealer = {};
  for (const it of s.items) byDealer[it.dealer] = (byDealer[it.dealer] || 0) + it.owed;
  s.payouts = {};
  for (const did of Object.keys(byDealer)) {
    const amt = byDealer[did], d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
    if (amt <= 0) { s.payouts[did] = { amount: amt, status: 'none' }; continue; }
    if (!s.charge || !d || !payoutsOk(env, d)) { s.payouts[did] = { amount: amt, status: 'waiting', why: 'Dealer hasn’t connected a bank for payouts' }; continue; }
    try {
      const t = await stripeApi(env, 'POST', '/transfers', { amount: String(amt), currency: 'usd', destination: d.stripeAccount, transfer_group: 'mall_' + s.id,
        source_transaction: s.charge, 'metadata[role]': 'dealer', 'metadata[sale]': s.id }, s.id + '-d-' + did);
      s.payouts[did] = { amount: amt, status: 'sent', transfer: t.id };
    } catch (e) { s.payouts[did] = { amount: amt, status: 'waiting', why: String(e.message).slice(0, 160) }; }
  }
  const mallAmt = s.items.reduce((a, i) => a + i.commission + i.cardFee, 0) + s.tax - s.stripeFee;
  if (mallAmt <= 0) s.mallPayout = { amount: mallAmt, status: 'none' };
  else if (!s.charge || !mallPayoutsOk(env, m)) s.mallPayout = { amount: mallAmt, status: 'waiting', why: 'Connect the mall’s bank in Settings' };
  else {
    try {
      const t = await stripeApi(env, 'POST', '/transfers', { amount: String(mallAmt), currency: 'usd', destination: m.stripeAccount, transfer_group: 'mall_' + s.id,
        source_transaction: s.charge, 'metadata[role]': 'mall', 'metadata[sale]': s.id }, s.id + '-m');
      s.mallPayout = { amount: mallAmt, status: 'sent', transfer: t.id };
    } catch (e) { s.mallPayout = { amount: mallAmt, status: 'waiting', why: String(e.message).slice(0, 160) }; }
  }
}

// ---------- refunds ----------
// Cash: the register marks the sale refunded and puts the items back on sale; the mall hands back the cash.
// Card: the register asks Stripe for the refund; when Stripe confirms (webhook), mallAfterRefund takes back the payouts' and relists.
async function refundSale(env, m, id) {
  const s = await getSale(env, m, id);
  if (s.status !== 'paid') throw err(400, 'Only a completed sale can be refunded.');
  if (s.method === 'cash') { await relist(env, s); s.status = 'refunded'; s.refundedAt = Date.now(); await saveSale(env, s); return publicSale(s); }
  if (!s.pi) throw err(400, 'This card sale has no payment to refund.');
  await stripeApi(env, 'POST', '/refunds', { payment_intent: s.pi, 'metadata[sale]': s.id }, 'refund-' + s.id);
  s.status = 'refunding'; await saveSale(env, s);
  return publicSale(s);
}
async function relist(env, s) {
  for (const it of s.items) {
    if (env.ORDERS && (await env.ORDERS.get('sold:' + it.id)) === s.id) await env.ORDERS.delete('sold:' + it.id);
    const x = await dealerItem(env, it.id);
    if (!x || x.item.status !== 'sold' || !x.item.store || x.item.store.sale !== s.id) continue;
    x.item.status = 'available'; delete x.item.soldAt; delete x.item.store;
    x.item.notes = ((x.item.notes || '') + ' Returned at ' + s.mallName + ' ' + new Date().toISOString().slice(0, 10) + ' (sale ' + s.id + ').').trim().slice(0, 600);
    await env.TABELLA.put('item:' + x.dealer.id + ':' + it.id, JSON.stringify(x.item));
    await listing(env, x.dealer, x.item);
  }
}
// Called from the Stripe webhook (stripe.js) when an in-store card payment is refunded. Payouts were already taken back there.
export async function mallAfterRefund(env, saleId, charge, full, out) {
  const key = saleId && await env.TABELLA.get('msaleix:' + saleId);
  const s = key ? JSON.parse(await env.TABELLA.get(key) || 'null') : null;
  if (s && full && s.status !== 'refunded') { await relist(env, s); s.status = 'refunded'; s.refundedAt = Date.now(); s.reversed = out.reversed; await env.TABELLA.put(key, JSON.stringify(s)); }
  const amt = '$' + ((charge.amount_refunded || 0) / 100).toFixed(2);
  const text = (full ? 'Full refund of ' + amt + ' on in-store sale ' + saleId + (s ? ' at ' + s.mallName : '') + '. Items back on sale; ' + out.reversed.length + ' payout(s) taken back.'
    : 'Partial refund of ' + amt + ' on in-store sale ' + saleId + '. Settle the dealer and mall shares by hand.') + (out.problems.length ? ' Needs a look: ' + out.problems.join('; ') : '');
  await sendEmail(env, { to: env.OPS_EMAIL || 'contact@tabellasuite.com', subject: (stripeMode(env) === 'test' ? '[Test] ' : '') + 'In-store refund: ' + saleId, html: '<p>' + text.replace(/[<>&]/g, '') + '</p>', text }).catch(() => null);
}

// ---------- day report ----------
async function salesOn(env, m, day) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'msale:' + m.id + ':' + day.replace(/-/g, '') + ':', cursor });
    const vals = await Promise.all(l.keys.map(k => env.TABELLA.get(k.name)));
    vals.forEach(v => { if (v) out.push(JSON.parse(v)); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out.sort((a, b) => a.at - b.at);
}
async function report(env, m, day) {
  day = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : dayOf(m, Date.now());
  const all = await salesOn(env, m, day), paid = all.filter(s => s.status === 'paid');
  const t = { sales: paid.length, items: 0, subtotal: 0, tax: 0, total: 0, cash: 0, card: 0, commission: 0, cardFees: 0, stripeFees: 0, mallOwesDealers: 0, paidToDealers: 0, waitingForDealers: 0 };
  const dealers = {};
  for (const s of paid) {
    t.items += s.items.length; t.subtotal += s.subtotal; t.tax += s.tax; t.total += s.total; t[s.method] += s.total; t.stripeFees += s.stripeFee || 0;
    for (const it of s.items) {
      const d = dealers[it.dealer] || (dealers[it.dealer] = { id: it.dealer, name: it.dealerName, booth: it.booth, items: 0, sales: 0, commission: 0, cardFees: 0, owed: 0, mallOwes: 0, paid: 0, waiting: 0 });
      d.items++; d.sales += it.price; d.commission += it.commission; d.cardFees += it.cardFee; d.owed += it.owed;
      t.commission += it.commission; t.cardFees += it.cardFee;
      if (s.method === 'cash') { d.mallOwes += it.owed; t.mallOwesDealers += it.owed; }
      else {
        const po = s.payouts && s.payouts[it.dealer];
        if (po && po.status === 'sent') { d.paid += it.owed; t.paidToDealers += it.owed; } else { d.waiting += it.owed; t.waitingForDealers += it.owed; }
      }
    }
  }
  t.mallKeeps = t.commission + t.cardFees;
  return { day, mall: m.name, totals: t, dealers: Object.values(dealers).sort((a, b) => String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true })),
    sales: all.map(publicSale) };
}
async function reportCsv(env, m, day, cors) {
  const r = await report(env, m, day), c = v => (v / 100).toFixed(2);
  const rows = [['Booth', 'Dealer', 'Items', 'Sales', 'Mall commission', 'Card fees', 'Dealer share', 'Mall owes dealer (cash)', 'Paid to dealer by Tabella (card)', 'Card payout waiting']];
  for (const d of r.dealers) rows.push([d.booth, d.name, d.items, c(d.sales), c(d.commission), c(d.cardFees), c(d.owed), c(d.mallOwes), c(d.paid), c(d.waiting)]);
  const t = r.totals;
  rows.push([], ['Totals', '', t.items, c(t.subtotal), c(t.commission), c(t.cardFees), c(t.subtotal - t.commission - t.cardFees), c(t.mallOwesDealers), c(t.paidToDealers), c(t.waitingForDealers)],
    ['Sales tax collected', c(t.tax)], ['Cash taken', c(t.cash)], ['Card taken', c(t.card)], ['Stripe in-person fees', c(t.stripeFees)]);
  const csv = rows.map(row => row.map(v => { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
  return new Response(csv, { headers: Object.assign({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + m.name.replace(/[^A-Za-z0-9]+/g, '-') + '-' + r.day + '.csv"' }, cors) });
}

// ---------- card reader (Stripe Terminal, server-driven) ----------
// Test mode: Stripe's simulated reader, so the whole checkout can be shown with no hardware and no real money.
// Live: the mall types the registration code shown on its Stripe reader (WisePOS E or S700).
async function setupReader(env, m, b) {
  const mode = stripeMode(env);
  if (mode === 'missing') throw err(503, 'Card payments aren’t set up yet.');
  if (!m.address) throw err(400, 'Add the mall’s street address first. Stripe needs it for the reader (it isn’t shown to anyone).');
  const t = m.terminal && m.terminal.mode === mode && !m.terminal.locationStale ? m.terminal : { mode };
  if (!t.location) {
    const a = m.address;
    const loc = await stripeApi(env, 'POST', '/terminal/locations', { display_name: clean(m.name, 100), 'address[line1]': a.street1, 'address[line2]': a.street2 || '',
      'address[city]': a.city, 'address[state]': a.state, 'address[postal_code]': a.zip, 'address[country]': 'US', 'metadata[mall]': m.id });
    t.location = loc.id; delete t.reader;
  }
  const simulated = mode === 'test' && !b.code;
  const code = simulated ? 'simulated-wpe' : clean(b.code, 60);
  if (!code) throw err(400, 'Enter the registration code shown on the reader.');
  if (t.reader) await stripeApi(env, 'DELETE', '/terminal/readers/' + t.reader).catch(() => null);
  const rd = await stripeApi(env, 'POST', '/terminal/readers', { registration_code: code, location: t.location, label: simulated ? 'Test reader' : clean(b.label || 'Front counter', 60), 'metadata[mall]': m.id });
  t.reader = rd.id; t.label = rd.label; t.simulated = simulated; t.mode = mode;
  m.terminal = t;
  await env.TABELLA.put('mall:' + m.id, JSON.stringify(m));
  return m;
}

// ---------- mall payouts ----------
async function payouts(env, m, url) {
  if (!m.stripeAccount || (m.stripeMode || 'test') !== stripeMode(env)) {
    const a = await createRecipient(env, { email: m.email, name: m.name, role: 'mall', dealerId: m.id });
    m.stripeAccount = a.id; m.stripeMode = stripeMode(env); m.payoutsReady = false;
    await env.TABELLA.put('mall:' + m.id, JSON.stringify(m));
  }
  const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
  const link = await recipientLink(env, m.stripeAccount, site + '/mall/?payouts=back', url.origin);
  return { url: link.url };
}
async function payoutStatus(env, m) {
  if (!m.stripeAccount || (m.stripeMode || 'test') !== stripeMode(env)) return { ready: false, started: false };
  const ready = await recipientReady(env, m.stripeAccount);
  if (ready !== !!m.payoutsReady) { m.payoutsReady = ready; await env.TABELLA.put('mall:' + m.id, JSON.stringify(m)); }
  return { ready, started: true };
}
