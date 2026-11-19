// Finding antique shops anywhere, for the mall map.
// Shop locations come from OpenStreetMap (Overpass API), towns from Nominatim, driving routes from OSRM.
// All three are free public services with fair-use limits, so every answer is cached in the TABELLA KV.
// Map data (c) OpenStreetMap contributors, ODbL. The map page shows that credit.

const UA = { 'User-Agent': 'TabellaSuite mall map (contact@tabellasuite.com)' };
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const DAY = 86400;

export async function handlePlaces(request, env, url, json, cors) {
  const p = url.pathname;
  if (!p.startsWith('/places/')) return null;
  const out = (d, maxAge) => new Response(JSON.stringify(d), { headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'public, max-age=' + (maxAge || 300) }, cors) });
  try {
    if (!env.TABELLA) throw err(500, 'Storage is not set up.');
    if (p === '/places/geocode' && request.method === 'GET') {
      const q = clean(url.searchParams.get('q'), 120);
      if (q.length < 2) throw err(400, 'Type a town, address or ZIP code.');
      return out(await geocode(env, q), 86400);
    }
    if (p === '/places/area' && request.method === 'GET') {
      // One half-degree square (about 35 x 30 miles), named by its south-west corner.
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180 || (lat * 2) % 1 || (lon * 2) % 1) throw err(400, 'Bad area.');
      return out({ shops: await area(env, lat, lon) }, 3600);
    }
    if (p === '/places/route' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const from = clean(b.from, 120), to = clean(b.to, 120), miles = [5, 10, 20, 30].includes(Number(b.miles)) ? Number(b.miles) : 10;
      if (!from || !to) throw err(400, 'Add where you are starting and where you are going.');
      await limit(env, request, 'rlr:', 40, 'You have planned a lot of trips in the last hour. Try again a little later.');
      return out(await route(env, from, to, miles), 600);
    }
    return json({ error: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ error: e.message || 'Something went wrong.' }, e.status || 500, cors);
  }
}

export async function geocode(env, q) {
  const k = 'geo:' + q.toLowerCase();
  const hit = await env.TABELLA.get(k);
  if (hit) return JSON.parse(hit);
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q=' + encodeURIComponent(q), { headers: UA }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => []) : null;
  if (!d) throw err(503, 'The map search is busy. Try again in a minute.');
  if (!d[0]) throw err(404, 'Could not find "' + q + '". Try a town and state, like "Nixa, MO".');
  const a = d[0].address || {};
  const res = { q, name: shortName(d[0], a), lat: +(+d[0].lat).toFixed(5), lon: +(+d[0].lon).toFixed(5), bbox: (d[0].boundingbox || []).map(Number) };
  await env.TABELLA.put(k, JSON.stringify(res), { expirationTtl: 30 * DAY });
  return res;
}

async function area(env, lat, lon) {
  const k = 'osm:' + lat + ',' + lon;
  const hit = await env.TABELLA.get(k);
  if (hit) return JSON.parse(hit);
  const box = [lat, lon, lat + 0.5, lon + 0.5].join(',');
  const shops = await overpass('[out:json][timeout:25];(nwr["shop"="antiques"](' + box + ');nwr["shop"]["name"~"antique",i](' + box + '););out center tags 500;');
  await env.TABELLA.put(k, JSON.stringify(shops), { expirationTtl: 7 * DAY });
  return shops;
}

async function route(env, fromQ, toQ, miles) {
  const k = 'rt:' + [fromQ, toQ, miles].join('|').toLowerCase();
  const hit = await env.TABELLA.get(k);
  if (hit) return JSON.parse(hit);
  const [a, b] = await Promise.all([geocode(env, fromQ), geocode(env, toQ)]);
  const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat + '?overview=full&geometries=geojson', { headers: UA }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  if (!d || d.code !== 'Ok' || !d.routes || !d.routes[0]) throw err(503, 'Could not find a driving route between those places. Check the spelling, or try again in a minute.');
  const R = d.routes[0], miTotal = R.distance / 1609.34;
  if (miTotal > 1500) throw err(400, 'That trip is ' + Math.round(miTotal) + ' miles. Plan it in legs of up to 1,500 miles.');
  const line = thin(R.geometry.coordinates.map(c => [+c[1].toFixed(5), +c[0].toFixed(5)]), 400);
  const probe = thin(line, 150);
  const near = await overpass('[out:json][timeout:50];(nwr["shop"="antiques"](around:' + Math.round(miles * 1609.34) + ',' + probe.map(p => p.join(',')).join(',') + ');nwr["shop"]["name"~"antique",i](around:' + Math.round(miles * 1609.34) + ',' + probe.map(p => p.join(',')).join(',') + '););out center tags 600;');
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum[i] = cum[i - 1] + hav(line[i - 1], line[i]);
  const scale = cum[cum.length - 1] ? miTotal / cum[cum.length - 1] : 1;
  const shops = near.map(s => {
    let best = Infinity, at = 0;
    for (let i = 0; i < line.length; i++) { const dd = hav([s.lat, s.lon], line[i]); if (dd < best) { best = dd; at = i; } }
    return Object.assign(s, { along: Math.round(cum[at] * scale), off: Math.round(best * 10) / 10 });
  }).filter(s => s.off <= miles + 1).sort((x, y) => x.along - y.along);
  const res = { from: a, to: b, miles, distanceMi: Math.round(miTotal), hours: Math.round(R.duration / 360) / 10, line, shops };
  await env.TABELLA.put(k, JSON.stringify(res), { expirationTtl: DAY });
  return res;
}

async function overpass(q) {
  const why = [];
  for (const host of OVERPASS) {
    const name = new URL(host).hostname;
    try {
      const r = await fetch(host + '?data=' + encodeURIComponent(q), { headers: Object.assign({ Accept: 'application/json' }, UA) });
      if (!r.ok) { why.push(name + ' ' + r.status); continue; }
      const d = await r.json().catch(() => null);
      if (d && d.elements) return tidy(d.elements);
      why.push(name + ' bad reply');
    } catch (e) { why.push(name + ' ' + (e.message || 'failed').slice(0, 40)); }
  }
  throw err(503, 'The shop finder is busy right now. Try again in a minute. (' + why.join('; ') + ')');
}

function tidy(els) {
  const seen = new Set(), out = [];
  for (const e of els) {
    const t = e.tags || {}, lat = e.lat != null ? e.lat : e.center && e.center.lat, lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (!t.name || lat == null) continue;
    if (/thrift|goodwill|pawn/i.test(t.name) && t.shop !== 'antiques') continue;
    const id = 'osm-' + e.type[0] + e.id;
    if (seen.has(id)) continue; seen.add(id);
    const city = t['addr:city'] || '', st = t['addr:state'] || '';
    out.push({ id, name: t.name.slice(0, 90), lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      addr: [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), city, st].filter(Boolean).join(', ').slice(0, 140),
      town: city && st ? city + ', ' + st.toUpperCase().slice(0, 2) : '', hours: (t.opening_hours || '').slice(0, 120) });
  }
  return out;
}

export async function limit(env, request, prefix, max, msg) {
  const k = prefix + (request.headers.get('CF-Connecting-IP') || 'x');
  const n = Number(await env.TABELLA.get(k)) || 0;
  if (n >= max) throw err(429, msg);
  await env.TABELLA.put(k, String(n + 1), { expirationTtl: 3600 });
}

function thin(pts, max) { if (pts.length <= max) return pts; const step = (pts.length - 1) / (max - 1), o = []; for (let i = 0; i < max; i++) o.push(pts[Math.round(i * step)]); return o; }
function hav(a, b) { const R = 3958.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function shortName(d, a) { const town = a.city || a.town || a.village || a.hamlet || a.county || d.name; const st = (a['ISO3166-2-lvl4'] || '').replace('US-', ''); return [town, st].filter(Boolean).join(', ') || d.display_name.split(',').slice(0, 2).join(','); }
function clean(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
