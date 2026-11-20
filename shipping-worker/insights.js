// Mall insights: which booths sell and which sit, how fast pieces sell, the oldest pieces on the floor, what sells
// by category, and online sales from the mall's booths with the mall's 4%.
// In-store sales come from the register (so booths the mall pays itself count too). Days to sell, pieces on hand and
// online sales come from the Tabella dealers' items.

const MALL_SHARE = 0.04, DAY = 86400000;

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
const cents = v => Math.round((Number(v) || 0) * 100);

export async function mallInsights(env, m, days) {
  days = [30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const now = Date.now(), since = now - days * DAY;
  const booths = (await listAll(env, 'booth:' + m.id + ':')).map(([k, b]) => Object.assign({ dealer: k.split(':')[2] }, b));
  const B = {};
  for (const b of booths) {
    const d = JSON.parse(await env.TABELLA.get('dealer:' + b.dealer) || 'null');
    B[b.dealer] = { dealer: b.dealer, booth: b.booth, name: d ? d.name : 'Booth ' + b.booth, managed: !!(d && d.managed), store: 0, storeCount: 0, online: 0, onlineCount: 0,
      onHand: 0, onHandValue: 0, sellDays: [], lastSale: 0 };
  }
  // In-store, from the register.
  for (const [, s] of await listAll(env, 'msale:' + m.id + ':')) {
    if (s.status !== 'paid' || s.at < since) continue;
    for (const it of s.items) {
      const r = B[it.dealer]; if (!r) continue;
      r.store += it.price; r.storeCount++; r.lastSale = Math.max(r.lastSale, s.at);
    }
  }
  // Tabella dealers' items: online sales, days to sell, what's on the floor.
  const cats = {}, oldest = [];
  for (const r of Object.values(B)) {
    if (r.managed) continue;
    for (const [, it] of await listAll(env, 'item:' + r.dealer + ':')) {
      const c = it.category || 'Other';
      if (it.status === 'sold' && it.soldAt >= since) {
        const p = cents(it.price);
        if (it.order) { r.online += p; r.onlineCount++; r.lastSale = Math.max(r.lastSale, it.soldAt); }
        if (it.created && it.soldAt > it.created) r.sellDays.push((it.soldAt - it.created) / DAY);
        const k = cats[c] || (cats[c] = { category: c, sold: 0, sales: 0, days: [] });
        k.sold++; k.sales += p; if (it.created && it.soldAt > it.created) k.days.push((it.soldAt - it.created) / DAY);
      } else if (it.status === 'available' || it.status === 'hold') {
        r.onHand++; r.onHandValue += cents(it.price);
        oldest.push({ id: it.id, title: it.title, booth: r.booth, dealer: r.name, price: cents(it.price), days: Math.floor((now - (it.created || now)) / DAY), photo: it.photos && it.photos[0] || null });
      }
    }
  }
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
  const rows = Object.values(B).map(r => ({ dealer: r.dealer, booth: r.booth, name: r.name, managed: r.managed, sales: r.store + r.online, store: r.store, online: r.online,
    sold: r.storeCount + r.onlineCount, onHand: r.managed ? null : r.onHand, onHandValue: r.managed ? null : r.onHandValue, avgDays: avg(r.sellDays),
    lastSale: r.lastSale || null }))
    .sort((a, b) => b.sales - a.sales || String(a.booth).localeCompare(String(b.booth), 'en', { numeric: true }));
  const allDays = Object.values(B).flatMap(r => r.sellDays);
  const online = rows.reduce((t, r) => t + r.online, 0);
  return {
    days, mall: m.name,
    totals: { sales: rows.reduce((t, r) => t + r.sales, 0), store: rows.reduce((t, r) => t + r.store, 0), online, mallShare: Math.round(online * MALL_SHARE),
      sold: rows.reduce((t, r) => t + r.sold, 0), avgDays: avg(allDays), onHand: rows.reduce((t, r) => t + (r.onHand || 0), 0), onHandValue: rows.reduce((t, r) => t + (r.onHandValue || 0), 0), booths: rows.length },
    hot: rows.filter(r => r.sales > 0).slice(0, 5),
    slow: rows.filter(r => !r.managed && r.onHand > 0).sort((a, b) => a.sales - b.sales || b.onHand - a.onHand).slice(0, 5),
    quiet: rows.filter(r => !r.sales).map(r => r.booth),
    booths: rows,
    categories: Object.values(cats).map(k => ({ category: k.category, sold: k.sold, sales: k.sales, avgDays: avg(k.days) })).sort((a, b) => b.sales - a.sales),
    oldest: oldest.sort((a, b) => b.days - a.days).slice(0, 12)
  };
}
