// What malls pay Tabella: one transparent price per booth, the same for every mall, everything included.
//
//   Booths 1-30 $1.80 each a month, booths 31-60 $1.10, every booth after 60 $0.70 (graduated, like tax brackets).
//   Yearly plan: 10 months' price for 12 months.
//
// Timeline from the day the mall signs up:
//   months 1-3   free, no card asked for
//   months 4-6   still free, with a card on file (asked for by the end of month 3)
//   decision day 7 days before the first charge: the mall gets a reminder and the date is on its calendar,
//                so it can keep going, switch plans or cancel and pay nothing
//   first charge the end of month 6, then monthly (or yearly)
//
// Nothing turns off by itself. A missing card or a failed payment sends warnings to the mall and to Tabella, and the
// mall keeps working while we sort it out. Only Tabella can pause a mall, by hand, from the ops page (ADMIN_KEY).
// A paused mall can still see its reports and statements, so it can settle up with its dealers; the register stops.
//
// The mall can add the Tabella booth fee to each booth's rent (its monthly bill split evenly across booths), so the
// dealers cover it. The fee starts in the month of the first charge.
//
// Storage (TABELLA KV):
//   mbill:<mall>          { plan, customer, subscription, item, status, cancelAt, cardAt, failedAt, failures, off, offAt, offNote, sent:{} }
//   mbillcus:<customer>   customer -> mall id (for invoice webhooks)
//   billing:prices:<mode>:<version>   the Stripe product and prices for the current rates
//
// Stripe webhook events to turn on for this: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.

import { stripeApi, stripeMode } from './stripe.js';
import { sendEmail, emailFrame, opsEmail } from './mail.js';

export const RATES = [[30, 180], [60, 110], [Infinity, 70]]; // [up to booth n, cents per booth per month]
export const YEAR_MONTHS = 10; // the yearly plan costs 10 months
const RATE_VERSION = 'v1-180-110-70';
const DAY = 86400000;
const FREE_NO_CARD_MONTHS = 3, FREE_MONTHS = 6, DECIDE_DAYS_BEFORE = 7;

export function monthlyCents(n) {
  let left = Math.max(0, n | 0), prev = 0, c = 0;
  for (const [upTo, cents] of RATES) { const k = Math.min(left, upTo - prev); c += k * cents; left -= k; prev = upTo; if (!left) break; }
  return c;
}
export function yearlyCents(n) { return monthlyCents(n) * YEAR_MONTHS; }

function addMonths(t, n) { const d = new Date(t); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.getTime(); }
export function timeline(m) {
  const start = m.created || Date.now(), firstCharge = addMonths(start, FREE_MONTHS);
  return { start, cardBy: addMonths(start, FREE_NO_CARD_MONTHS), decision: firstCharge - DECIDE_DAYS_BEFORE * DAY, firstCharge };
}
const ym = t => new Date(t).toISOString().slice(0, 7);
const dstr = t => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const usd = c => '$' + (c / 100).toFixed(2);

async function getBill(env, id) { return JSON.parse(await env.TABELLA.get('mbill:' + id) || 'null') || { plan: 'month', sent: {} }; }
async function putBill(env, id, b) { await env.TABELLA.put('mbill:' + id, JSON.stringify(b)); }
export async function boothCount(env, mid) {
  let n = 0, cursor;
  do { const l = await env.TABELLA.list({ prefix: 'booth:' + mid + ':', cursor }); n += l.keys.length; cursor = l.list_complete ? null : l.cursor; } while (cursor);
  return n;
}

export function statusOf(m, b, now) {
  now = now || Date.now();
  if (b.off) return 'off';
  if (b.subscription) return b.status || 'trialing'; // trialing, active, past_due, unpaid, canceled
  if (b.status === 'canceled') return 'canceled';
  return now < timeline(m).cardBy ? 'free' : 'card_due';
}
// Is the register allowed to take a sale? Only a mall Tabella paused by hand is stopped.
export async function mallPaused(env, m) { const b = await getBill(env, m.id); return b.off ? (b.offNote || 'Your Tabella account is paused.') : null; }

// The Tabella booth fee added to each booth's rent for a month, when the mall chose to pass it on. Free months are $0.
export async function boothFee(env, m, month, nBooths) {
  if (!m.feeInRent) return 0;
  const b = await getBill(env, m.id), st = statusOf(m, b);
  if (st === 'canceled' || st === 'off') return 0;
  if (month < ym(timeline(m).firstCharge)) return 0;
  const n = nBooths != null ? nBooths : await boothCount(env, m.id);
  if (!n) return 0;
  const monthCost = b.plan === 'year' ? yearlyCents(n) / 12 : monthlyCents(n);
  return Math.ceil(monthCost / n);
}

export async function billingView(env, m) {
  const b = await getBill(env, m.id), n = await boothCount(env, m.id), tl = timeline(m), billed = Math.max(1, n);
  return { status: statusOf(m, b), plan: b.plan || 'month', booths: n, monthly: monthlyCents(billed), yearly: yearlyCents(billed),
    perBooth: Math.ceil(monthlyCents(billed) / billed), rates: RATES.map(([u, c]) => [u === Infinity ? null : u, c]), yearMonths: YEAR_MONTHS,
    cardBy: tl.cardBy, decision: tl.decision, firstCharge: tl.firstCharge, hasCard: !!b.subscription && b.status !== 'canceled', cancelAt: b.cancelAt || null,
    failedAt: b.failedAt || null, offNote: b.off ? b.offNote || '' : null, feeInRent: !!m.feeInRent, feeNow: await boothFee(env, Object.assign({}, m, { feeInRent: true }), ym(Math.max(Date.now(), tl.firstCharge)), n),
    mode: stripeMode(env) };
}

async function prices(env) {
  const key = 'billing:prices:' + stripeMode(env) + ':' + RATE_VERSION;
  const have = JSON.parse(await env.TABELLA.get(key) || 'null'); if (have) return have;
  const prod = await stripeApi(env, 'POST', '/products', { name: 'Tabella for malls', 'metadata[rates]': RATE_VERSION }, 'prod-' + RATE_VERSION);
  const mk = async (interval, mult) => {
    const f = { currency: 'usd', product: prod.id, 'recurring[interval]': interval, billing_scheme: 'tiered', tiers_mode: 'graduated', nickname: interval === 'year' ? 'Yearly, per booth' : 'Monthly, per booth' };
    RATES.forEach(([u, c], i) => { f['tiers[' + i + '][up_to]'] = u === Infinity ? 'inf' : String(u); f['tiers[' + i + '][unit_amount]'] = String(c * mult); });
    return (await stripeApi(env, 'POST', '/prices', f, 'price-' + interval + '-' + RATE_VERSION)).id;
  };
  const out = { product: prod.id, month: await mk('month', 1), year: await mk('year', YEAR_MONTHS) };
  await env.TABELLA.put(key, JSON.stringify(out));
  return out;
}
const site = env => String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
function bad(status, message) { const e = new Error(message); e.status = status; return e; }

// Add a card: Stripe Checkout starts the plan with no charge until the first charge date.
async function addCard(env, m, body) {
  const b = await getBill(env, m.id);
  if (b.subscription && b.status !== 'canceled') throw bad(400, 'A card is already on file. Use Update card to change it.');
  const plan = body.plan === 'year' ? 'year' : 'month', pr = await prices(env), n = Math.max(1, await boothCount(env, m.id));
  const tl = timeline(m), trialEnd = Math.floor(tl.firstCharge / 1000);
  const f = { mode: 'subscription', customer_email: m.email, 'line_items[0][price]': pr[plan], 'line_items[0][quantity]': String(n),
    payment_method_collection: 'always', 'metadata[kind]': 'mallbill', 'metadata[mall]': m.id, 'subscription_data[metadata][mall]': m.id,
    success_url: site(env) + '/mall/?billing=done', cancel_url: site(env) + '/mall/?billing=back' };
  if (b.customer) { delete f.customer_email; f.customer = b.customer; }
  if (trialEnd > Date.now() / 1000 + 2 * 86400) f['subscription_data[trial_end]'] = String(trialEnd); // Stripe needs 48 hours' notice
  b.plan = plan; await putBill(env, m.id, b);
  const s = await stripeApi(env, 'POST', '/checkout/sessions', f);
  return { url: s.url };
}
async function setPlan(env, m, body) {
  const plan = body.plan === 'year' ? 'year' : 'month', b = await getBill(env, m.id);
  if (b.subscription && b.status !== 'canceled' && b.plan !== plan) {
    const pr = await prices(env), trial = b.status === 'trialing';
    await stripeApi(env, 'POST', '/subscriptions/' + b.subscription, { 'items[0][id]': b.item, 'items[0][price]': pr[plan], proration_behavior: trial ? 'none' : 'create_prorations' });
  }
  b.plan = plan; await putBill(env, m.id, b);
  return billingView(env, m);
}
async function cancel(env, m) {
  const b = await getBill(env, m.id);
  if (!b.subscription || b.status === 'canceled') throw bad(400, 'There is no plan to cancel.');
  if (b.status === 'trialing') { await stripeApi(env, 'DELETE', '/subscriptions/' + b.subscription); b.status = 'canceled'; b.cancelAt = null; }
  else { const s = await stripeApi(env, 'POST', '/subscriptions/' + b.subscription, { cancel_at_period_end: 'true' }); b.cancelAt = periodEnd(s); }
  await putBill(env, m.id, b);
  await sendEmail(env, { to: opsEmail(env), subject: tag(env) + m.name + ' canceled its Tabella plan', html: emailFrame('Plan canceled', '<p>' + h(m.name) + ' (' + h(m.city) + ', ' + h(m.state) + ') canceled' + (b.cancelAt ? ', ending ' + dstr(b.cancelAt * 1000) : ' before its first charge') + '. Worth a call to ask what we could fix.</p>'), text: m.name + ' canceled its Tabella plan.' }).catch(() => null);
  return billingView(env, m);
}
async function resume(env, m) {
  const b = await getBill(env, m.id);
  if (!b.subscription || !b.cancelAt || b.status === 'canceled') throw bad(400, 'There is nothing to undo.');
  await stripeApi(env, 'POST', '/subscriptions/' + b.subscription, { cancel_at_period_end: 'false' }); b.cancelAt = null; await putBill(env, m.id, b);
  return billingView(env, m);
}
async function portal(env, m) {
  const b = await getBill(env, m.id);
  if (!b.customer) throw bad(400, 'Add a card first.');
  try { return { url: (await stripeApi(env, 'POST', '/billing_portal/sessions', { customer: b.customer, return_url: site(env) + '/mall/?billing=back' })).url }; }
  catch (e) { throw bad(502, 'Updating the card isn’t open yet. Write to contact@tabellasuite.com and we’ll help.'); }
}
function periodEnd(s) { return s.cancel_at || s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end) || null; }

export async function handleBilling(env, m, p, method, body) {
  if (p === '/mall/billing' && method === 'GET') return billingView(env, m);
  if (p === '/mall/billing' && method === 'PUT') return setPlan(env, m, await body());
  if (p === '/mall/billing/card' && method === 'POST') return addCard(env, m, await body());
  if (p === '/mall/billing/update-card' && method === 'POST') return portal(env, m);
  if (p === '/mall/billing/cancel' && method === 'POST') return cancel(env, m);
  if (p === '/mall/billing/resume' && method === 'POST') return resume(env, m);
  return null;
}

// ---------- Stripe webhooks ----------
export function isBillingEvent(evt) {
  const o = evt.data && evt.data.object || {};
  if (evt.type === 'checkout.session.completed') return o.mode === 'subscription' && o.metadata && o.metadata.kind === 'mallbill';
  return /^customer\.subscription\./.test(evt.type) || evt.type === 'invoice.paid' || evt.type === 'invoice.payment_failed';
}
export async function billingWebhook(env, evt) {
  const o = evt.data.object;
  let mid = (o.metadata && o.metadata.mall) || (o.customer && await env.TABELLA.get('mbillcus:' + o.customer));
  if (!mid && o.subscription_details && o.subscription_details.metadata) mid = o.subscription_details.metadata.mall;
  if (!mid && o.parent && o.parent.subscription_details && o.parent.subscription_details.metadata) mid = o.parent.subscription_details.metadata.mall;
  const m = mid && JSON.parse(await env.TABELLA.get('mall:' + mid) || 'null');
  if (!m) return { ignored: 'no mall' };
  const b = await getBill(env, m.id);

  if (evt.type === 'checkout.session.completed') {
    b.customer = o.customer; b.subscription = o.subscription; b.cardAt = Date.now(); b.status = 'trialing'; b.cancelAt = null;
    if (o.customer) await env.TABELLA.put('mbillcus:' + o.customer, m.id);
    try { const s = await stripeApi(env, 'GET', '/subscriptions/' + o.subscription); syncSub(b, s); } catch (e) {}
    await putBill(env, m.id, b);
    const tl = timeline(m), v = await billingView(env, m);
    const paras = ['Thanks. Your card is on file and nothing is charged yet.',
      'Decision date: ' + dstr(tl.decision) + '. We’ll email you that day. Keep going, switch plans, or cancel in Settings and you pay nothing.',
      'First charge: ' + dstr(tl.firstCharge) + ', ' + (b.plan === 'year' ? usd(v.yearly) + ' for the year' : usd(v.monthly) + ' a month') + ' for ' + v.booths + ' booth' + (v.booths === 1 ? '' : 's') + ' at today’s count.',
      'Add the decision date to your calendar: ' + calendarLink(m, tl)];
    await mailMall(env, m, 'Your card is on file. Nothing is charged until ' + dstr(tl.firstCharge), paras);
    return { ok: true, billing: 'card' };
  }
  if (/^customer\.subscription\./.test(evt.type)) {
    if (b.subscription && o.id !== b.subscription) return { ignored: 'old plan' };
    syncSub(b, o);
    if (evt.type === 'customer.subscription.deleted') { b.status = 'canceled'; b.cancelAt = null; }
    await putBill(env, m.id, b);
    return { ok: true, status: b.status };
  }
  if (evt.type === 'invoice.paid') {
    if (!(o.amount_paid > 0)) return { ok: true, zero: true };
    const wasLate = b.status === 'past_due' || b.status === 'unpaid';
    b.status = 'active'; b.failedAt = null; b.failures = 0; b.sent = Object.assign({}, b.sent, { late7: 0, late14: 0 }); await putBill(env, m.id, b);
    if (wasLate) await mailOps(env, m.name + ' paid', [m.name + ' paid its late Tabella invoice (' + usd(o.amount_paid) + ').' + (b.off ? ' It is still paused: turn it back on from the ops page.' : '')]);
    return { ok: true, paid: o.amount_paid };
  }
  if (evt.type === 'invoice.payment_failed') {
    b.status = 'past_due'; b.failures = (b.failures || 0) + 1; if (!b.failedAt) b.failedAt = Date.now(); await putBill(env, m.id, b);
    if (b.failures === 1) {
      await mailMall(env, m, 'Your Tabella payment didn’t go through', ['We couldn’t charge your card for ' + usd(o.amount_due || 0) + '.',
        'Everything keeps working while we sort it out. Update your card in Settings > Tabella plan at tabellasuite.com/mall/, or reply and we’ll help.']);
      await mailOps(env, 'Payment failed: ' + m.name, [m.name + ' (' + m.email + ') payment of ' + usd(o.amount_due || 0) + ' failed. The mall keeps working. Reach out.']);
    }
    return { ok: true, failed: b.failures };
  }
  return { ignored: evt.type };
}
function syncSub(b, s) {
  if (!s || !s.id) return;
  b.subscription = s.id; if (s.customer) b.customer = s.customer;
  if (s.status) b.status = s.status;
  b.cancelAt = s.cancel_at_period_end ? periodEnd(s) : null;
  const it = s.items && s.items.data && s.items.data[0];
  if (it) { b.item = it.id; b.qty = it.quantity; if (it.price && it.price.recurring) b.plan = it.price.recurring.interval === 'year' ? 'year' : 'month'; }
}

// ---------- the daily check (cron) ----------
// Keeps each plan's booth count current and sends each warning once. It never turns a mall off.
export async function billingDaily(env, now) {
  if (!env.TABELLA) return [];
  now = now || Date.now();
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'mall:', cursor });
    for (const k of l.keys) {
      const m = JSON.parse(await env.TABELLA.get(k.name) || 'null'); if (!m || !m.id) continue;
      try { out.push(await checkMall(env, m, now)); } catch (e) { out.push({ mall: m.id, error: String(e.message).slice(0, 120) }); }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
async function checkMall(env, m, now) {
  const b = await getBill(env, m.id); b.sent = b.sent || {};
  const tl = timeline(m), st = statusOf(m, b, now), n = await boothCount(env, m.id), did = [];
  const once = async (flag, fn) => { if (b.sent[flag]) return; await fn(); b.sent[flag] = now; did.push(flag); };

  if (b.subscription && b.item && ['trialing', 'active', 'past_due'].includes(b.status) && Math.max(1, n) !== b.qty) {
    await stripeApi(env, 'POST', '/subscriptions/' + b.subscription, { 'items[0][id]': b.item, 'items[0][quantity]': String(Math.max(1, n)), proration_behavior: 'none' });
    b.qty = Math.max(1, n); did.push('qty ' + b.qty);
  }
  const price = (b.plan === 'year' ? usd(yearlyCents(Math.max(1, n))) + ' a year' : usd(monthlyCents(Math.max(1, n))) + ' a month') + ' for ' + n + ' booth' + (n === 1 ? '' : 's');
  if (st === 'free' && now >= tl.cardBy - 14 * DAY) await once('card14', () => mailMall(env, m, 'Your next 3 months are free too. Add a card by ' + dstr(tl.cardBy), [
    'Your first 3 months of Tabella are almost up. The next 3 are free as well: we just ask for a card by ' + dstr(tl.cardBy) + '.',
    'Nothing is charged until ' + dstr(tl.firstCharge) + ', and you’ll get a decision date a week before that. Cancel by then and you pay nothing.',
    'Add it in Settings > Tabella plan at tabellasuite.com/mall/.']));
  if (st === 'card_due') {
    await once('card0', async () => {
      await mailMall(env, m, 'Please add a card to keep Tabella going', ['We don’t have a card for ' + m.name + ' yet. Everything keeps working, and nothing is charged until ' + dstr(tl.firstCharge) + '.', 'Add it in Settings > Tabella plan at tabellasuite.com/mall/, or reply with any questions.']);
      await mailOps(env, 'No card yet: ' + m.name, [m.name + ' (' + m.email + ') has no card on file after 3 free months. Reach out.']);
    });
    if (now >= tl.cardBy + 14 * DAY) await once('card14late', () => mailOps(env, 'Still no card: ' + m.name, [m.name + ' (' + m.email + ') still has no card, 2 weeks after it was due. It keeps working. Call them, then pause it from the ops page if needed.']));
  }
  if (st === 'trialing' && now >= tl.decision && now < tl.firstCharge + DAY) await once('decide', () => mailMall(env, m, 'Decision day: your first Tabella charge is ' + dstr(tl.firstCharge), [
    'Your 6 free months end on ' + dstr(tl.firstCharge) + '. That day we’ll charge ' + price + '.',
    'Happy with it? Do nothing. Want to save 2 months? Switch to yearly. Not for you? Cancel in Settings > Tabella plan and you pay nothing.',
    'And tell us what to fix. Just reply.']));
  if ((st === 'past_due' || st === 'unpaid') && b.failedAt) {
    if (now >= b.failedAt + 7 * DAY) await once('late7', async () => {
      await mailMall(env, m, 'Your Tabella payment is a week late', ['We still can’t charge your card. Everything keeps working. Please update your card in Settings > Tabella plan, or reply and we’ll help.']);
      await mailOps(env, 'A week late: ' + m.name, [m.name + ' (' + m.email + ') is a week past due. Reach out.']);
    });
    if (now >= b.failedAt + 14 * DAY) await once('late14', () => mailOps(env, 'Two weeks late: ' + m.name, [m.name + ' (' + m.email + ') is 2 weeks past due and still running. Call them; pause it from the ops page if that’s the call.']));
  }
  if (did.length) await putBill(env, m.id, b);
  return { mall: m.id, status: st, did };
}

// ---------- Tabella's ops page (ADMIN_KEY) ----------
export async function opsList(env) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix: 'mall:', cursor });
    for (const k of l.keys) {
      const m = JSON.parse(await env.TABELLA.get(k.name) || 'null'); if (!m || !m.id) continue;
      const b = await getBill(env, m.id), n = await boothCount(env, m.id), tl = timeline(m);
      out.push({ id: m.id, name: m.name, city: m.city, state: m.state, email: m.email, created: m.created, booths: n, plan: b.plan || 'month', status: statusOf(m, b),
        monthly: monthlyCents(Math.max(1, n)), cardBy: tl.cardBy, firstCharge: tl.firstCharge, failedAt: b.failedAt || null, off: !!b.off, offNote: b.offNote || '', warnings: Object.keys(b.sent || {}).filter(k => b.sent[k]) });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.created || 0) - (b.created || 0));
}
export async function opsSetOff(env, id, body) {
  const m = JSON.parse(await env.TABELLA.get('mall:' + id) || 'null'); if (!m) throw bad(404, 'No such mall.');
  const b = await getBill(env, id);
  if (body.off) { b.off = true; b.offAt = Date.now(); b.offNote = String(body.note || 'Your Tabella account is paused. Write to contact@tabellasuite.com to turn it back on.').replace(/[<>\u0000-\u001f]/g, ' ').slice(0, 200); }
  else { b.off = false; b.offAt = null; b.offNote = ''; }
  await putBill(env, id, b);
  return { ok: true, off: b.off };
}

// ---------- helpers ----------
export function calendarLink(m, tl) {
  const d = new Date(tl.decision).toISOString().slice(0, 10).replace(/-/g, ''), e = new Date(tl.decision + DAY).toISOString().slice(0, 10).replace(/-/g, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent('Tabella decision day for ' + m.name) + '&dates=' + d + '/' + e +
    '&details=' + encodeURIComponent('First Tabella charge is ' + dstr(tl.firstCharge) + '. Keep going, switch plans or cancel at tabellasuite.com/mall/ (Settings > Tabella plan).');
}
const tag = env => stripeMode(env) === 'test' ? '[Test] ' : '';
function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function linkify(p) { return h(p).replace(/(https:\/\/[^\s]+)/g, u => '<a href="' + u + '">' + (u.includes('calendar.google') ? 'Add to Google Calendar' : u) + '</a>'); }
async function mailMall(env, m, subject, paras) {
  return sendEmail(env, { to: m.email, subject: tag(env) + subject, html: emailFrame(subject, paras.map(p => '<p style="margin:0 0 12px">' + linkify(p) + '</p>').join('')), text: paras.join('\n\n') }).catch(() => null);
}
async function mailOps(env, subject, paras) {
  return sendEmail(env, { to: opsEmail(env), subject: tag(env) + 'Billing: ' + subject, html: emailFrame(subject, paras.map(p => '<p style="margin:0 0 12px">' + h(p) + '</p>').join('')), text: paras.join('\n\n') }).catch(() => null);
}
