// Fuel prices from FuelWatch (Government of Western Australia). A scheduled job in the repo saves them twice a
// day to data/fuel.json; WA prices are fixed for the whole day, so a copy from this morning stays right all day.
RR.fuel = (() => {
  const URLS = ['https://raw.githubusercontent.com/kthomson-ai/road-train-planner/main/rigroute/data/fuel.json', 'data/fuel.json'];
  const NAMES = { ulp: 'unleaded', pulp: 'premium unleaded', r98: '98', diesel: 'diesel' };
  let data = RR.store.get('fuelData', null), loading = null;
  const perthDate = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  async function load() {
    if (data && Date.now() - (data._t || 0) < 2 * 3600e3) return data;
    if (loading) return loading;
    loading = (async () => {
      for (const u of URLS) {
        try {
          const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
          const r = await fetch(u + '?t=' + Math.floor(Date.now() / 600e3), { signal: ctl.signal, cache: 'no-store' }); clearTimeout(t);
          if (!r.ok) continue; const j = await r.json(); if (!j.stations) continue;
          j._t = Date.now(); data = j; try { RR.store.set('fuelData', j); } catch { /* too big for storage: keep in memory */ }
          return data;
        } catch { }
      }
      return data; // offline: last saved copy
    })().finally(() => { loading = null; });
    return loading;
  }
  // which fuel a vehicle uses: trucks diesel; cars whatever their profile says (unleaded by default)
  const productFor = v => v && v.type === 'car' ? (v.fuelType || 'ulp') : 'diesel';
  // today's price list for a fuel: [{ name, brand, address, loc, at, price, restr, tomorrow }]
  function prices(product, day = perthDate()) {
    if (!data || !data.prices) return [];
    const days = Object.keys(data.prices).sort(), d = days.filter(x => x <= day).pop(); if (!d) return [];
    const next = data.prices[days[days.indexOf(d) + 1]], tm = new Map(((next && next[product]) || []).map(([i, p]) => [i, p]));
    return ((data.prices[d] || {})[product] || []).map(([i, p]) => { const s = data.stations[i]; return { name: s[0], brand: s[1], address: s[2], loc: s[3], at: [s[5], s[4]], price: p, restr: s[6], tomorrow: tm.get(i), fw: true, day: d }; });
  }
  const stale = () => !data || !data.prices || !Object.keys(data.prices).some(d => d === perthDate());
  const fmt = p => p.toFixed(1);
  return { load, prices, productFor, name: k => NAMES[k] || k, stale, fmt, ready: () => !!data, updated: () => data && data.updated };
})();
