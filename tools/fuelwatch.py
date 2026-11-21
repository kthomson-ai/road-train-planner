"""Fetch WA fuel prices from the FuelWatch RSS feed (WA Government) into a compact JSON file
for the ROAM app. Run by a scheduled GitHub Action after prices change (6 am) and after
tomorrow's prices are published (2:30 pm). Usage: python tools/fuelwatch.py out.json"""
import json, sys, time, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

BASE = 'https://www.fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS'
PRODUCTS = {'ulp': 1, 'pulp': 2, 'diesel': 4, 'r98': 6}
REGIONS = [r for r in range(1, 64) if r != 52]   # FuelWatch region ids (52 is unused)
AWST = timezone(timedelta(hours=8))

def fetch(product, region, day):
    url = f'{BASE}?Product={product}&Region={region}&Day={day}'
    req = urllib.request.Request(url, headers={'User-Agent': 'ROAM navigation app (github.com/kthomson-ai/road-train-planner)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:
            time.sleep(2 + attempt * 3)
    print('failed', url, file=sys.stderr)
    return None

def parse(xml):
    out = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return out
    for it in root.iter('item'):
        g = lambda k: (it.findtext(k) or '').strip()
        try:
            out.append({'name': g('trading-name'), 'brand': g('brand'), 'address': g('address'), 'loc': g('location').title(),
                        'lat': round(float(g('latitude')), 6), 'lon': round(float(g('longitude')), 6),
                        'price': float(g('price')), 'date': g('date'), 'restr': g('restrictions').rstrip(';')})
        except ValueError:
            pass
    return out

def main(path):
    stations, index, prices = [], {}, {}
    ok = 0
    for day in ('today', 'tomorrow'):
        for fuel, pid in PRODUCTS.items():
            for region in REGIONS:
                xml = fetch(pid, region, day)
                time.sleep(0.25)
                if not xml:
                    continue
                ok += 1
                for s in parse(xml):
                    key = (s['name'], s['lat'], s['lon'])
                    if key not in index:
                        index[key] = len(stations)
                        stations.append([s['name'], s['brand'], s['address'], s['loc'], s['lat'], s['lon'], s['restr']])
                    if s['date']:
                        prices.setdefault(s['date'], {}).setdefault(fuel, {})[index[key]] = s['price']
    if ok < 100 or len(stations) < 200:
        sys.exit(f'Too little data ({ok} feeds, {len(stations)} stations); keeping the old file.')
    out = {'source': 'FuelWatch, Government of Western Australia', 'updated': datetime.now(AWST).isoformat(timespec='minutes'),
           'stations': stations,
           'prices': {d: {f: sorted([[i, p] for i, p in m.items()]) for f, m in v.items()} for d, v in sorted(prices.items())}}
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'{len(stations)} stations, days {list(out["prices"])}, {ok} feeds')

if __name__ == '__main__':
    main(sys.argv[1])
