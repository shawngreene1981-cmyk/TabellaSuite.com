// Tabella payments (Stripe Connect, marketplace model).
// Shoppers pay Tabella; after payment, Tabella transfers each dealer's share and each mall's share.
//
// Secrets (set in the Cloudflare dashboard, never in this file):
//   STRIPE_SECRET_KEY      required. sk_test_... while testing.
//   STRIPE_WEBHOOK_SECRET  required for payouts after a sale (whsec_...). From Stripe > Developers > Webhooks.
// Settings:
//   ALLOW_LIVE_PAYMENTS    must be "true" before a live key is accepted. Leave unset while testing.
//   SITE_URL               where shoppers return after checkout. Defaults to https://tabellasuite.com
//
// Money split per item (Shawn's decision): commission 9% of the sold price.
//   mall 4%, Tabella 5%, dealer gets the rest. Card processing is a separate line on the buyer's receipt.

const API = 'https://api.stripe.com/v1';
const COMMISSION = 0.09, MALL_SHARE = 0.04;
const CARD_PCT = 0.029, CARD_FIXED = 30; // cents; online card rate, passed to the buyer as its own line

export function stripeMode(env) {
  const k = String(env.STRIPE_SECRET_KEY || '');
  return !k ? 'missing' : k.startsWith('sk_test_') || k.startsWith('rk_test_') ? 'test' : 'live';
}

export async function handleStripe(request, env, url, json, cors) {
  const p = url.pathname;
  if (!p.startsWith('/pay/')) return null;
  const mode = stripeMode(env);
  if (mode === 'missing') return json({ error: 'The STRIPE_SECRET_KEY secret is not set.' }, 500, cors);
  if (mode === 'live' && String(env.ALLOW_LIVE_PAYMENTS).toLowerCase() !== 'true')
    return json({ error: 'A live Stripe key is set but live payments are not switched on (ALLOW_LIVE_PAYMENTS).' }, 403, cors);

  if (p === '/pay/test' && request.method === 'GET') {
    if (String(env.SHOW_TEST_PAGE).toLowerCase() !== 'true' || mode !== 'test') return json({ error: 'Not found' }, 404, cors);
    return new Response(PAY_TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  try {
    // Stripe calls this after a payment. Must read the raw body to check the signature.
    if (p === '/pay/webhook' && request.method === 'POST') return await webhook(request, env, json);

    if (p === '/pay/account' && request.method === 'POST') {
      const b = await body(request);
      const role = b.role === 'mall' ? 'mall' : 'dealer';
      const email = clean(b.email, 120), name = clean(b.name, 80);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email.' }, 400, cors);
      // Accounts v2: a "recipient" that Tabella pays out to, with Stripe's Express dashboard.
      const meta = { role, name };
      if (clean(b.booth, 20)) meta.booth = clean(b.booth, 20);
      const acct = await stripeV2(env, 'POST', '/v2/core/accounts', {
        display_name: name || email, contact_email: email,
        identity: { country: 'US' },
        dashboard: 'express',
        defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        metadata: meta
      });
      const link = await onboardingLink(env, acct.id, String(b.returnUrl || '').replace('signup=pending', 'signup=' + acct.id), url.origin);
      return json({ account: acct.id, onboardingUrl: link.url, testMode: mode === 'test' }, 200, cors);
    }

    if (p === '/pay/onboarding-link' && request.method === 'POST') {
      const b = await body(request);
      if (!/^acct_[A-Za-z0-9]+$/.test(String(b.account || ''))) return json({ error: 'Missing account.' }, 400, cors);
      const link = await onboardingLink(env, b.account, b.returnUrl, url.origin);
      return json({ onboardingUrl: link.url }, 200, cors);
    }

    if (p === '/pay/account-status' && request.method === 'GET') {
      const id = url.searchParams.get('account') || '';
      if (!/^acct_[A-Za-z0-9]+$/.test(id)) return json({ error: 'Missing account.' }, 400, cors);
      const a = await stripeV2(env, 'GET', '/v2/core/accounts/' + id + '?include=configuration.recipient&include=requirements');
      const cap = (((((a.configuration || {}).recipient || {}).capabilities || {}).stripe_balance || {}).stripe_transfers || {});
      const needs = ((a.requirements && a.requirements.entries) || [])
        .filter(e => !e.minimum_deadline || e.minimum_deadline.status === 'currently_due' || e.minimum_deadline.status === 'past_due')
        .map(e => e.description || (e.reference && e.reference.resource) || 'information').slice(0, 10);
      return json({ account: a.id, ready: cap.status === 'active', transfers: cap.status || 'unknown', needs }, 200, cors);
    }

    if (p === '/pay/checkout' && request.method === 'POST') {
      const b = await body(request);
      const order = buildOrder(b);
      if (order.error) return json({ error: order.error }, 400, cors);
      if (mode === 'live') return json({ error: 'Live checkout must price items from Tabella inventory on the server, which is not built yet.' }, 403, cors);
      const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
      const f = {
        mode: 'payment',
        success_url: safeUrl(b.successUrl, site, url.origin) || site + '/?paid={CHECKOUT_SESSION_ID}',
        cancel_url: safeUrl(b.cancelUrl, site, url.origin) || site + '/',
        // Card rate only, so the Card processing line is right. Apple Pay and Google Pay ride on card.
        'payment_method_types[0]': 'card', 'payment_method_types[1]': 'link',
        'payment_intent_data[transfer_group]': order.group,
        'metadata[group]': order.group,
        'metadata[splits]': order.splitsMeta,
        'shipping_address_collection[allowed_countries][0]': 'US'
      };
      order.lines.forEach((l, i) => {
        f['line_items[' + i + '][quantity]'] = '1';
        f['line_items[' + i + '][price_data][currency]'] = 'usd';
        f['line_items[' + i + '][price_data][unit_amount]'] = String(l.cents);
        f['line_items[' + i + '][price_data][product_data][name]'] = l.name;
      });
      const s = await stripe(env, 'POST', '/checkout/sessions', f);
      return json({ url: s.url, session: s.id, total: order.totalCents / 100, testMode: true,
        breakdown: order.breakdown }, 200, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Stripe request failed.' }, e.status || 502, cors);
  }
}

// ---------- order math ----------
export function buildOrder(b) {
  const items = Array.isArray(b && b.items) ? b.items : [];
  if (!items.length) return { error: 'No items.' };
  if (items.length > 20) return { error: 'Too many items for one checkout.' };
  const lines = [], splits = [], breakdown = [];
  let goods = 0;
  for (const it of items) {
    const cents = Math.round(Number(it.price) * 100);
    if (!isFinite(cents) || cents < 50 || cents > 5000000) return { error: 'Each item needs a price between $0.50 and $50,000.' };
    if (!/^acct_[A-Za-z0-9]+$/.test(String(it.dealerAccount || ''))) return { error: 'Each item needs the dealer’s Stripe account.' };
    if (it.mallAccount && !/^acct_[A-Za-z0-9]+$/.test(String(it.mallAccount))) return { error: 'The mall’s Stripe account looks wrong.' };
    const commission = Math.round(cents * COMMISSION);
    const mall = it.mallAccount ? Math.round(cents * MALL_SHARE) : 0;
    const dealer = cents - commission;
    goods += cents;
    lines.push({ name: clean(it.name, 120) || 'Item', cents });
    splits.push([it.dealerAccount, dealer, it.mallAccount || '', mall]);
    breakdown.push({ name: clean(it.name, 120) || 'Item', price: cents / 100, dealer: dealer / 100, mall: mall / 100, tabella: (commission - mall) / 100 });
  }
  const ship = Math.round(Number(b.shipping || 0) * 100);
  if (!isFinite(ship) || ship < 0 || ship > 100000) return { error: 'Shipping looks wrong.' };
  if (ship) lines.push({ name: 'Shipping', cents: ship });
  // Card processing passed to the buyer, grossed up so the fee is covered on the full total.
  const pre = goods + ship, total = Math.ceil((pre + CARD_FIXED) / (1 - CARD_PCT)), fee = total - pre;
  lines.push({ name: 'Card processing', cents: fee });
  const splitsMeta = splits.map(s => s.join(':')).join(',');
  if (splitsMeta.length > 500) return { error: 'Too many dealers in one checkout. Split the order.' };
  const group = 'tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { lines, splitsMeta, group, totalCents: total, breakdown: { items: breakdown, shipping: ship / 100, cardProcessing: fee / 100, total: total / 100 } };
}

// ---------- after payment: move each share ----------
async function webhook(request, env, json) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'The STRIPE_WEBHOOK_SECRET secret is not set.' }, 500);
  const raw = await request.text();
  const ok = await verifySignature(raw, request.headers.get('Stripe-Signature') || '', env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'Bad signature.' }, 400);
  const evt = JSON.parse(raw);
  if (evt.type !== 'checkout.session.completed') return json({ ignored: evt.type }, 200);
  const s = evt.data.object;
  if (s.payment_status !== 'paid') return json({ ignored: 'not paid' }, 200);
  const pi = await stripe(env, 'GET', '/payment_intents/' + s.payment_intent);
  const charge = pi.latest_charge;
  const splits = String((s.metadata && s.metadata.splits) || '').split(',').filter(Boolean).map(x => x.split(':'));
  const done = [];
  for (let i = 0; i < splits.length; i++) {
    const [dealer, dc, mall, mc] = splits[i];
    // source_transaction ties each transfer to this charge, so it waits for the funds to be available.
    if (+dc > 0) done.push(await stripe(env, 'POST', '/transfers', { amount: dc, currency: 'usd', destination: dealer,
      transfer_group: s.metadata.group, source_transaction: charge, 'metadata[role]': 'dealer', 'metadata[session]': s.id }, s.id + '-d' + i));
    if (mall && +mc > 0) done.push(await stripe(env, 'POST', '/transfers', { amount: mc, currency: 'usd', destination: mall,
      transfer_group: s.metadata.group, source_transaction: charge, 'metadata[role]': 'mall', 'metadata[session]': s.id }, s.id + '-m' + i));
  }
  return json({ ok: true, transfers: done.map(t => t.id) }, 200);
}

export async function verifySignature(raw, header, secret, nowSec) {
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')).filter(a => a.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = header.split(',').filter(kv => kv.trim().startsWith('v1=')).map(kv => kv.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs((nowSec || Date.now() / 1000) - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + raw)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

// ---------- helpers ----------
async function onboardingLink(env, account, returnUrl, self) {
  const site = String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
  const back = safeUrl(returnUrl, site, self) || site + '/';
  // Since API 2026-09-30.endive Stripe works out which configurations need onboarding; sending them is rejected.
  return stripeV2(env, 'POST', '/v2/core/account_links', { account,
    use_case: { type: 'account_onboarding', account_onboarding: { return_url: back, refresh_url: back } } });
}

async function stripe(env, method, path, fields, idem) {
  const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY };
  let bodyStr;
  if (fields && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    bodyStr = Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  }
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(API + path, { method, headers, body: bodyStr });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Stripe said: ' + ((data.error && data.error.message) || res.status)); e.status = 502; throw e; }
  return data;
}

const V2_VERSION = '2026-11-18.endive';
async function stripeV2(env, method, path, obj) {
  const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': V2_VERSION };
  if (obj) headers['Content-Type'] = 'application/json';
  const res = await fetch('https://api.stripe.com' + path, { method, headers, body: obj ? JSON.stringify(obj) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('Stripe said: ' + ((data.error && data.error.message) || res.status)); e.status = 502; throw e; }
  return data;
}

async function body(request) { try { return await request.json(); } catch (e) { return {}; } }
function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }
function safeUrl(u, site, self) {
  try { const x = new URL(String(u || '')); const allowed = new URL(site); return (x.origin === allowed.origin || x.origin === self || x.origin === 'https://www.' + allowed.host || x.origin.endsWith('.claudeusercontent.com')) ? x.href : ''; }
  catch (e) { return ''; }
}

const PAY_TEST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tabella payments test</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#1E2430}
fieldset{border:1px solid #ccc;border-radius:10px;margin:0 0 14px;padding:10px 12px}label{display:block;margin:6px 0;font-size:14px}
input,select{font:inherit;width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:8px}
button{font:inherit;font-weight:600;padding:10px 16px;border-radius:10px;border:0;background:#2A4A7F;color:#fff;min-height:44px;margin-top:6px}
.out{background:#f4f1ea;border-radius:8px;padding:8px 10px;margin-top:8px;white-space:pre-wrap;font-size:14px}.err{color:#B23A2E}</style></head>
<body><h1>Tabella payments test</h1><p>Sandbox only. No real money moves. Test card: 4242 4242 4242 4242, any future date, any CVC, any ZIP.</p>
<fieldset><legend>1. Sign up a test dealer or mall</legend>
<label>Role<select id="role"><option value="dealer">Dealer</option><option value="mall">Mall</option></select></label>
<label>Name<input id="name" value="Test Dealer"></label><label>Email<input id="email" value="dealer@example.com"></label>
<button id="mk">Create and open Stripe sign-up</button><div id="o1" class="out" hidden></div>
<p style="font-size:14px">On Stripe's test sign-up page, use the test shortcuts it offers (test phone code 000-000, test bank account) to finish fast.</p></fieldset>
<fieldset><legend>2. Check a sign-up</legend><label>Stripe account (acct_...)<input id="acct"></label><button id="st">Check</button><div id="o2" class="out" hidden></div></fieldset>
<fieldset><legend>3. Buy an item</legend><label>Item<input id="item" value="Hobnail milk glass basket"></label><label>Price ($)<input id="price" type="number" step="0.01" value="80"></label>
<label>Dealer account (acct_...)<input id="da"></label><label>Mall account, optional (acct_...)<input id="ma"></label><label>Shipping ($)<input id="ship" type="number" step="0.01" value="12.50"></label>
<button id="buy">Go to checkout</button><div id="o3" class="out" hidden></div></fieldset>
<script>
function $(i){return document.getElementById(i)}
async function call(p,b){var r=await fetch(p,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:{});var d=await r.json();if(!r.ok)throw new Error(d.error||r.status);return d}
function show(id,t,bad){var o=$(id);o.hidden=false;o.className='out'+(bad?' err':'');o.textContent=t}
var back=location.href.split('?')[0];
$('mk').onclick=async function(){try{var d=await call('/pay/account',{role:$('role').value,name:$('name').value,email:$('email').value,returnUrl:back+'?signup=pending'});
  show('o1','Created '+d.account+'. Opening Stripe sign-up...');$('acct').value=d.account;if($('role').value==='mall')$('ma').value=d.account;else $('da').value=d.account;window.open(d.onboardingUrl,'_blank')}catch(e){show('o1',e.message,1)}};
$('st').onclick=async function(){try{var d=await call('/pay/account-status?account='+encodeURIComponent($('acct').value.trim()));
  show('o2',(d.ready?'Ready to be paid.':'Not finished yet.')+(d.needs.length?' Still needs: '+d.needs.join(', '):''))}catch(e){show('o2',e.message,1)}};
$('buy').onclick=async function(){try{var d=await call('/pay/checkout',{items:[{name:$('item').value,price:+$('price').value,dealerAccount:$('da').value.trim(),mallAccount:$('ma').value.trim()||undefined}],shipping:+$('ship').value||0,successUrl:back+'?paid=1',cancelUrl:back});
  var b=d.breakdown,i=b.items[0];show('o3','Total $'+b.total.toFixed(2)+' (item $'+i.price.toFixed(2)+', shipping $'+b.shipping.toFixed(2)+', card processing $'+b.cardProcessing.toFixed(2)+').\\nAfter payment: dealer $'+i.dealer.toFixed(2)+', mall $'+i.mall.toFixed(2)+', Tabella $'+i.tabella.toFixed(2)+'.\\nOpening Stripe checkout...');window.open(d.url,'_blank')}catch(e){show('o3',e.message,1)}};
if(location.search.indexOf('paid=1')>=0)show('o3','Payment done. In Stripe, check Connect > Transfers to see the dealer and mall shares.');
if(location.search.indexOf('signup=')>=0){var a=decodeURIComponent(location.search.split('signup=')[1].split('&')[0]);$('acct').value=a;$('da').value=a;show('o1','Back from Stripe sign-up for '+a+'. Click Check in box 2.')}
</script></body></html>`;
