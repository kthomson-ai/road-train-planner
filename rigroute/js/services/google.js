// Google Maps Platform: loader, address search, autocomplete, nearby places. Falls back quietly when unavailable.
RR.google = (() => {
  const C = RR.config; let lib = null, ready = null;
  function load() {
    if (ready) return ready;
    ready = new Promise((res, rej) => {
      if (!C.googleKey) return rej(new Error('no key'));
      window.gm_authFailure = () => { lib = null; RR.emit && RR.emit('google-failed'); };
      window.__rrG = async () => { try { const pl = await google.maps.importLibrary('places'); lib = { Place: pl.Place, Auto: pl.AutocompleteSuggestion, Token: pl.AutocompleteSessionToken }; res(lib); } catch (e) { rej(e); } };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(C.googleKey)}&v=weekly&loading=async&callback=__rrG`;
      s.onerror = () => rej(new Error('Google blocked')); document.head.appendChild(s);
      setTimeout(() => rej(new Error('Google timeout')), 15000);
    });
    ready.catch(() => { }); return ready;
  }
  const ok = () => !!lib;
  const WA = C.WA;
  const inWA = (lat, lon) => lat >= WA.south && lat <= WA.north && lon >= WA.west && lon <= WA.east;
  const short = a => (a || '').replace(/, Australia$/, '');
  let token = null;
  async function suggest(q) {
    if (!lib || q.length < 3) return [];
    token = token || new lib.Token();
    const { suggestions } = await lib.Auto.fetchAutocompleteSuggestions({ input: q, includedRegionCodes: ['au'], locationRestriction: WA, sessionToken: token });
    return suggestions.filter(s => s.placePrediction).slice(0, 6).map(s => ({ label: short(s.placePrediction.text.text), resolve: async () => { const p = s.placePrediction.toPlace(); await p.fetchFields({ fields: ['location', 'formattedAddress', 'displayName'] }); token = null; return { lat: p.location.lat(), lon: p.location.lng(), label: short(s.placePrediction.text.text) }; } }));
  }
  async function search(q) {
    const out = [];
    if (/^\s*(lot\s+|unit\s+)?\d/i.test(q)) { // street address: autocomplete predictions resolve precisely
      try { const s = await suggest(q); const got = await Promise.all(s.slice(0, 3).map(x => x.resolve().catch(() => null))); got.forEach(x => x && inWA(x.lat, x.lon) && out.push(x)); } catch { }
      if (out.length) return out;
    }
    const { places } = await lib.Place.searchByText({ textQuery: q, fields: ['displayName', 'formattedAddress', 'location'], locationRestriction: WA, maxResultCount: 6 });
    places.forEach(p => { const a = short(p.formattedAddress); const nm = p.displayName && !a.startsWith(p.displayName) ? p.displayName + ', ' : ''; out.push({ lat: p.location.lat(), lon: p.location.lng(), label: nm + a }); });
    return out;
  }
  // facilities near a point (Places text search with a location bias)
  async function nearby(query, p, km = 60, max = 12) {
    if (!lib) return [];
    const { places } = await lib.Place.searchByText({ textQuery: query, fields: ['displayName', 'formattedAddress', 'location'], locationBias: { center: { lat: p[1], lng: p[0] }, radius: Math.min(50000, km * 1000) }, maxResultCount: max });
    return places.map(x => ({ id: 'g' + x.id, name: x.displayName, address: short(x.formattedAddress), at: [x.location.lng(), x.location.lat()], source: 'Google Places' }));
  }
  return { load, ok, suggest, search, nearby };
})();

// address search with Google first, OpenStreetMap as backup
RR.geocode = async q => {
  const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) { let a = +m[1], b = +m[2]; if (a > 0 && b < 0) [a, b] = [b, a]; return [{ lat: a, lon: b, label: `${a.toFixed(5)}, ${b.toFixed(5)}` }]; }
  if (RR.google.ok()) { try { const r = await RR.google.search(q); if (r.length) return r; } catch { } }
  const W = RR.config.WA;
  const url = `${RR.config.endpoints.nominatim}?format=json&countrycodes=au&limit=6&viewbox=${W.west},${W.north},${W.east},${W.south}&bounded=1&q=` + encodeURIComponent(q);
  const j = await fetch(url, { headers: { 'Accept-Language': 'en' } }).then(r => r.json());
  return j.map(x => ({ lat: +x.lat, lon: +x.lon, label: x.display_name.replace(/, Western Australia.*$/, ', WA') }));
};
