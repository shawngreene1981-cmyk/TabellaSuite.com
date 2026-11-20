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
import { sendEmail, emailFrame } from './mail.js';

const SESSION_TTL = 60 * 60 * 24 * 30;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STRIPE_IN_PERSON_PCT = 0.027, STRIPE_IN_PERSON_FIXED = 5; // US card-present rate, cents
const HOLD_SECONDS = 600;
const TERMINAL_API_VERSION = '2024-06-20';
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
    if (p === '/mall/dealers' && request.method === 'POST') return json(await addBooth(env, m.mall, await body(request)), 200, cors);
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
    if (p === '/mall/statements' && request.method === 'GET') return json(await statements(env, m.mall, url.searchParams.get('month')), 200, cors);
    if (p === '/mall/statements.csv' && request.method === 'GET') return statementsCsv(env, m.mall, url.searchParams.get('month'), cors);
    if (p === '/mall/statements/paid' && request.method === 'POST') return json(await markPaid(env, m.mall, await body(request)), 200, cors);
    if (p === '/mall/statements/send-all' && request.method === 'POST') return json(await sendAll(env, m.mall, await body(request)), 200, cors);
    if (p === '/mall/statements/auto' && request.method === 'PUT') return json({ mall: publicMall(env, await setAuto(env, m.mall, await body(request))) }, 200, cors);
    if (p === '/mall/statements/send' && request.method === 'POST') return json(await sendStatement(env, m.mall, await body(request)), 200, cors);
    if (p === '/mall/report' && request.method === 'GET') return json(await report(env, m.mall, url.searchParams.get('day')), 200, cors);
    if (p === '/mall/report.csv' && request.method === 'GET') return reportCsv(env, m.mall, url.searchParams.get('day'), cors);
    if (p === '/mall/reader' && request.method === 'POST') return json({ mall: publicMall(env, await setupReader(env, m.mall, await body(request))) }, 200, cors);
    if (p === '/mall/payouts' && request.method === 'POST') return json(await payouts(env, m.mall, url), 200, cors);
    if (p === '/mall/payouts/waiting' && request.method === 'POST') return json(await sendAllWaiting(env, m.mall), 200, cors);
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
    tz: m.tz, code: m.code, autoStatements: m.autoStatements || { on: false, day: 1 }, rentFromPayouts: !!m.rentFromPayouts, address: m.address || null, payouts: mallPayoutsOk(env, m), reader: r ? { label: r.label, simulated: !!r.simulated } : null,
    mode: stripeMode(env), live: stripeMode(env) === 'live' && String(env.ALLOW_LIVE_PAYMENTS).toLowerCase() === 'true' };
}
async function updateMall(env, m, b) {
  if (b.name != null) { const n = clean(b.name, 60); if (!n) throw err(400, 'Enter the mall’s name.'); m.name = n; }
  if (b.city != null) { const c = clean(b.city, 40); if (c) m.city = c; }
  if (b.state != null) { const s = clean(b.state, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(s)) throw err(400, 'Use the two-letter state code, like MO.'); m.state = s; }
  if (b.commissionPct !== undefined) m.commissionPct = pct(b.commissionPct, 'Commission', 0, 60);
  if (b.cardFeePct !== undefined) m.cardFeePct = pct(b.cardFeePct, 'Card fee', 0, 10);
  if (b.taxRate !== undefined) m.taxRate = b.taxRate === '' || b.taxRate == null ? null : pct(b.taxRate, 'Sales tax rate', 0, 15, 3);
  if (b.rentFromPayouts !== undefined) m.rentFromPayouts = !!b.rentFromPayouts;
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
    return { id: b.dealer, name: d ? d.name : '(removed account)', booth: b.booth, pct: b.pct, rent: b.rent || null, managed: !!(d && d.managed), email: d && d.managed ? d.email || '' : undefined, payouts: d ? payoutsOk(env, d) : false, joined: b.joined }; })
    .sort((a, b) => String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true }));
}
// A booth for a dealer who doesn't use Tabella. The mall keeps paying them as it does today; no sign-in, nothing online.
async function addBooth(env, m, b) {
  const booth = clean(b.booth, 20), name = clean(b.name, 60), email = b.email ? cleanEmail(b.email) : '';
  if (!booth) throw err(400, 'Enter the booth number.');
  if (!name) throw err(400, 'Enter the dealer\u2019s name.');
  if (b.email && !email) throw err(400, 'That email looks wrong. Leave it blank if you don\u2019t have one.');
  const id = 'd' + rand(10);
  await env.TABELLA.put('dealer:' + id, JSON.stringify({ id, name, email, managed: true, mall: { id: m.id, name: m.name, booth }, created: Date.now() }));
  await env.TABELLA.put('booth:' + m.id + ':' + id, JSON.stringify({ booth, pct: b.pct === '' || b.pct == null ? null : pct(b.pct, 'Commission', 0, 60), rent: money(b.rent, 'Rent'), joined: Date.now() }));
  return { ok: true, id };
}
async function setBooth(env, m, did, b) {
  const key = 'booth:' + m.id + ':' + did, bt = JSON.parse(await env.TABELLA.get(key) || 'null');
  if (!bt) throw err(404, 'That dealer isn’t in your mall.');
  if (b.booth != null) { const v = clean(b.booth, 20); if (!v) throw err(400, 'Enter a booth number.'); bt.booth = v; }
  if (b.pct !== undefined) bt.pct = b.pct === '' || b.pct == null ? null : pct(b.pct, 'Commission', 0, 60);
  if (b.rent !== undefined) bt.rent = money(b.rent, 'Rent');
  await env.TABELLA.put(key, JSON.stringify(bt));
  const d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
  if (d && d.managed && d.mall && d.mall.id === m.id && (b.name != null || b.email != null)) {
    if (b.name != null) { const n = clean(b.name, 60); if (!n) throw err(400, 'Enter the dealer\u2019s name.'); d.name = n; }
    if (b.email != null) { const e = b.email ? cleanEmail(b.email) : ''; if (b.email && !e) throw err(400, 'That email looks wrong.'); d.email = e; }
    await env.TABELLA.put('dealer:' + did, JSON.stringify(d));
  }
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
  const tagged = ids.filter(x => typeof x === 'string'), lines = ids.filter(x => x && typeof x === 'object');
  const uniq = [...new Set(tagged.map(tagItemId))];
  if (uniq.some(x => !x)) throw err(400, 'One of the item numbers isn’t valid.');
  const found = [];
  for (const id of uniq) found.push(await lookup(env, m, id));
  // Pieces rung up by booth and price (a paper tag, or a dealer who isn't on Tabella).
  for (const l of lines) {
    const did = String(l.dealer || ''), bt = /^d[a-z0-9]{10}$/.test(did) ? JSON.parse(await env.TABELLA.get('booth:' + m.id + ':' + did) || 'null') : null;
    if (!bt) throw err(400, 'Pick a booth from the list.');
    const price = Math.round(Number(l.price) * 100) / 100;
    if (!isFinite(price) || price <= 0 || price > 50000) throw err(400, 'Enter the price on the tag.');
    const d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
    found.push({ id: 'B' + rand(7, CODE_ABC), manual: true, title: clean(l.title, 80) || 'Booth ' + bt.booth + ' item', price, dealer: did, dealerName: d ? d.name : 'Booth ' + bt.booth, booth: bt.booth });
  }
  const items = [];
  for (const it of found) {
    const bt = JSON.parse(await env.TABELLA.get('booth:' + m.id + ':' + it.dealer) || 'null');
    const rate = bt && bt.pct != null ? bt.pct : (m.commissionPct || 0);
    const cents = Math.round(it.price * 100);
    const commission = Math.round(cents * rate / 100);
    const cardFee = method === 'card' ? Math.round(cents * (m.cardFeePct || 0) / 100) : 0;
    items.push({ id: it.id, manual: it.manual || undefined, title: it.title, price: cents, dealer: it.dealer, dealerName: it.dealerName, booth: it.booth, rate, commission, cardFee, owed: cents - commission - cardFee });
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
    const tagged = s.items.filter(it => !it.manual);
    for (const it of tagged) { const h = await env.ORDERS.get('hold:' + it.id); if (h && h !== id) throw err(409, it.title + ' is in another checkout right now.'); }
    await Promise.all(tagged.map(it => env.ORDERS.put('hold:' + it.id, id, { expirationTtl: HOLD_SECONDS })));
  }
  try {
    const pi = await stripeApi(env, 'POST', '/payment_intents', {
      // Card-reader payments name card_present directly. Stripe's newest API versions dropped that field, so this call
      // pins the last version that has it. Manual capture is Stripe's standard for readers: checkSale captures once approved.
      _version: TERMINAL_API_VERSION, amount: String(s.total), currency: 'usd', 'payment_method_types[]': 'card_present', capture_method: 'manual',
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
  let pi = await stripeApi(env, 'GET', '/payment_intents/' + s.pi);
  if (pi.status === 'requires_capture') pi = await stripeApi(env, 'POST', '/payment_intents/' + s.pi + '/capture', {}, 'cap-' + s.id);
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
  if (env.ORDERS) await Promise.all(s.items.filter(it => !it.manual).map(it => env.ORDERS.put('hold:' + it.id, id, { expirationTtl: HOLD_SECONDS })));
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
    let pi = await stripeApi(env, 'GET', '/payment_intents/' + s.pi);
    if (pi.status === 'requires_capture') pi = await stripeApi(env, 'POST', '/payment_intents/' + s.pi + '/capture', {}, 'cap-' + s.id);
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
    if (it.manual) continue;
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
// ---------- booth rent ----------
//   booth:<mall>:<dealer>.rent          monthly rent in cents (null = none)
//   mrent:<mall>:<yyyymm>:<dealer>      rent already taken from that month's card payouts, in cents
// With "take rent from card payouts" on, each card sale pays the booth's unpaid rent for the month before the dealer
// gets the rest. Whatever is still unpaid at month end comes off what the mall owes on the statement.
async function takeRent(env, m, s, did, amt) {
  if (!m.rentFromPayouts) return 0;
  const bt = JSON.parse(await env.TABELLA.get('booth:' + m.id + ':' + did) || 'null');
  if (!bt || !(bt.rent > 0)) return 0;
  const key = 'mrent:' + m.id + ':' + s.day.slice(0, 7).replace('-', '') + ':' + did, got = Number(await env.TABELLA.get(key)) || 0;
  const take = Math.max(0, Math.min(amt, bt.rent - got));
  if (take) await env.TABELLA.put(key, String(got + take), { expirationTtl: 60 * 60 * 24 * 800 });
  return take;
}
async function giveBackRent(env, s) {
  for (const did of Object.keys(s.payouts || {})) {
    const r = s.payouts[did].rent; if (!r) continue;
    const key = 'mrent:' + s.mall + ':' + s.day.slice(0, 7).replace('-', '') + ':' + did, got = Number(await env.TABELLA.get(key)) || 0;
    await env.TABELLA.put(key, String(Math.max(0, got - r)), { expirationTtl: 60 * 60 * 24 * 800 });
  }
}
function money(v, label) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(String(v).replace(/[$,]/g, '')) * 100);
  if (!isFinite(n) || n < 0 || n > 1000000) throw err(400, label + ' looks wrong.');
  return n || null;
}
async function payOut(env, m, s) {
  s.stripeFee = Math.round(s.total * STRIPE_IN_PERSON_PCT) + STRIPE_IN_PERSON_FIXED;
  const byDealer = {}; let mallExtra = 0;
  for (const it of s.items) byDealer[it.dealer] = (byDealer[it.dealer] || 0) + it.owed;
  s.payouts = {};
  for (const did of Object.keys(byDealer)) {
    const amt = byDealer[did], d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
    if (amt <= 0) { s.payouts[did] = { amount: amt, status: 'none' }; continue; }
    if (d && d.managed) { s.payouts[did] = { amount: amt, status: 'mall', why: 'The mall pays this booth' }; mallExtra += amt; continue; }
    // Booth rent: when the mall takes rent from card payouts, this month's unpaid rent comes off the dealer's share first.
    const take = await takeRent(env, m, s, did, amt), net = amt - take; mallExtra += take;
    const base = { share: amt, rent: take || undefined, amount: net };
    if (net <= 0) { s.payouts[did] = Object.assign(base, { status: 'sent', why: 'All of it went to booth rent' }); continue; }
    if (!s.charge || !d || !payoutsOk(env, d)) { s.payouts[did] = Object.assign(base, { status: 'waiting', why: 'Dealer hasn’t connected a bank for payouts' }); continue; }
    try {
      const t = await stripeApi(env, 'POST', '/transfers', { amount: String(net), currency: 'usd', destination: d.stripeAccount, transfer_group: 'mall_' + s.id,
        source_transaction: s.charge, 'metadata[role]': 'dealer', 'metadata[sale]': s.id }, s.id + '-d-' + did);
      s.payouts[did] = Object.assign(base, { status: 'sent', transfer: t.id });
    } catch (e) { s.payouts[did] = Object.assign(base, { status: 'waiting', why: String(e.message).slice(0, 160) }); }
  }
  const mallAmt = s.items.reduce((a, i) => a + i.commission + i.cardFee, 0) + s.tax - s.stripeFee + mallExtra;
  if (mallAmt <= 0) s.mallPayout = { amount: mallAmt, status: 'none' };
  else if (!s.charge || !mallPayoutsOk(env, m)) s.mallPayout = { amount: mallAmt, status: 'waiting', why: 'Connect the mall’s bank in Settings' };
  else {
    try {
      const t = await stripeApi(env, 'POST', '/transfers', { amount: String(mallAmt), currency: 'usd', destination: m.stripeAccount, transfer_group: 'mall_' + s.id,
        source_transaction: s.charge, 'metadata[role]': 'mall', 'metadata[sale]': s.id }, s.id + '-m');
      s.mallPayout = { amount: mallAmt, status: 'sent', transfer: t.id };
    } catch (e) { s.mallPayout = { amount: mallAmt, status: 'waiting', why: String(e.message).slice(0, 160) }; }
  }
  await noteWaiting(env, s);
}

// ---------- card money waiting for a bank ----------
//   mwait:<dealer or mall id>:<sale>   a card sale whose share for that dealer (or mall) hasn't been paid yet
// Sent as soon as that dealer or mall has a payout bank: when they finish Stripe's payout setup, and from the
// "Send waiting payouts" button on the mall's day report. A sale from the sandbox is never paid out in live mode.
async function noteWaiting(env, s) {
  for (const did of Object.keys(s.payouts || {})) if (s.payouts[did].status === 'waiting') await env.TABELLA.put('mwait:' + did + ':' + s.id, s.key);
  if (s.mallPayout && s.mallPayout.status === 'waiting') await env.TABELLA.put('mwait:' + s.mall + ':' + s.id, s.key);
}
export async function sendWaiting(env, ownerId) {
  const out = { sent: 0, amount: 0, left: 0, problems: [] };
  if (!env.TABELLA || !/^[dm][a-z0-9]{10}$/.test(String(ownerId || ''))) return out;
  const isMall = ownerId[0] === 'm';
  const owner = JSON.parse(await env.TABELLA.get((isMall ? 'mall:' : 'dealer:') + ownerId) || 'null');
  const ready = owner && (isMall ? mallPayoutsOk(env, owner) : payoutsOk(env, owner));
  const live = stripeMode(env) === 'live';
  let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'mwait:' + ownerId + ':', cursor });
    for (const k of l.keys) {
      const key = await env.TABELLA.get(k.name), s = key ? JSON.parse(await env.TABELLA.get(key) || 'null') : null;
      const po = s && (isMall ? s.mallPayout : s.payouts && s.payouts[ownerId]);
      if (!s || !po || po.status !== 'waiting' || s.status !== 'paid') { await env.TABELLA.delete(k.name); continue; }
      if (!ready || !s.charge || !!s.test === live) { out.left++; continue; }
      try {
        const t = await stripeApi(env, 'POST', '/transfers', { amount: String(po.amount), currency: 'usd', destination: owner.stripeAccount, transfer_group: 'mall_' + s.id,
          source_transaction: s.charge, 'metadata[role]': isMall ? 'mall' : 'dealer', 'metadata[sale]': s.id, 'metadata[late]': 'yes' }, s.id + '-' + ownerId + '-' + owner.stripeAccount);
        Object.assign(po, { status: 'sent', transfer: t.id, sentLate: Date.now() }); delete po.why;
        await env.TABELLA.put(key, JSON.stringify(s)); await env.TABELLA.delete(k.name);
        out.sent++; out.amount += po.amount;
      } catch (e) { po.why = String(e.message).slice(0, 160); await env.TABELLA.put(key, JSON.stringify(s)); out.left++; out.problems.push(s.id + ': ' + po.why); }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
// The mall's button: its own waiting money and every booth's.
async function sendAllWaiting(env, m) {
  const total = { sent: 0, amount: 0, left: 0, problems: [] };
  for (const id of [m.id].concat((await boothList(env, m.id)).map(b => b.dealer))) {
    const r = await sendWaiting(env, id);
    total.sent += r.sent; total.amount += r.amount; total.left += r.left; total.problems.push(...r.problems);
  }
  return total;
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
async function dropWaiting(env, s) { for (const id of Object.keys(s.payouts || {}).concat([s.mall])) await env.TABELLA.delete('mwait:' + id + ':' + s.id); }
async function relist(env, s) {
  for (const it of s.items) {
    if (it.manual) continue;
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
  if (s && full && s.status !== 'refunded') { await relist(env, s); await dropWaiting(env, s); await giveBackRent(env, s); s.status = 'refunded'; s.refundedAt = Date.now(); s.reversed = out.reversed; await env.TABELLA.put(key, JSON.stringify(s)); }
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
  const t = { sales: paid.length, items: 0, subtotal: 0, tax: 0, total: 0, cash: 0, card: 0, commission: 0, cardFees: 0, stripeFees: 0, mallOwesDealers: 0, paidToDealers: 0, waitingForDealers: 0, mallWaiting: 0 };
  const dealers = {};
  for (const s of paid) {
    if (s.mallPayout && s.mallPayout.status === 'waiting') t.mallWaiting += s.mallPayout.amount;
    t.items += s.items.length; t.subtotal += s.subtotal; t.tax += s.tax; t.total += s.total; t[s.method] += s.total; t.stripeFees += s.stripeFee || 0;
    for (const it of s.items) {
      const d = dealers[it.dealer] || (dealers[it.dealer] = { id: it.dealer, name: it.dealerName, booth: it.booth, items: 0, sales: 0, commission: 0, cardFees: 0, owed: 0, mallOwes: 0, paid: 0, waiting: 0 });
      d.items++; d.sales += it.price; d.commission += it.commission; d.cardFees += it.cardFee; d.owed += it.owed;
      t.commission += it.commission; t.cardFees += it.cardFee;
      if (s.method === 'cash') { d.mallOwes += it.owed; t.mallOwesDealers += it.owed; }
      else if (!(s.payouts || {})[it.dealer]) { d.waiting += it.owed; t.waitingForDealers += it.owed; }
    }
    if (s.method === 'card') for (const did of Object.keys(s.payouts || {})) {
      const po = s.payouts[did], d = dealers[did]; if (!d) continue;
      const r = po.rent || 0, a = po.amount;
      d.rent = (d.rent || 0) + r; t.rentTaken = (t.rentTaken || 0) + r;
      if (po.status === 'mall') { d.mallOwes += a; t.mallOwesDealers += a; }
      else if (po.status === 'sent') { d.paid += a; t.paidToDealers += a; }
      else if (po.status === 'waiting') { d.waiting += a; t.waitingForDealers += a; }
    }
  }
  t.rentTaken = t.rentTaken || 0;
  t.mallKeeps = t.commission + t.cardFees + t.rentTaken;
  return { day, mall: m.name, totals: t, dealers: Object.values(dealers).sort((a, b) => String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true })),
    sales: all.map(publicSale) };
}
async function reportCsv(env, m, day, cors) {
  const r = await report(env, m, day), c = v => (v / 100).toFixed(2);
  const rows = [['Booth', 'Dealer', 'Items', 'Sales', 'Mall commission', 'Card fees', 'Dealer share', 'Mall owes dealer', 'Paid to dealer by Tabella (card)', 'Card payout waiting']];
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
  const waiting = ready ? await sendWaiting(env, m.id) : null;
  return { ready, started: true, waiting };
}

// ---------- monthly dealer statements ----------
//   mpaid:<mall>:<yyyymm>:<dealer>   the mall's note that it paid a dealer for the month { at, amount, note }
// One statement per booth: every completed sale line for the month, the mall's commission and card fees, the dealer's
// share, and who pays it (the mall for cash sales and for booths it manages; Tabella straight to the dealer's bank for
// card sales of dealers on Tabella). Refunded sales are left out.
function monthOf(m, v) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? v : dayOf(m, Date.now()).slice(0, 7); }
async function statements(env, m, month) {
  month = monthOf(m, month);
  const all = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'msale:' + m.id + ':' + month.replace('-', ''), cursor });
    const vals = await Promise.all(l.keys.map(k => env.TABELLA.get(k.name)));
    vals.forEach(v => { if (v) all.push(JSON.parse(v)); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  const booths = await boothList(env, m.id), byId = {};
  for (const b of booths) {
    const d = JSON.parse(await env.TABELLA.get('dealer:' + b.dealer) || 'null');
    byId[b.dealer] = { id: b.dealer, name: d ? d.name : 'Booth ' + b.booth, email: d ? d.email || '' : '', managed: !!(d && d.managed), booth: b.booth, lines: [],
      sales: 0, commission: 0, cardFees: 0, share: 0, mallOwes: 0, paidByTabella: 0, waiting: 0, rent: b.rent || 0, rentTaken: 0 };
  }
  for (const s of all.filter(x => x.status === 'paid').sort((a, b) => a.at - b.at)) {
    for (const it of s.items) {
      const st = byId[it.dealer] || (byId[it.dealer] = { id: it.dealer, name: it.dealerName, email: '', managed: false, booth: it.booth, gone: true, lines: [], sales: 0, commission: 0, cardFees: 0, share: 0, mallOwes: 0, paidByTabella: 0, waiting: 0, rent: 0, rentTaken: 0 });
      const po = s.method === 'card' ? (s.payouts || {})[it.dealer] : null;
      const who = s.method === 'cash' || (po && po.status === 'mall') ? 'mall' : po && po.status === 'sent' ? 'tabella' : 'waiting';
      st.lines.push({ day: s.day, sale: s.id, item: it.manual ? '' : it.id, title: it.title, method: s.method, price: it.price, commission: it.commission, cardFee: it.cardFee, share: it.owed, who });
      st.sales += it.price; st.commission += it.commission; st.cardFees += it.cardFee; st.share += it.owed;
      if (s.method === 'cash') st.mallOwes += it.owed;
      else if (!po) st.waiting += it.owed;
    }
    // Card money is settled per sale and dealer: what went to the dealer's bank, what waits, and what went to rent.
    if (s.method === 'card') for (const did of Object.keys(s.payouts || {})) {
      const po = s.payouts[did], st = byId[did]; if (!st) continue;
      st.rentTaken += po.rent || 0;
      if (po.status === 'mall') st.mallOwes += po.amount; else if (po.status === 'sent') st.paidByTabella += po.amount; else if (po.status === 'waiting') st.waiting += po.amount;
    }
  }
  const list = Object.values(byId);
  // Rent still unpaid after card payouts comes off what the mall owes; if that isn't enough, the dealer owes the rest.
  for (const st of list) { const left = Math.max(0, st.rent - st.rentTaken); st.rentLeft = left; st.net = st.mallOwes - left; }
  await Promise.all(list.map(async st => { st.paid = JSON.parse(await env.TABELLA.get('mpaid:' + m.id + ':' + month.replace('-', '') + ':' + st.id) || 'null');
    st.sent = Number(await env.TABELLA.get('msent:' + m.id + ':' + month.replace('-', '') + ':' + st.id)) || null; }));
  list.sort((a, b) => String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true }));
  const tot = list.reduce((t, st) => { for (const k of ['sales', 'commission', 'cardFees', 'share', 'mallOwes', 'paidByTabella', 'waiting', 'rent', 'rentTaken']) t[k] += st[k];
    if (st.net > 0) t.netOwed += st.net; else t.rentDue += -st.net; return t; },
    { sales: 0, commission: 0, cardFees: 0, share: 0, mallOwes: 0, paidByTabella: 0, waiting: 0, rent: 0, rentTaken: 0, netOwed: 0, rentDue: 0 });
  return { month, mall: m.name, totals: tot, dealers: list };
}
async function markPaid(env, m, b) {
  const month = monthOf(m, b.month), did = String(b.dealer || '');
  if (!/^d[a-z0-9]{10}$/.test(did)) throw err(400, 'Pick a dealer.');
  const key = 'mpaid:' + m.id + ':' + month.replace('-', '') + ':' + did;
  if (b.undo) { await env.TABELLA.delete(key); return { paid: null }; }
  const amount = Math.round(Number(b.amount) * 100);
  if (!isFinite(amount) || amount < 0) throw err(400, 'The amount looks wrong.');
  const paid = { at: Date.now(), amount, note: clean(b.note, 80) };
  await env.TABELLA.put(key, JSON.stringify(paid));
  return { paid };
}
async function sendStatement(env, m, b) {
  const r = await statements(env, m, b.month), st = r.dealers.find(x => x.id === b.dealer);
  if (!st) throw err(404, 'That dealer isn\u2019t on this month\u2019s statements.');
  return emailStatement(env, m, r, st);
}
async function emailStatement(env, m, r, st) {
  if (!st.email) throw err(400, 'There\u2019s no email for ' + st.name + '. Add one on the Dealers tab, or print the statement.');
  const c = v => '$' + (v / 100).toFixed(2), e = v => String(v == null ? '' : v).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
  const label = new Date(r.month + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const rows = st.lines.map(l => '<tr><td style="padding:4px 6px 4px 0">' + e(l.day.slice(5)) + '</td><td style="padding:4px 6px">' + e(l.title) + '</td><td style="padding:4px 0;text-align:right">' + c(l.price) + '</td><td style="padding:4px 0 4px 8px;text-align:right">' + c(l.share) + '</td></tr>').join('');
  const inner = '<p style="margin:0 0 10px">' + e(m.name) + ', booth ' + e(st.booth) + ' &middot; ' + e(label) + '</p>' +
    (st.lines.length ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse"><tr style="color:#6A6259;font-size:12px"><td>Date</td><td style="padding:0 6px">Item</td><td style="text-align:right">Sold for</td><td style="text-align:right;padding-left:8px">Your share</td></tr>' + rows + '</table>' : '<p>No sales this month.</p>') +
    '<p style="margin:14px 0 4px">Sales ' + c(st.sales) + ' &middot; mall commission ' + c(st.commission) + (st.cardFees ? ' &middot; card fees ' + c(st.cardFees) : '') + '</p>' +
    '<p style="margin:0 0 4px"><b>Your share: ' + c(st.share) + '</b></p>' +
    (st.paidByTabella ? '<p style="margin:0 0 4px">Already sent to your bank by Tabella (card sales): ' + c(st.paidByTabella) + '</p>' : '') +
    (st.rent ? '<p style="margin:0 0 4px">Booth rent: ' + c(st.rent) + (st.rentTaken ? ' (' + c(st.rentTaken) + ' taken from card sales)' : '') + '</p>' : '') +
    (st.net > 0 ? '<p style="margin:0 0 4px"><b>Paid by ' + e(m.name) + ': ' + c(st.net) + '</b>' + (st.paid ? ' (paid ' + e(new Date(st.paid.at).toLocaleDateString('en-US')) + (st.paid.note ? ', ' + e(st.paid.note) : '') + ')' : '') + '</p>' : '') +
    (st.net < 0 ? '<p style="margin:0 0 4px"><b>Rent still due to ' + e(m.name) + ': ' + c(-st.net) + '</b></p>' : '') +
    (st.waiting ? '<p style="margin:0 0 4px">Waiting for you to connect a bank in the Tabella dealer app: ' + c(st.waiting) + '</p>' : '');
  const text = m.name + ', booth ' + st.booth + ', ' + label + '\n' + st.lines.map(l => l.day + '  ' + l.title + '  ' + c(l.price) + '  share ' + c(l.share)).join('\n') +
    '\nSales ' + c(st.sales) + ', commission ' + c(st.commission) + ', card fees ' + c(st.cardFees) + '\nYour share ' + c(st.share) +
    (st.rent ? '\nBooth rent ' + c(st.rent) + (st.rentTaken ? ' (' + c(st.rentTaken) + ' taken from card sales)' : '') : '') +
    (st.net > 0 ? '\nPaid by ' + m.name + ' ' + c(st.net) : st.net < 0 ? '\nRent still due ' + c(-st.net) : '');
  const r2 = await sendEmail(env, { to: st.email, replyTo: m.email, subject: m.name + ' statement, ' + label + ', booth ' + st.booth, html: emailFrame('Your ' + label + ' statement', inner), text });
  if (r2.skipped) throw err(503, 'Email isn\u2019t switched on yet. Print the statement instead.');
  if (r2.error) throw err(502, 'The email didn\u2019t send: ' + r2.error);
  const at = Date.now(); st.sent = at;
  await env.TABELLA.put('msent:' + m.id + ':' + r.month.replace('-', '') + ':' + st.id, String(at), { expirationTtl: 60 * 60 * 24 * 800 });
  return { ok: true, to: st.email };
}
async function statementsCsv(env, m, month, cors) {
  const r = await statements(env, m, month), c = v => (v / 100).toFixed(2);
  const who = { mall: 'Mall', tabella: 'Tabella (card, to dealer bank)', waiting: 'Waiting for dealer bank' };
  const rows = [['Booth', 'Dealer', 'Date', 'Sale', 'Item number', 'Item', 'Paid by', 'Sold for', 'Mall commission', 'Card fee', 'Dealer share', 'Who pays the dealer']];
  for (const st of r.dealers) for (const l of st.lines) rows.push([st.booth, st.name, l.day, l.sale, l.item, l.title, l.method === 'cash' ? 'Cash' : 'Card', c(l.price), c(l.commission), c(l.cardFee), c(l.share), who[l.who]]);
  rows.push([]);
  rows.push(['Booth', 'Dealer', 'Sales', 'Commission', 'Card fees', 'Dealer share', 'Sent by Tabella', 'Waiting', 'Booth rent', 'Rent taken from card sales', 'Mall pays dealer', 'Rent still due from dealer', 'Marked paid']);
  for (const st of r.dealers) rows.push([st.booth, st.name, c(st.sales), c(st.commission), c(st.cardFees), c(st.share), c(st.paidByTabella), c(st.waiting), c(st.rent), c(st.rentTaken), c(Math.max(0, st.net)), c(Math.max(0, -st.net)), st.paid ? new Date(st.paid.at).toISOString().slice(0, 10) + (st.paid.note ? ' ' + st.paid.note : '') : '']);
  const csv = rows.map(row => row.map(v => { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\r\n');
  return new Response(csv, { headers: Object.assign({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="' + m.name.replace(/[^A-Za-z0-9]+/g, '-') + '-statements-' + r.month + '.csv"' }, cors) });
}

// ---------- emailing every statement ----------
// Sends to each booth that had sales this month, has an email and hasn't been emailed this month's statement yet.
// A few at a time (the register's button calls again until none are left), so one request never runs long.
const SEND_BATCH = 15;
async function sendAll(env, m, b) {
  const r = await statements(env, m, b.month);
  // resend: "send them all again". since = when the mall tapped the button, so each booth gets exactly one new copy.
  const since = b.resend ? Number(b.since) || Date.now() : 0;
  const has = st => st.lines.length || st.rent;
  const todo = r.dealers.filter(st => has(st) && st.email && (!st.sent || (since && st.sent < since)));
  const out = { month: r.month, sent: 0, failed: [], noEmail: r.dealers.filter(st => has(st) && !st.email).map(st => 'Booth ' + st.booth + ' ' + st.name) };
  for (const st of todo.slice(0, SEND_BATCH)) {
    try { await emailStatement(env, m, r, st); out.sent++; } catch (e) { out.failed.push('Booth ' + st.booth + ' ' + st.name + ': ' + e.message); if (e.status === 503) break; }
    await new Promise(ok => setTimeout(ok, 600)); // stay under the email service's rate limit
  }
  out.left = Math.max(0, todo.length - SEND_BATCH);
  return out;
}

// ---------- automatic monthly statements ----------
//   mallauto:<mall>                 present when the mall has auto-send on (so the daily timer only reads those malls)
//   mautodone:<mall>:<yyyymm>       last month's statements were sent automatically
// The Worker's daily timer (wrangler.toml) calls autoStatements. On the mall's chosen day it emails last month's
// statements and sends the mall a short summary.
async function setAuto(env, m, b) {
  const on = !!b.on, day = Math.round(Number(b.day || 1));
  if (!(day >= 1 && day <= 28)) throw err(400, 'Pick a day from 1 to 28.');
  m.autoStatements = { on, day };
  await env.TABELLA.put('mall:' + m.id, JSON.stringify(m));
  if (on) await env.TABELLA.put('mallauto:' + m.id, '1'); else await env.TABELLA.delete('mallauto:' + m.id);
  return m;
}
function lastMonth(ym) { let [y, mo] = ym.split('-').map(Number); mo--; if (!mo) { mo = 12; y--; } return y + '-' + String(mo).padStart(2, '0'); }
export async function autoStatements(env) {
  if (!env.TABELLA) return [];
  const done = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'mallauto:', cursor });
    for (const k of l.keys) {
      const id = k.name.slice(9), m = JSON.parse(await env.TABELLA.get('mall:' + id) || 'null');
      if (!m || !m.autoStatements || !m.autoStatements.on) { await env.TABELLA.delete(k.name); continue; }
      const today = dayOf(m, Date.now());
      if (Number(today.slice(8)) < m.autoStatements.day) continue;
      const month = lastMonth(today.slice(0, 7)), flag = 'mautodone:' + id + ':' + month.replace('-', '');
      if (await env.TABELLA.get(flag)) continue;
      const total = { sent: 0, failed: [], noEmail: [] };
      for (let i = 0; i < 20; i++) {
        const r = await sendAll(env, m, { month });
        total.sent += r.sent; total.failed.push(...r.failed); total.noEmail = r.noEmail;
        if (!r.left || !r.sent) break;
      }
      await env.TABELLA.put(flag, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 400 });
      const label = new Date(month + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const paras = ['Tabella emailed ' + total.sent + ' dealer statement' + (total.sent === 1 ? '' : 's') + ' for ' + label + '.',
        total.noEmail.length ? 'No email on file, so print these from the Statements tab: ' + total.noEmail.join(', ') + '.' : '',
        total.failed.length ? 'These didn\u2019t send: ' + total.failed.join('; ') + '.' : '',
        'Open the Statements tab at tabellasuite.com/mall/ to print, resend or mark booths paid.'];
      await sendEmail(env, { to: m.email, subject: label + ' dealer statements sent', html: emailFrame(label + ' statements', paras.filter(Boolean).map(p => '<p style="margin:0 0 12px">' + p.replace(/[<>&]/g, '') + '</p>').join('')), text: paras.filter(Boolean).join('\n\n') }).catch(() => null);
      done.push({ mall: id, month, sent: total.sent });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return done;
}
