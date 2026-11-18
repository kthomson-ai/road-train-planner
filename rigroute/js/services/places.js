// Offline-capable place search: remembered places, WA localities (Landgate), Main Roads facilities and road names.
RR.places = (() => {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let towns = [];
  function remember(pt) {
    if (!pt || !pt.label || /^my location|current position/i.test(pt.label)) return;
    const list = RR.store.get('recentPlaces', []).filter(p => p.label !== pt.label);
    list.unshift({ label: pt.label, lat: +(+pt.lat).toFixed(6), lon: +(+pt.lon).toFixed(6), t: Date.now() });
    RR.store.set('recentPlaces', list.slice(0, 60));
  }
  const recents = () => RR.store.get('recentPlaces', []);
  function setTowns(t) { towns = t || []; }
  function score(q, name) { const n = norm(name); if (!n) return 0; if (n === q) return 100; if (n.startsWith(q)) return 80 - Math.min(20, n.length - q.length); if (n.split(' ').some(w => w.startsWith(q))) return 60; if (n.includes(q)) return 40; return 0; }
  function search(text, max = 8) {
    const q = norm(text); if (q.length < 2) return [];
    const out = [];
    for (const p of recents()) { const s = score(q, p.label); if (s) out.push({ ...p, s: s + 15, kind: 'Recent' }); }
    for (const st of (RR.shared ? RR.shared.sites() : [])) { const sc = score(q, st.name); if (sc) out.push({ label: st.name, lat: st.at[1], lon: st.at[0], s: sc + 10, kind: 'Saved site' }); }
    for (const t of towns) { const s = score(q, t.name); if (s) out.push({ label: `${t.name}${t.pc ? ' ' + t.pc : ''}, WA`, lat: t.at[1], lon: t.at[0], s, kind: 'Town / locality' }); }
    for (const f of (RR.routing.state.facilities || [])) { const s = score(q, f.name); if (s) out.push({ label: f.name, lat: f.at[1], lon: f.at[0], s: s - 5, kind: 'Main Roads facility' }); }
    const data = RR.routing.state.data; const seen = new Set();
    if (data && out.length < max) for (const l of data.lines) { const nm = l.properties && l.properties.ROAD_NAME; if (!nm || seen.has(nm)) continue; const s = score(q, nm); if (s >= 60) { seen.add(nm); const g = l.geometry; const c = g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.coordinates[0][0]; out.push({ label: nm, lat: c[1], lon: c[0], s: s - 20, kind: 'Road' }); } }
    const uniq = []; out.sort((a, b) => b.s - a.s).forEach(r => { if (!uniq.some(u => u.label === r.label)) uniq.push(r); });
    return uniq.slice(0, max).map(r => ({ lat: r.lat, lon: r.lon, label: r.label, kind: r.kind, offline: true }));
  }
  return { remember, recents, search, setTowns, towns: () => towns };
})();
// wrap the online geocoder: offline (or if the online lookup fails) search what's stored on the phone
(() => {
  const online = RR.geocode;
  RR.geocode = async q => {
    const m = q.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/); if (m) return online(q);
    if (!navigator.onLine) return RR.places.search(q);
    try { const r = await online(q); if (r && r.length) return r; } catch { }
    return RR.places.search(q);
  };
})();
