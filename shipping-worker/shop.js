// Tabella online shop: prices and box sizes come from the published catalog (tabellasuite.com/shop/items.json),
// never from the shopper's browser. Shipping is quoted live through Shippo; payment goes through Stripe (stripe.js).
//
// Needs:
//   ORDERS            KV namespace binding (holds and sold flags, order records). See wrangler.toml.
//   SHIP_FROM         secret, JSON: {"name":"…","street1":"…","city":"…","state":"MO","zip":"…","phone":"…"}
//                     Kept as a secret so the ship-from address never appears on the website.
//   SHIPPO_API_KEY, STRIPE_SECRET_KEY (already set)
//   CATALOG_URL       optional; defaults to https://tabellasuite.com/shop/items.json

import { buildOrder, createCheckoutSession, stripeMode } from './stripe.js';
import { dealerListings, dealerItem, markDealerItemSold, shantiquesMoved, ITEM_ID } from './app.js';
import { sendEmail, buyerReceipt, dealerAlert, opsEmail } from './mail.js';

const HOLD_SECONDS = 35 * 60; // Stripe checkout pages last 30 minutes minimum; hold a little longer.

export async function handleShop(request, env, url, json, cors, shippoFetch) {
  const p = url.pathname;
  if (!p.startsWith('/shop/')) return null;
  try {
    if (p === '/shop/catalog' && request.method === 'GET') {
      // Public catalog: Shantiques' published list plus every dealer-app listing. No Stripe accounts or addresses.
      const cat = await catalog(env);
      const live = (await dealerListings(env)).map(i => Object.assign(i, { photo: url.origin + i.photo }));
      const dealers = {};
      Object.keys(cat.dealers || {}).forEach(k => { dealers[k] = { name: cat.dealers[k].name }; });
      live.forEach(i => { dealers[i.dealer] = { name: i.dealerName }; });
      // Once Shantiques has moved into the app, its old published list steps aside so nothing shows twice.
      const moved = await shantiquesMoved(env), liveIds = new Set(live.map(i => i.id));
      let staticList = moved.done ? [] : (cat.items || []).filter(i => !liveIds.has(i.id));
      if (moved.started && !moved.done) staticList = (await Promise.all(staticList.map(async i => (await env.TABELLA.get('itemix:' + i.id)) ? null : i))).filter(Boolean);
      const statics = staticList.map(i => { const o = Object.assign({}, i, { photo: 'https://tabellasuite.com/shop/' + i.photo, dealerName: (cat.dealers[i.dealer] || {}).name }); delete o.weightLb; delete o.box; return o; });
      return new Response(JSON.stringify({ dealers, items: statics.concat(live) }), { headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'public, max-age=30' }, cors) });
    }
    if (p === '/shop/status' && request.method === 'GET') {
      if (!env.ORDERS) return json({ sold: [], held: [], note: 'ORDERS store not set up' }, 200, cors);
      const [sold, held] = await Promise.all([keys(env, 'sold:'), keys(env, 'hold:')]);
      return json({ sold, held }, 200, cors);
    }
    if (p === '/shop/quote' && request.method === 'POST') {
      const b = await body(request);
      const cat = await catalog(env);
      const pick = await pickItems(env, cat, b.items, null);
      if (pick.error) return json({ error: pick.error }, 400, cors);
      const to = checkAddress(b.to);
      if (to.error) return json({ error: to.error }, 400, cors);
      const from = pick.items[0].shipFrom || shipFrom(env);
      if (!from) return json({ error: 'The shop’s ship-from address is not set up yet (SHIP_FROM).' }, 500, cors);
      const q = await shippoFetch('/shipments/', 'POST', {
        address_from: from, address_to: to.addr, async: false,
        parcels: pick.items.map(it => ({ length: String(it.box[0]), width: String(it.box[1]), height: String(it.box[2]), distance_unit: 'in', weight: String(it.weightLb), mass_unit: 'lb' }))
      });
      const rates = (q.rates || []).map(r => ({ id: r.object_id, carrier: r.provider, service: r.servicelevel && r.servicelevel.name, amount: Number(r.amount), days: r.estimated_days == null ? null : r.estimated_days }))
        .filter(r => isFinite(r.amount) && r.amount > 0).sort((a, c) => a.amount - c.amount).slice(0, 6);
      if (!rates.length) return json({ error: 'No shipping options came back for that address. Check the address and try again.', notes: (q.messages || []).map(m => m.text) }, 400, cors);
      return json({ rates, items: pick.items.map(publicItem), subtotal: pick.items.reduce((t, i) => t + i.price, 0) }, 200, cors);
    }
    if (p === '/shop/checkout' && request.method === 'POST') {
      if (!env.ORDERS) return json({ error: 'The ORDERS store is not set up yet.' }, 500, cors);
      const b = await body(request);
      const cat = await catalog(env);
      const pick = await pickItems(env, cat, b.items, null);
      if (pick.error) return json({ error: pick.error }, 400, cors);
      const to = checkAddress(b.to);
      if (to.error) return json({ error: to.error }, 400, cors);
      if (!/^[a-f0-9]{32}$/.test(String(b.rateId || ''))) return json({ error: 'Pick a shipping option first.' }, 400, cors);
      // Shipping price comes from Shippo, not the browser.
      const rate = await shippoFetch('/rates/' + b.rateId, 'GET');
      const ship = Number(rate.amount);
      if (!isFinite(ship) || ship <= 0) return json({ error: 'That shipping option has expired. Get shipping again.' }, 400, cors);
      const email = String(b.email || '').trim().slice(0, 120);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter your email so we can send tracking.' }, 400, cors);

      const order = buildOrder({ items: pick.items.map(it => ({ name: it.title + ' (' + it.id + ')', price: it.price, dealerAccount: it.account || dealerAccount(cat, it), mallAccount: undefined })), shipping: ship });
      if (order.error) return json({ error: order.error }, 400, cors);

      // Hold each item so two people can't buy the same one-of-a-kind piece.
      const ref = 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      for (const it of pick.items) {
        if (await env.ORDERS.get('sold:' + it.id) || await env.ORDERS.get('hold:' + it.id)) return json({ error: it.title + ' was just bought or is in someone’s checkout. Remove it and try again.' }, 409, cors);
      }
      await Promise.all(pick.items.map(it => env.ORDERS.put('hold:' + it.id, ref, { expirationTtl: HOLD_SECONDS })));

      const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
      let session;
      try {
        session = await createCheckoutSession(env, order, {
          success_url: site + '/shop/thanks.html?order=' + ref,
          cancel_url: site + '/shop/?canceled=' + ref,
          customer_email: email,
          expires_at: String(Math.floor(Date.now() / 1000) + 31 * 60),
          'metadata[order]': ref,
          'metadata[items]': pick.items.map(i => i.id).join(','),
          'payment_intent_data[metadata][order]': ref
        });
      } catch (e) {
        await Promise.all(pick.items.map(it => env.ORDERS.delete('hold:' + it.id)));
        throw e;
      }
      await env.ORDERS.put('order:' + ref, JSON.stringify({ ref, status: 'checkout', created: Date.now(), session: session.id,
        items: pick.items.map(i => ({ id: i.id, title: i.title, price: i.price, dealer: i.dealer })), shipTo: to.addr, email,
        shipping: { rateId: b.rateId, amount: ship, carrier: rate.provider, service: rate.servicelevel && rate.servicelevel.name, token: rate.servicelevel && rate.servicelevel.token }, breakdown: order.breakdown }), { expirationTtl: 60 * 60 * 24 * 400 });
      return json({ url: session.url, order: ref, breakdown: order.breakdown, testMode: stripeMode(env) === 'test' }, 200, cors);
    }
    if (p === '/shop/order' && request.method === 'GET') {
      // Shopper's own confirmation page. Shows only what they bought, never the address or email.
      const ref = url.searchParams.get('ref') || '';
      if (!env.ORDERS || !/^o_[a-z0-9]+$/.test(ref)) return json({ error: 'Order not found.' }, 404, cors);
      const o = JSON.parse(await env.ORDERS.get('order:' + ref) || 'null');
      if (!o) return json({ error: 'Order not found.' }, 404, cors);
      return json({ ref, status: o.status, items: o.items.map(i => ({ id: i.id, title: i.title, price: i.price })), shipping: o.shipping && { amount: o.shipping.amount, carrier: o.shipping.carrier, service: o.shipping.service }, total: o.breakdown && o.breakdown.total }, 200, cors);
    }
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 502, cors);
  }
}

// Called from the Stripe webhook after payment (or when a checkout page expires).
export async function shopAfterPayment(env, session, paid) {
  if (!env.ORDERS || !session.metadata || !session.metadata.order) return;
  const ref = session.metadata.order;
  const ids = String(session.metadata.items || '').split(',').filter(Boolean);
  const o = JSON.parse(await env.ORDERS.get('order:' + ref) || 'null');
  if (paid) {
    await Promise.all(ids.map(id => env.ORDERS.put('sold:' + id, ref)));
    await Promise.all(ids.map(id => markDealerItemSold(env, id, ref)));
    if (o) {
      o.status = 'paid'; o.paidAt = o.paidAt || Date.now(); o.paymentIntent = session.payment_intent;
      if (!o.emailed) {
        // One email to the buyer, one to the shop. Stripe can resend the same event, so this runs once per order.
        const x = ids.length ? await dealerItem(env, ids[0]) : null;
        const shop = x ? x.dealer.name : 'Shantiques', to = x ? x.dealer.email : opsEmail(env);
        o.test = stripeMode(env) === 'test';
        const r1 = o.email ? await sendEmail(env, Object.assign({ to: o.email }, buyerReceipt(o, shop))) : { skipped: 'no buyer email' };
        const r2 = await sendEmail(env, Object.assign({ to, bcc: to === opsEmail(env) ? undefined : opsEmail(env) }, dealerAlert(o, shop)));
        o.emails = { buyer: r1, dealer: r2 };
        if (!r1.skipped && !r2.skipped) o.emailed = true;
      }
      await env.ORDERS.put('order:' + ref, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 400 });
    }
  } else {
    if (o && o.status === 'checkout') { o.status = 'expired'; await env.ORDERS.put('order:' + ref, JSON.stringify(o), { expirationTtl: 60 * 60 * 24 * 30 }); }
  }
  await Promise.all(ids.map(async id => { if ((await env.ORDERS.get('hold:' + id)) === ref) await env.ORDERS.delete('hold:' + id); }));
}

// ---------- helpers ----------
let CAT = null, CAT_AT = 0;
async function catalog(env) {
  if (CAT && Date.now() - CAT_AT < 60000) return CAT;
  const u = env.CATALOG_URL || 'https://tabellasuite.com/shop/items.json';
  const r = await fetch(u, { cf: { cacheTtl: 60 } });
  if (!r.ok) { const e = new Error('The shop catalog could not be loaded.'); e.status = 502; throw e; }
  CAT = await r.json(); CAT_AT = Date.now();
  return CAT;
}
async function pickItems(env, cat, ids) {
  if (!Array.isArray(ids) || !ids.length) return { error: 'Your cart is empty.' };
  if (ids.length > 10) return { error: 'Up to 10 items per order.' };
  const uniq = [...new Set(ids.map(String))], out = [];
  for (const id of uniq) {
    let it;
    const x = ITEM_ID.test(id) ? await dealerItem(env, id) : null;
    if (x || /^T[0-9A-Z]{6}$/.test(id)) {
      // Dealer-app item: everything comes from the server record, never the browser.
      if (!x || x.item.status !== 'available' || !x.item.online || !(x.item.price > 0)) return { error: 'An item in your cart is no longer listed.' };
      const d = x.dealer;
      if (!(x.item.weightLb && x.item.box && d.payoutsReady && d.stripeAccount && d.shipFrom)) return { error: x.item.title + ' can\u2019t ship yet.' };
      it = { id, title: x.item.title, price: x.item.price, dealer: d.id, shippable: true, weightLb: x.item.weightLb, box: x.item.box, account: d.stripeAccount, shipFrom: Object.assign({ country: 'US', name: d.name }, d.shipFrom) };
    } else {
      it = (cat.items || []).find(x => x.id === id);
      if (!it) return { error: 'An item in your cart is no longer listed.' };
    }
    if (!it.shippable) return { error: it.title + ' can’t ship yet.' };
    if (env.ORDERS && await env.ORDERS.get('sold:' + id)) return { error: it.title + ' has sold.' };
    out.push(it);
  }
  const dealers = new Set(out.map(i => i.dealer));
  if (dealers.size > 1) return { error: 'For now, each order can hold items from one shop.' };
  return { items: out };
}
function dealerAccount(cat, it) { const d = (cat.dealers || {})[it.dealer]; return d && d.account; }
function publicItem(i) { return { id: i.id, title: i.title, price: i.price }; }
function shipFrom(env) { try { const a = JSON.parse(env.SHIP_FROM || ''); return a && a.zip ? Object.assign({ country: 'US' }, a) : null; } catch (e) { return null; } }
function checkAddress(a) {
  if (!a || typeof a !== 'object') return { error: 'Enter a shipping address.' };
  const out = { country: 'US' };
  for (const f of ['name', 'street1', 'street2', 'city', 'state', 'zip']) if (a[f] != null && String(a[f]).trim()) out[f] = String(a[f]).trim().slice(0, 80);
  for (const f of ['name', 'street1', 'city', 'state', 'zip']) if (!out[f]) return { error: 'The address needs ' + ({ street1: 'a street', zip: 'a ZIP code' }[f] || 'a ' + f) + '.' };
  if (!/^\d{5}(-\d{4})?$/.test(out.zip)) return { error: 'The ZIP code looks wrong.' };
  if (!/^[A-Za-z]{2}$/.test(out.state)) return { error: 'Use the two-letter state code, like MO.' };
  out.state = out.state.toUpperCase();
  return { addr: out };
}
async function keys(env, prefix) { const l = await env.ORDERS.list({ prefix }); return l.keys.map(k => k.name.slice(prefix.length)); }
async function body(request) { try { return await request.json(); } catch (e) { return {}; } }
