// Alert categorisation: live Main Roads items plus rule-based restrictions from Main Roads datasets.
RR.alerts = (() => {
  const CATS = [
    { key: 'all', label: 'All' },
    { key: 'closure', label: 'Road closures', icon: 'block', tone: 'red' },
    { key: 'flood', label: 'Flooding', icon: 'water', tone: 'blue' },
    { key: 'fire', label: 'Fire', icon: 'fire', tone: 'red' },
    { key: 'roadworks', label: 'Roadworks', icon: 'cone', tone: 'amber' },
    { key: 'temporary', label: 'Temporary access', icon: 'alert', tone: 'amber' },
    { key: 'lowbridge', label: 'Low bridges', icon: 'bridge', tone: 'red' },
    { key: 'height', label: 'Height limits', icon: 'height', tone: 'amber' },
    { key: 'weight', label: 'Weight limits', icon: 'weight', tone: 'amber' },
    { key: 'oversize', label: 'Oversize rules', icon: 'wide', tone: 'blue' },
    { key: 'roadtrain', label: 'Road train rules', icon: 'truck', tone: 'blue' }
  ];
  // live Main Roads item -> category
  function classify(a) {
    const t = `${a.type} ${a.title} ${a.status} ${a.impact}`;
    if (/flood|water over|washout/i.test(t)) return 'flood';
    if (/fire|smoke|burn/i.test(t)) return 'fire';
    if (a.src === 'roadworks') return 'roadworks';
    if (/specified conditions|restricted to|vehicles? (over|exceeding)|no heavy|heavy vehicles/i.test(t)) return 'temporary';
    if (/clos/i.test(a.status) && !/open/i.test(a.status)) return 'closure';
    if (a.src === 'closure') return 'temporary';
    return a.src === 'event' ? 'temporary' : 'closure';
  }
  const severity = a => (/clos/i.test(a.status) && !/open/i.test(a.status)) || a.cat === 'fire' ? 'red' : a.cat === 'flood' ? 'blue' : 'amber';
  const firstPoint = g => g.type === 'Point' ? g.coordinates : g.type === 'LineString' ? g.coordinates[Math.floor(g.coordinates.length / 2)] : g.type === 'MultiLineString' ? g.coordinates[0][Math.floor(g.coordinates[0].length / 2)] : null;
  function live(items) { return items.map(a => { const cat = classify(a); const x = { ...a, cat }; x.tone = severity(x); x.at = firstPoint(a.geom); return x; }).filter(a => a.at); }

  // rule-based items for the active vehicle (from Main Roads structures/bridges, permit conditions)
  function rules(profile, route) {
    const S = RR.routing.state, out = [], dims = RR.vehicles.dims(profile);
    for (const st of S.structures) {
      if (!(st.maxH > 0)) continue;
      const blocks = dims.height && st.maxH - 0.3 < dims.height;
      if (blocks) out.push({ id: 'lb' + st.at.join(), cat: 'lowbridge', tone: 'red', title: `${st.maxH.toFixed(2)} m ${st.descr.toLowerCase()} over ${st.road}`, impact: `${st.suburb ? st.suburb + '. ' : ''}Below the ${(dims.height + 0.3).toFixed(2)} m your load needs (height plus 300 mm). Routes avoid it.`, at: st.at, source: 'Main Roads WA', status: 'Too low for this vehicle' });
      else if (st.maxH < 5.5) out.push({ id: 'h' + st.at.join(), cat: 'height', tone: 'amber', title: `${st.maxH.toFixed(2)} m clearance: ${st.road}`, impact: `${st.descr}${st.suburb ? ', ' + st.suburb : ''}. Maximum load height.`, at: st.at, source: 'Main Roads WA', status: 'Height limit' });
    }
    for (const b of (S.data && S.data.br) || []) { if (!b.geometry) continue; const p = b.properties || {}; out.push({ id: 'br' + (p.OBJECTID || b.geometry.coordinates.join()), cat: 'weight', tone: 'amber', title: `${p.STR_NAME || p.ROAD_NAME || 'Bridge'} (${p.STR_NO || 'listed'})`, impact: RAV.stripHtml(String(p.CONDITION || p.COMMENTS || 'Restricted bridge for this network. Check the Main Roads conditions.')).join(' '), at: b.geometry.coordinates, source: 'Main Roads WA', status: 'Restricted bridge' }); }
    const C = RR.config;
    C.zones.forEach(z => { const c = z.poly.reduce((a, p) => [a[0] + p[0] / z.poly.length, a[1] + p[1] / z.poly.length], [0, 0]); out.push({ id: 'z' + z.name, cat: 'oversize', tone: 'blue', title: z.name, impact: 'Over 5.5 m wide or 30 m long: no access without specific approval. Extra pilot, escort and convoy rules for oversize vehicles.', at: c, source: 'Main Roads WA permit conditions', status: 'Oversize restriction' }); });
    out.push({ id: 'metro', cat: 'oversize', tone: 'blue', title: 'Perth metro peak-hour curfew', impact: 'Over 22 m long or 2.7 m wide: no travel 7:30–9:00 am and 4:30–6:00 pm Mon–Fri unless on approved networks. Larger loads have tighter windows.', at: [115.86, -31.95], source: 'Main Roads WA permit conditions', status: 'Time restriction' });
    if (S.data && !S.data.general) {
      for (const f of S.data.lines) { const p = f.properties || {}; if (!p.CURFEW || !f.geometry) continue; const g = f.geometry; const at = g.type === 'LineString' ? g.coordinates[0] : g.coordinates[0][0]; out.push({ id: 'cf' + (p.ROAD || '') + at.join(), cat: 'roadtrain', tone: 'blue', title: `Curfew: ${p.ROAD_NAME}`, impact: RAV.stripHtml(String(p.CURFEW)).join(' '), at, source: 'Main Roads WA', status: 'Network condition' }); }
    }
    return out;
  }
  return { CATS, live, rules };
})();
