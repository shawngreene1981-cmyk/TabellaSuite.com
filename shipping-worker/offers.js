// Shoppers: email-link sign-in, saved pieces, and offers on dealer-app pieces.
//
// The rules (Shawn's choices):
//   - Offers only. A shopper offers; the dealer accepts, declines, or counters ONCE; the shopper takes the counter or leaves it.
//   - Every step is open for 24 hours, then the offer expires and the piece stays on sale.
//   - No typing between shopper and dealer: preset phrases only, each once per side. No phone numbers, links or deals off Tabella.
//   - An accepted offer holds the piece for that shopper, at the agreed price, for 24 hours. They pay through the normal checkout.
//
// Storage (TABELLA KV):
//   buyer:<id>                    { id, email, saved: [item ids], created }
//   buyeremail:<email>            -> buyer id (separate from dealer and mall sign-ins: a dealer can shop too)
//   blink:<token>                 one-time sign-in link -> email (1 hour)
//   bsess:<token>                 shopper session -> buyer id (90 days)
//   offer:<id>                    the thread (below); offers expire on read, so nothing needs a timer
//   boffer:<buyer>:<id>, doffer:<dealer>:<id>   lists for each side
//   bthread:<buyer>:<item>        -> the shopper's open thread on a piece (one at a time)
// Holds (ORDERS KV): hold:<item> = "offer:<id>" while an accepted offer waits to be paid.

import { session as dealerSession, rand, cleanEmail, err, body, dealerItem, ITEM_ID } from './app.js';
import { sendEmail, noteEmail } from './mail.js';

const DAY = 24 * 3600e3;
const MIN_OFFER = 0.3; // offers below 30% of the price aren't sent
export const BUYER_SAYS = {
  avail: 'Is this still available?', photo: 'Could you add another photo?', cond: 'Any chips, cracks or repairs?',
  size: 'What are the measurements?', thanks: 'Thank you!'
};
export const DEALER_SAYS = {
  avail_yes: 'Yes, it’s still available.', photo_yes: 'I’ve added more photos to the listing.', cond_none: 'No chips, cracks or repairs that I can see.',
  cond_listing: 'Any wear is described in the listing.', size_added: 'I’ve added the measurements to the listing.', firm: 'The price is firm.', thanks: 'Thank you!'
};
const MAX_SAYS = 5;

export async function handleOffers(request, env, url, json, cors) {
  const p = url.pathname;
  if (!p.startsWith('/buyer/') && !p.startsWith('/app/offers')) return null;
  if (!env.TABELLA) return json({ error: 'The TABELLA store is not set up yet.' }, 500, cors);
  try {
    if (p.startsWith('/app/offers')) {
      const me = await dealerSession(env, request);
      if (!me) return json({ error: 'Please sign in again.', signin: true }, 401, cors);
      const d = me.dealer;
      if (p === '/app/offers' && request.method === 'GET') return json({ offers: await listFor(env, 'doffer:' + d.id + ':', 'dealer') }, 200, cors);
      const m = p.match(/^\/app\/offers\/(O[0-9A-Z]{8,16})\/(accept|decline|counter|say)$/);
      if (m && request.method === 'POST') return json({ offer: await dealerAct(env, d, m[1], m[2], await body(request)) }, 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    }
    if (p === '/buyer/start' && request.method === 'POST') return json(await start(env, request, await body(request)), 200, cors);
    if (p === '/buyer/login' && request.method === 'POST') return json(await login(env, await body(request)), 200, cors);
    const b = await buyerSession(env, request);
    if (!b) return json({ error: 'Please sign in again.', signin: true }, 401, cors);
    if (p === '/buyer/me' && request.method === 'GET') return json({ buyer: pub(b.buyer) }, 200, cors);
    if (p === '/buyer/logout' && request.method === 'POST') { await env.TABELLA.delete('bsess:' + b.token); return json({ ok: true }, 200, cors); }
    if (p === '/buyer/saved' && request.method === 'POST') return json({ buyer: pub(await setSaved(env, b.buyer, await body(request))) }, 200, cors);
    if (p === '/buyer/offers' && request.method === 'GET') return json({ offers: await listFor(env, 'boffer:' + b.buyer.id + ':', 'buyer') }, 200, cors);
    if (p === '/buyer/offers' && request.method === 'POST') return json({ offer: await open(env, b.buyer, await body(request)) }, 200, cors);
    const m = p.match(/^\/buyer\/offers\/(O[0-9A-Z]{8,16})(?:\/(offer|accept|decline|say))?$/);
    if (m && request.method === 'GET' && !m[2]) return json({ offer: view(await getOffer(env, m[1], b.buyer.id, null), 'buyer') }, 200, cors);
    if (m && request.method === 'POST' && m[2]) return json({ offer: await buyerAct(env, b.buyer, m[1], m[2], await body(request)) }, 200, cors);
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

// ---------- sign-in by email link ----------
async function start(env, request, b) {
  const email = cleanEmail(b.email);
  if (!email) throw err(400, 'Enter a valid email.');
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  for (const k of ['brl:' + email, 'brli:' + ip]) {
    const n = Number(await env.TABELLA.get(k) || 0);
    if (n >= (k.startsWith('brl:') ? 4 : 15)) throw err(429, 'Too many sign-in emails. Try again in an hour.');
    await env.TABELLA.put(k, String(n + 1), { expirationTtl: 3600 });
  }
  const t = rand(40);
  await env.TABELLA.put('blink:' + t, email, { expirationTtl: 3600 });
  const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
  const link = site + '/swipe/?login=' + t;
  const r = await sendEmail(env, { to: email, subject: 'Your Tabella sign-in link',
    html: noteEmail('Sign in to Tabella', ['Tap the button to sign in. The link works once, for the next hour.',
      '<a href="' + link + '" style="display:inline-block;background:#9A4A2E;color:#FFF8F0;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">Sign in</a>',
      'If you didn’t ask for this, you can ignore it.']),
    text: 'Sign in to Tabella (the link works once, for the next hour): ' + link });
  if (r && r.skipped) return { sent: false, devLink: env.SHOW_TEST_PAGE === 'true' && !env.RESEND_API_KEY ? link : undefined };
  return { sent: true };
}
async function login(env, b) {
  const t = String(b.token || '');
  if (!/^[a-z0-9]{40}$/.test(t)) throw err(400, 'That sign-in link isn’t valid. Ask for a new one.');
  const email = await env.TABELLA.get('blink:' + t);
  if (!email) throw err(400, 'That sign-in link has expired or was already used. Ask for a new one.');
  await env.TABELLA.delete('blink:' + t);
  let id = await env.TABELLA.get('buyeremail:' + email), buyer = id ? JSON.parse(await env.TABELLA.get('buyer:' + id) || 'null') : null;
  if (!buyer) { id = 'b' + rand(10); buyer = { id, email, saved: [], created: Date.now() }; await env.TABELLA.put('buyer:' + id, JSON.stringify(buyer)); await env.TABELLA.put('buyeremail:' + email, id); }
  if (Array.isArray(b.saved)) { for (const s of b.saved) if (ITEM_ID.test(String(s)) && !buyer.saved.includes(s)) buyer.saved.push(s); buyer.saved = buyer.saved.slice(-200); await env.TABELLA.put('buyer:' + id, JSON.stringify(buyer)); }
  const tok = rand(40);
  await env.TABELLA.put('bsess:' + tok, id, { expirationTtl: 60 * 60 * 24 * 90 });
  return { token: tok, buyer: pub(buyer) };
}
export async function buyerSession(env, request) {
  const t = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[a-z0-9]{40}$/.test(t)) return null;
  const id = await env.TABELLA.get('bsess:' + t);
  if (!id || id[0] !== 'b') return null;
  const buyer = JSON.parse(await env.TABELLA.get('buyer:' + id) || 'null');
  return buyer ? { token: t, buyer } : null;
}
function pub(b) { return { email: b.email, saved: b.saved || [] }; }
async function setSaved(env, buyer, b) {
  const id = String(b.id || '');
  if (!ITEM_ID.test(id)) throw err(400, 'That piece isn’t valid.');
  buyer.saved = (buyer.saved || []).filter(x => x !== id);
  if (b.on) buyer.saved.push(id);
  buyer.saved = buyer.saved.slice(-200);
  await env.TABELLA.put('buyer:' + buyer.id, JSON.stringify(buyer));
  return buyer;
}

// ---------- offers ----------
function newId() { return 'O' + Date.now().toString(36).toUpperCase() + rand(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'); }
async function save(env, o) { await env.TABELLA.put('offer:' + o.id, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 120 }); }
const OPEN = ['asked', 'offered', 'countered', 'accepted'];
// Brings a thread up to date: sold elsewhere, timed out, or paid for.
async function refresh(env, o) {
  if (!OPEN.includes(o.status)) return o;
  const before = o.status, x = await dealerItem(env, o.item);
  const soldRef = env.ORDERS ? await env.ORDERS.get('sold:' + o.item) : null;
  if (o.status === 'accepted' && soldRef && o.order && soldRef === o.order) o.status = 'bought';
  else if (!x || x.item.status === 'sold' || soldRef) o.status = 'sold';
  else if (o.expires && Date.now() > o.expires) o.status = 'expired';
  if (o.status !== before) {
    o.closed = Date.now();
    if (before === 'accepted' && env.ORDERS && (await env.ORDERS.get('hold:' + o.item)) === 'offer:' + o.id) await env.ORDERS.delete('hold:' + o.item);
    await env.TABELLA.delete('bthread:' + o.buyer + ':' + o.item);
    await save(env, o);
  }
  return o;
}
async function getOffer(env, id, buyerId, dealerId) {
  const o = JSON.parse(await env.TABELLA.get('offer:' + id) || 'null');
  if (!o || (buyerId && o.buyer !== buyerId) || (dealerId && o.dealer !== dealerId)) throw err(404, 'That offer wasn’t found.');
  return refresh(env, o);
}
// What each side sees. Neither side ever sees the other's email.
function view(o, side) {
  const v = { id: o.id, item: o.item, title: o.title, photo: o.photo, price: o.price, amount: o.amount, counter: o.counter, agreed: o.agreed, status: o.status,
    expires: OPEN.includes(o.status) ? o.expires : null, created: o.created, says: o.says, dealerName: o.dealerName, turn: turn(o),
    canSay: [] };
  const used = o.says.filter(s => s.from === side);
  if (OPEN.includes(o.status) && used.length < MAX_SAYS) v.canSay = Object.keys(side === 'buyer' ? BUYER_SAYS : DEALER_SAYS).filter(k => !used.some(s => s.code === k));
  if (side === 'dealer') v.shopper = 'Shopper ' + o.buyer.slice(-4).toUpperCase();
  return v;
}
function turn(o) { return o.status === 'offered' || o.status === 'asked' ? 'dealer' : o.status === 'countered' || o.status === 'accepted' ? 'buyer' : null; }
async function listFor(env, prefix, side) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix, cursor });
    for (const k of l.keys) { const o = JSON.parse(await env.TABELLA.get('offer:' + k.name.slice(prefix.length)) || 'null'); if (o) out.push(view(await refresh(env, o), side)); else await env.TABELLA.delete(k.name); }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out.sort((a, b) => (OPEN.includes(b.status) - OPEN.includes(a.status)) || b.created - a.created).slice(0, 100);
}
function cents(v, label) { const n = Math.round(Number(String(v == null ? '' : v).replace(/[$,]/g, '')) * 100); if (!isFinite(n) || n <= 0) throw err(400, 'Enter ' + label + '.'); return n; }

async function open(env, buyer, b) {
  const id = String(b.item || '').toUpperCase();
  if (!ITEM_ID.test(id)) throw err(400, 'That piece isn’t valid.');
  const x = await dealerItem(env, id);
  if (!x || x.item.status !== 'available' || !x.item.online || !(x.item.price > 0)) throw err(409, 'That piece isn’t available for offers.');
  if (env.ORDERS && (await env.ORDERS.get('sold:' + id) || await env.ORDERS.get('hold:' + id))) throw err(409, 'That piece is in someone’s checkout or has sold.');
  const existing = await env.TABELLA.get('bthread:' + buyer.id + ':' + id);
  if (existing) { const o = await getOffer(env, existing, buyer.id, null); if (OPEN.includes(o.status)) throw err(409, 'You already have an offer going on this piece. Find it under Offers.'); }
  const mine = (await env.TABELLA.list({ prefix: 'boffer:' + buyer.id + ':' })).keys.length;
  if (mine >= 200) throw err(429, 'That’s a lot of offers. Let a few finish first.');
  const price = Math.round(x.item.price * 100);
  const o = { id: newId(), item: id, title: x.item.title, photo: x.item.photos && x.item.photos[0] ? '/img/' + x.item.photos[0] : null, price,
    dealer: x.dealer.id, dealerName: x.dealer.name, buyer: buyer.id, status: 'asked', says: [], created: Date.now(), expires: Date.now() + 7 * DAY };
  if (b.amount != null && b.amount !== '') setAmount(o, b.amount);
  if (b.say) addSay(o, 'buyer', b.say);
  if (o.status === 'asked' && !o.says.length) throw err(400, 'Make an offer or pick a question.');
  await save(env, o);
  await env.TABELLA.put('boffer:' + buyer.id + ':' + o.id, '1', { expirationTtl: 60 * 60 * 24 * 120 });
  await env.TABELLA.put('doffer:' + o.dealer + ':' + o.id, '1', { expirationTtl: 60 * 60 * 24 * 120 });
  await env.TABELLA.put('bthread:' + buyer.id + ':' + id, o.id, { expirationTtl: 60 * 60 * 24 * 8 });
  await tellDealer(env, o, o.status === 'offered' ? 'New offer: ' + money(o.amount) + ' for ' + o.title : 'A shopper asked about ' + o.title,
    [o.status === 'offered' ? 'A shopper offered <b>' + money(o.amount) + '</b> for <b>' + esc(o.title) + '</b> (listed at ' + money(o.price) + ').' : 'A shopper has a question about <b>' + esc(o.title) + '</b>.',
     o.says.length ? '&ldquo;' + esc(BUYER_SAYS[o.says[0].code]) + '&rdquo;' : '', o.status === 'offered' ? 'You can accept, decline or make one counter offer within 24 hours.' : '']);
  return view(o, 'buyer');
}
function setAmount(o, v) {
  const a = cents(v, 'your offer');
  if (a >= o.price) throw err(400, 'That’s the full price. Buy it in the shop instead.');
  if (a < Math.ceil(o.price * MIN_OFFER)) throw err(400, 'Offers need to be at least ' + money(Math.ceil(o.price * MIN_OFFER)) + ' for this piece.');
  o.amount = a; o.status = 'offered'; o.expires = Date.now() + DAY;
}
function addSay(o, side, code) {
  const list = side === 'buyer' ? BUYER_SAYS : DEALER_SAYS;
  if (!list[code]) throw err(400, 'Pick one of the messages.');
  if (o.says.some(s => s.from === side && s.code === code)) throw err(409, 'You already sent that one.');
  if (o.says.filter(s => s.from === side).length >= MAX_SAYS) throw err(429, 'That’s the most messages for one piece.');
  o.says.push({ from: side, code, text: list[code], at: Date.now() });
}

async function buyerAct(env, buyer, id, act, b) {
  const o = await getOffer(env, id, buyer.id, null);
  if (act === 'say') {
    if (!OPEN.includes(o.status)) throw err(409, 'This conversation has ended.');
    addSay(o, 'buyer', b.code); await save(env, o);
    await tellDealer(env, o, 'A shopper wrote about ' + o.title, ['About <b>' + esc(o.title) + '</b>: &ldquo;' + esc(BUYER_SAYS[b.code]) + '&rdquo;']);
    return view(o, 'buyer');
  }
  if (act === 'offer') {
    if (o.status !== 'asked') throw err(409, o.amount ? 'You already made an offer on this piece.' : 'This conversation has ended.');
    setAmount(o, b.amount); await save(env, o);
    await tellDealer(env, o, 'New offer: ' + money(o.amount) + ' for ' + o.title, ['A shopper offered <b>' + money(o.amount) + '</b> for <b>' + esc(o.title) + '</b> (listed at ' + money(o.price) + ').', 'You can accept, decline or make one counter offer within 24 hours.']);
    return view(o, 'buyer');
  }
  if (act === 'accept') {
    if (o.status !== 'countered') throw err(409, 'There’s no counter offer to accept.');
    await accept(env, o, o.counter, 'buyer');
    await tellDealer(env, o, 'Your counter was accepted: ' + o.title, ['The shopper accepted <b>' + money(o.agreed) + '</b> for <b>' + esc(o.title) + '</b>. It’s held for them for 24 hours while they pay. You’ll get the usual sale email when they do.']);
    return view(o, 'buyer');
  }
  if (act === 'decline') {
    if (!OPEN.includes(o.status)) throw err(409, 'This conversation has ended.');
    await close(env, o, 'declined');
    return view(o, 'buyer');
  }
  throw err(404, 'Not found');
}
async function dealerAct(env, d, id, act, b) {
  const o = await getOffer(env, id, null, d.id);
  if (act === 'say') {
    if (!OPEN.includes(o.status)) throw err(409, 'This conversation has ended.');
    addSay(o, 'dealer', b.code); await save(env, o);
    await tellBuyer(env, o, d.name + ' replied about ' + o.title, [esc(d.name) + ' about <b>' + esc(o.title) + '</b>: &ldquo;' + esc(DEALER_SAYS[b.code]) + '&rdquo;']);
    return view(o, 'dealer');
  }
  if (o.status !== 'offered') throw err(409, o.status === 'asked' ? 'There’s no offer yet, only a question.' : 'This offer is no longer waiting on you.');
  if (act === 'accept') {
    await accept(env, o, o.amount, 'dealer');
    await tellBuyer(env, o, 'Offer accepted: ' + o.title, [esc(d.name) + ' accepted your offer of <b>' + money(o.agreed) + '</b> for <b>' + esc(o.title) + '</b>.', 'It’s held for you for 24 hours. Open Tabella to pay and choose shipping.']);
  } else if (act === 'decline') {
    await close(env, o, 'declined');
    await tellBuyer(env, o, 'Offer declined: ' + o.title, [esc(d.name) + ' declined your offer for <b>' + esc(o.title) + '</b>. It’s still for sale at ' + money(o.price) + '.']);
  } else if (act === 'counter') {
    const c = cents(b.amount, 'your counter offer');
    if (c <= o.amount || c >= o.price) throw err(400, 'A counter needs to be between the offer (' + money(o.amount) + ') and your price (' + money(o.price) + ').');
    o.counter = c; o.status = 'countered'; o.expires = Date.now() + DAY; await save(env, o);
    await tellBuyer(env, o, 'Counter offer: ' + money(c) + ' for ' + o.title, [esc(d.name) + ' countered your offer for <b>' + esc(o.title) + '</b> at <b>' + money(c) + '</b>.', 'You have 24 hours to accept or decline. There are no more counters after this one.']);
  } else throw err(404, 'Not found');
  return view(o, 'dealer');
}
async function accept(env, o, amount, by) {
  if (env.ORDERS) {
    if (await env.ORDERS.get('sold:' + o.item)) { await close(env, o, 'sold'); throw err(409, 'That piece just sold.'); }
    const h = await env.ORDERS.get('hold:' + o.item);
    if (h && h !== 'offer:' + o.id) throw err(409, 'Someone is checking out with that piece right now. Try again in a few minutes.');
    await env.ORDERS.put('hold:' + o.item, 'offer:' + o.id, { expirationTtl: Math.ceil(DAY / 1000) });
  }
  o.agreed = amount; o.status = 'accepted'; o.acceptedBy = by; o.expires = Date.now() + DAY;
  await save(env, o);
}
async function close(env, o, status) {
  o.status = status; o.closed = Date.now();
  if (env.ORDERS && (await env.ORDERS.get('hold:' + o.item)) === 'offer:' + o.id) await env.ORDERS.delete('hold:' + o.item);
  await env.TABELLA.delete('bthread:' + o.buyer + ':' + o.item);
  await save(env, o);
}

// ---------- checkout at the agreed price (called from shop.js) ----------
// Returns the offer if this signed-in shopper may buy the piece at the agreed price, or throws.
export async function offerForCheckout(env, request, offerId, itemIds) {
  const b = await buyerSession(env, request);
  if (!b) throw err(401, 'Sign in again to buy at your offer price.');
  const o = await getOffer(env, String(offerId || ''), b.buyer.id, null);
  if (o.status !== 'accepted') throw err(409, o.status === 'expired' ? 'Your accepted offer has expired.' : 'That offer can’t be bought now.');
  if (itemIds.length !== 1 || itemIds[0] !== o.item) throw err(400, 'An offer is bought on its own. Take other pieces out of the cart first.');
  return o;
}
export async function offerOrderStarted(env, o, ref) { o.order = ref; await save(env, o); }
// The shopper's checkout ended without paying: give the piece back to the offer's hold if the offer is still good.
export async function offerCheckoutEnded(env, offerId, itemId) {
  const o = JSON.parse(await env.TABELLA.get('offer:' + offerId) || 'null');
  if (!o || o.status !== 'accepted' || Date.now() > o.expires || !env.ORDERS) return;
  if (await env.ORDERS.get('sold:' + itemId) || await env.ORDERS.get('hold:' + itemId)) return;
  await env.ORDERS.put('hold:' + itemId, 'offer:' + o.id, { expirationTtl: Math.max(60, Math.ceil((o.expires - Date.now()) / 1000)) });
}

// ---------- emails (neither side's email address is ever shown to the other) ----------
function money(c) { return '$' + (c / 100).toFixed(2); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x])); }
function site(env) { return String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, ''); }
async function tellDealer(env, o, subject, paras) {
  const d = JSON.parse(await env.TABELLA.get('dealer:' + o.dealer) || 'null');
  if (!d || !d.email) return;
  const link = site(env) + '/dealer/#offers';
  await sendEmail(env, { to: d.email, subject, html: noteEmail(subject, paras.concat(['<a href="' + link + '">Open your offers</a>'])), text: paras.join('\n').replace(/<[^>]+>/g, '').replace(/&ldquo;|&rdquo;/g, '"') + '\n' + link }).catch(() => null);
}
async function tellBuyer(env, o, subject, paras) {
  const b = JSON.parse(await env.TABELLA.get('buyer:' + o.buyer) || 'null');
  if (!b || !b.email) return;
  const link = site(env) + '/swipe/#offers';
  await sendEmail(env, { to: b.email, subject, html: noteEmail(subject, paras.concat(['<a href="' + link + '">Open your offers</a>'])), text: paras.join('\n').replace(/<[^>]+>/g, '').replace(/&ldquo;|&rdquo;/g, '"') + '\n' + link }).catch(() => null);
}
