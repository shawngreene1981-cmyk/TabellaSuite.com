"""Build the nationwide antique shop list for the mall map.

Runs in GitHub Actions (see .github/workflows/shops.yml). Shop data comes from OpenStreetMap
(c) OpenStreetMap contributors, ODbL, via the public Overpass API.

One request covers the whole US (a state-by-state search was far too slow on the free servers):
  1. every shop tagged shop=antiques
  2. shops of the kinds antique malls are often tagged as (second hand, collector, mall, ...) whose name says "antique"
Results are split into 4-degree map tiles so the map can load them a piece at a time:
  data/shops/<lat>_<lon>.json  [[id, lat, lon, name, town], ...]
  data/shops/index.json        {"updated": ..., "tiles": {"36_-96": count, ...}, "total": n}
If a request fails, the previous files are kept, so the map never loses shops because of a bad run.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
         'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
UA = {'User-Agent': 'TabellaSuite mall map builder (contact@tabellasuite.com)'}
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'shops')
HEAD = '[out:csv(::type,::id,::lat,::lon,name,shop,"addr:city","addr:state";false;"\\t")][timeout:900][maxsize:536870912];area["ISO3166-1"="US"][admin_level=2]->.us;'
QUERIES = {
    'antiques': HEAD + 'nwr["shop"="antiques"](area.us);out center;',
    'named': HEAD + 'nwr["shop"~"^(second_hand|collector|mall|furniture|gift|variety_store|general|interior_decoration|houseware)$"]["name"~"antique",i](area.us);out center;',
}
TILE = 4

def fetch(name, q):
    errors = []
    for attempt in range(2):
        for host in HOSTS:
            t0 = time.time()
            try:
                req = urllib.request.Request(host, data=urllib.parse.urlencode({'data': q}).encode(), headers=UA)
                with urllib.request.urlopen(req, timeout=960) as r:
                    text = r.read().decode('utf-8', 'replace')
                if text.lstrip().startswith('<'):
                    errors.append(host.split('/')[2] + ' error page'); continue
                print(name, 'from', host.split('/')[2], 'in', int(time.time() - t0), 's', flush=True)
                return text
            except Exception as e:
                errors.append(host.split('/')[2] + ' ' + str(e)[:80])
                print(name, 'try failed:', errors[-1], flush=True)
            time.sleep(10)
        time.sleep(90)
    raise RuntimeError('; '.join(errors[-4:]))

def parse(text, shops):
    for line in text.splitlines():
        c = line.split('\t')
        if len(c) < 6 or not c[4] or not c[2]:
            continue
        if re.search(r'thrift|goodwill|pawn', c[4], re.I) and c[5] != 'antiques':
            continue
        sid = 'osm-' + c[0][0] + c[1]
        city = c[6][:50] if len(c) > 6 else ''
        st = (c[7].strip().upper()[:2] if len(c) > 7 else '')
        town = city + (', ' + st if st else '') if city else ''
        shops[sid] = [sid, round(float(c[2]), 5), round(float(c[3]), 5), c[4][:90], town]

def main():
    os.makedirs(OUT, exist_ok=True)
    shops, got, failed = {}, [], []
    for name, q in QUERIES.items():
        try:
            parse(fetch(name, q), shops); got.append(name)
        except Exception as e:
            failed.append(name); print(name, 'FAILED', e, flush=True)
    if 'antiques' not in got:
        print('Main request failed; keeping the existing files.'); sys.exit(1)
    tiles = {}
    for s in shops.values():
        key = '%d_%d' % (int((s[1] // TILE) * TILE), int((s[2] // TILE) * TILE))
        tiles.setdefault(key, []).append(s)
    for f in os.listdir(OUT):
        if re.match(r'^-?\d+_-?\d+\.json$|^[A-Z]{2}\.json$', f):
            os.remove(os.path.join(OUT, f))
    for key, lst in tiles.items():
        lst.sort(key=lambda x: x[0])
        with open(os.path.join(OUT, key + '.json'), 'w') as f:
            json.dump(lst, f, separators=(',', ':'), ensure_ascii=False)
    idx = {'updated': time.strftime('%Y-%m-%d'), 'total': len(shops), 'tile': TILE, 'failed': failed,
           'tiles': {k: len(v) for k, v in sorted(tiles.items())}}
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump(idx, f, separators=(',', ':'))
    print('done', len(shops), 'shops in', len(tiles), 'tiles; failed:', failed)

if __name__ == '__main__':
    main()
