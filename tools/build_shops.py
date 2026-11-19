"""Build the nationwide antique shop list for the mall map, one state at a time.

Runs in GitHub Actions (see .github/workflows/shops.yml). Shop data comes from OpenStreetMap
(c) OpenStreetMap contributors, ODbL, via the public Overpass API. Writes:
  data/shops/XX.json   [[id, lat, lon, name, town], ...] for each state
  data/shops/index.json {"updated": ..., "states": {"XX": count, ...}}
A state that fails keeps its previous file, so the map never loses shops because of a bad run.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split()
HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
         'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
UA = {'User-Agent': 'TabellaSuite mall map builder (contact@tabellasuite.com)'}
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'shops')

def query(st):
    q = ('[out:csv(::type,::id,::lat,::lon,name,shop,"addr:city";false;"\\t")][timeout:300];'
         'area["ISO3166-2"="US-%s"][admin_level=4]->.a;'
         '(nwr["shop"="antiques"](area.a);nwr["shop"]["name"~"antique",i](area.a););out center;' % st)
    return urllib.parse.urlencode({'data': q}).encode()

def fetch(st):
    errors = []
    for attempt in range(3):
        for host in HOSTS:
            try:
                req = urllib.request.Request(host, data=query(st), headers=UA)
                with urllib.request.urlopen(req, timeout=330) as r:
                    text = r.read().decode('utf-8', 'replace')
                if text.lstrip().startswith('<'):
                    errors.append(host.split('/')[2] + ' error page'); continue
                return parse(text, st)
            except Exception as e:
                errors.append(host.split('/')[2] + ' ' + str(e)[:60])
            time.sleep(5)
        time.sleep(60 * (attempt + 1))
    raise RuntimeError('; '.join(errors[-4:]))

def parse(text, st):
    seen, out = set(), []
    for line in text.splitlines():
        c = line.split('\t')
        if len(c) < 6 or not c[4] or not c[2]:
            continue
        if re.search(r'thrift|goodwill|pawn', c[4], re.I) and c[5] != 'antiques':
            continue
        sid = 'osm-' + c[0][0] + c[1]
        if sid in seen:
            continue
        seen.add(sid)
        town = (c[6][:50] + ', ' + st) if len(c) > 6 and c[6] else ''
        out.append([sid, round(float(c[2]), 5), round(float(c[3]), 5), c[4][:90], town])
    out.sort(key=lambda x: x[0])
    return out

def main():
    os.makedirs(OUT, exist_ok=True)
    idx_path = os.path.join(OUT, 'index.json')
    idx = json.load(open(idx_path)) if os.path.exists(idx_path) else {'states': {}}
    only = sys.argv[1:] or STATES
    failed = []
    for st in only:
        try:
            shops = fetch(st)
            with open(os.path.join(OUT, st + '.json'), 'w') as f:
                json.dump(shops, f, separators=(',', ':'), ensure_ascii=False)
            idx['states'][st] = len(shops)
            print(st, len(shops), flush=True)
        except Exception as e:
            failed.append(st)
            print(st, 'FAILED', e, flush=True)
        time.sleep(8)
    idx['updated'] = time.strftime('%Y-%m-%d')
    idx['of'] = len(STATES)
    idx['failed'] = failed
    with open(idx_path, 'w') as f:
        json.dump(idx, f, separators=(',', ':'), sort_keys=True)
    print('done', sum(idx['states'].values()), 'shops in', len(idx['states']), 'states; failed:', failed)

if __name__ == '__main__':
    main()
