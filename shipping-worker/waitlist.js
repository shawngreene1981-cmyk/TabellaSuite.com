// Booth waitlists: a dealer looking for a booth asks to be on a Tabella mall's waitlist. The mall sees their
// Tabella shop (pieces and prices) before saying yes, and can invite them with its join code or take them off.
//
// Storage (TABELLA KV):
//   mwl:<mall>:<dealer>   { at, note, status: 'waiting' | 'invited', invitedAt }
//   dwl:<dealer>:<mall>   same entry, for the dealer's own list
//
// Dealer routes (dealer session): GET /app/malls?q=  GET /app/waitlist  POST /app/waitlist {mall, note}  DELETE /app/waitlist/<mall>
// Mall routes (mall session):     GET /mall/waitlist  POST /mall/waitlist/<dealer>/invite {note}  POST /mall/waitlist/<dealer>/remove

import { session as dealerSession, clean, err, body } from './app.js';
import { mallSession } from './mall.js';
import { sendEmail, emailFrame } from './mail.js';
import { mallInsights } from './insights.js';

const MAX_LISTS = 10;
const site = env => String(env.SITE_URL || 'https://tabellasuite.com').replace(/\/$/, '');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function handleWaitlist(request, env, url, json, cors) {
  const p = url.pathname;
  const dealerSide = p === '/app/malls' || p.startsWith('/app/waitlist');
  const mallSide = p.startsWith('/mall/waitlist') || p === '/mall/insights';
  if (!dealerSide && !mallSide) return null;
  if (!env.TABELLA) return json({ error: 'The TABELLA store is not set up yet.' }, 500, cors);
  try {
    if (dealerSide) {
      const me = await dealerSession(env, request);
      if (!me) return json({ error: 'Please sign in again.', signin: true }, 401, cors);
      const d = me.dealer;
      if (p === '/app/malls' && request.method === 'GET') return json({ malls: await findMalls(env, d, url.searchParams.get('q')) }, 200, cors);
      if (p === '/app/waitlist' && request.method === 'GET') return json({ lists: await dealerLists(env, d) }, 200, cors);
      if (p === '/app/waitlist' && request.method === 'POST') return json(await joinList(env, d, await body(request)), 200, cors);
      const m = p.match(/^\/app\/waitlist\/(m[a-z0-9]{10})$/);
      if (m && request.method === 'DELETE') { await drop(env, m[1], d.id); return json({ lists: await dealerLists(env, d) }, 200, cors); }
      return json({ error: 'Not found' }, 404, cors);
    }
    const ms = await mallSession(env, request);
    if (!ms) return json({ error: 'Please sign in again.', signin: true }, 401, cors);
    const mall = ms.mall;
    if (p === '/mall/insights' && request.method === 'GET') return json(await mallInsights(env, mall, url.searchParams.get('days')), 200, cors);
    if (p === '/mall/waitlist' && request.method === 'GET') return json({ waitlist: await mallList(env, mall) }, 200, cors);
    const m = p.match(/^\/mall\/waitlist\/(d[a-z0-9]{10})\/(invite|remove)$/);
    if (m && request.method === 'POST') {
      if (m[2] === 'remove') await drop(env, mall.id, m[1]);
      const emailed = m[2] === 'invite' ? await invite(env, mall, m[1], await body(request)) : undefined;
      return json({ waitlist: await mallList(env, mall), emailed }, 200, cors);
    }
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

async function listAll(env, prefix) {
  const out = []; let cursor;
  do {
    const l = await env.TABELLA.list({ prefix, cursor });
    const vals = await Promise.all(l.keys.map(k => env.TABELLA.get(k.name)));
    l.keys.forEach((k, i) => { if (vals[i]) out.push([k.name, JSON.parse(vals[i])]); });
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}
async function count(env, prefix) {
  let n = 0, cursor;
  do { const l = await env.TABELLA.list({ prefix, cursor }); n += l.keys.length; cursor = l.list_complete ? null : l.cursor; } while (cursor);
  return n;
}

// Tabella malls a dealer can ask to join. Only the name and town are shown; the street address stays private.
async function findMalls(env, d, q) {
  q = clean(q, 60).toLowerCase();
  const mine = new Set((await listAll(env, 'dwl:' + d.id + ':')).map(([k]) => k.split(':')[2]));
  const out = [];
  for (const [, m] of await listAll(env, 'mall:')) {
    if (!m || !m.id || m.hidden) continue;
    const hay = (m.name + ' ' + m.city + ' ' + m.state).toLowerCase();
    if (q && !q.split(/\s+/).every(w => hay.includes(w))) continue;
    out.push({ id: m.id, name: m.name, city: m.city, state: m.state, booths: await count(env, 'booth:' + m.id + ':'), waiting: mine.has(m.id), yours: !!(d.mall && d.mall.id === m.id) });
    if (out.length >= 40) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
async function dealerLists(env, d) {
  const out = [];
  for (const [k, w] of await listAll(env, 'dwl:' + d.id + ':')) {
    const m = JSON.parse(await env.TABELLA.get('mall:' + k.split(':')[2]) || 'null');
    if (!m) { await env.TABELLA.delete(k); continue; }
    out.push({ mall: m.id, name: m.name, city: m.city, state: m.state, at: w.at, note: w.note || '', status: w.status, invitedAt: w.invitedAt || null, code: w.status === 'invited' ? m.code : undefined });
  }
  return out.sort((a, b) => b.at - a.at);
}
async function joinList(env, d, b) {
  const mid = String(b.mall || '');
  if (!/^m[a-z0-9]{10}$/.test(mid)) throw err(400, 'Pick a mall.');
  const m = JSON.parse(await env.TABELLA.get('mall:' + mid) || 'null');
  if (!m) throw err(404, 'That mall isn’t on Tabella.');
  if (d.mall && d.mall.id === mid) throw err(400, 'You already have a booth in ' + m.name + '.');
  if (await env.TABELLA.get('dwl:' + d.id + ':' + mid)) throw err(400, 'You’re already on ' + m.name + '’s waitlist.');
  if ((await count(env, 'dwl:' + d.id + ':')) >= MAX_LISTS) throw err(400, 'You can be on up to ' + MAX_LISTS + ' waitlists at once. Leave one first.');
  const w = { at: Date.now(), note: clean(b.note, 300), status: 'waiting' };
  await env.TABELLA.put('mwl:' + mid + ':' + d.id, JSON.stringify(w));
  await env.TABELLA.put('dwl:' + d.id + ':' + mid, JSON.stringify(w));
  const pieces = (await listAll(env, 'item:' + d.id + ':')).filter(([, it]) => it.status === 'available').length;
  const paras = [d.name + ' would like a booth at ' + m.name + '. They have ' + pieces + ' piece' + (pieces === 1 ? '' : 's') + ' in their Tabella shop.',
    w.note ? 'Their note: "' + w.note + '"' : '',
    'See their pieces and prices: ' + site(env) + '/shop/?dealer=' + d.id,
    'Invite them or take them off the list on the Dealers tab at ' + site(env) + '/mall/.'].filter(Boolean);
  await sendEmail(env, { to: m.email, subject: d.name + ' wants a booth at ' + m.name, html: emailFrame('A dealer wants a booth', paras.map(p => '<p style="margin:0 0 12px">' + esc(p).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>') + '</p>').join('')), text: paras.join('\n\n') }).catch(() => null);
  return { lists: await dealerLists(env, d) };
}
async function drop(env, mid, did) {
  await env.TABELLA.delete('mwl:' + mid + ':' + did);
  await env.TABELLA.delete('dwl:' + did + ':' + mid);
}
// Called when a dealer joins a mall: they're off that mall's waitlist.
export async function joinedMall(env, mid, did) { await drop(env, mid, did); }

async function mallList(env, m) {
  const out = [];
  for (const [k, w] of await listAll(env, 'mwl:' + m.id + ':')) {
    const did = k.split(':')[2], d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
    if (!d) { await drop(env, m.id, did); continue; }
    const items = (await listAll(env, 'item:' + did + ':')).map(([, it]) => it);
    const avail = items.filter(it => it.status === 'available'), prices = avail.map(it => Number(it.price) || 0).filter(Boolean).sort((a, b) => a - b);
    const cats = {}; avail.forEach(it => { cats[it.category || 'Other'] = (cats[it.category || 'Other'] || 0) + 1; });
    out.push({ dealer: did, name: d.name, at: w.at, note: w.note || '', status: w.status, invitedAt: w.invitedAt || null, shop: '/shop/?dealer=' + did,
      pieces: avail.length, sold: items.filter(it => it.status === 'sold').length, low: prices[0] || 0, high: prices[prices.length - 1] || 0,
      median: prices.length ? prices[Math.floor(prices.length / 2)] : 0,
      categories: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => c + ' (' + n + ')'),
      photo: (avail.find(it => it.photos && it.photos[0]) || {}).photos ? avail.find(it => it.photos && it.photos[0]).photos[0] : null,
      elsewhere: d.mall && d.mall.id !== m.id ? d.mall.name : null });
  }
  return out.sort((a, b) => a.at - b.at);
}
async function invite(env, m, did, b) {
  const w = JSON.parse(await env.TABELLA.get('mwl:' + m.id + ':' + did) || 'null');
  if (!w) throw err(404, 'That dealer isn’t on your waitlist.');
  const d = JSON.parse(await env.TABELLA.get('dealer:' + did) || 'null');
  if (!d || !d.email) throw err(404, 'That dealer’s account is gone.');
  w.status = 'invited'; w.invitedAt = Date.now();
  await env.TABELLA.put('mwl:' + m.id + ':' + did, JSON.stringify(w));
  await env.TABELLA.put('dwl:' + did + ':' + m.id, JSON.stringify(w));
  const note = clean(b.note, 400);
  const paras = ['Good news: ' + m.name + ' in ' + m.city + ', ' + m.state + ' has a booth for you.',
    note ? 'From ' + m.name + ': "' + note + '"' : '',
    'Reply to this email to set up a time with them. When you’re ready, open the Tabella dealer app, go to Your mall, and enter join code ' + m.code + ' with your booth number.',
    site(env) + '/dealer/'].filter(Boolean);
  const r = await sendEmail(env, { to: d.email, replyTo: m.email, subject: m.name + ' has a booth for you', html: emailFrame('A booth for you', paras.map(p => '<p style="margin:0 0 12px">' + esc(p).replace(/(https:\/\/\S+)/g, '<a href="$1">$1</a>') + '</p>').join('')), text: paras.join('\n\n') });
  return !!(r && !r.skipped && !r.error); // either way they see the invite and join code in their dealer app
}
