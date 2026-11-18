// Truck routing service: graphs per network, vehicle rules, live closures, preferences, alternatives, confidence.
RR.routing = (() => {
  const C = RR.config;
  const state = { key: null, data: null, base: null, structures: [], facilities: [], alerts: [], local: { key: '', g: null }, restr: null, restrKey: '' };
  const hav = (a, b) => RAV.hav(a, b);

  async function prepare(key, onStatus) {
    if (state.key === key && state.base) return state;
    state.key = key; state.base = null; state.restr = null;
    const t0 = performance.now();
    state.data = await RR.mainroads.network(key, { onStatus });
    if (state.key !== key) return state;
    onStatus && onStatus('Building road graph…'); await new Promise(r => setTimeout(r, 15));
    state.base = RAV.build(state.data.lines, state.data.ints, state.data.br);
    state.buildMs = performance.now() - t0;
    return state;
  }
  // general access: add local streets around each point
  async function graphFor(pts, onStatus) {
    if (!state.data.general) return state.base;
    onStatus && onStatus('Loading local streets around your stops…');
    const extra = []; for (const p of pts) extra.push(...await RR.mainroads.localRoads(p));
    const key = state.key + pts.map(p => p[0].toFixed(3) + p[1].toFixed(3)).join('|');
    if (state.local.key === key) return state.local.g;
    onStatus && onStatus('Building road graph…'); await new Promise(r => setTimeout(r, 15));
    const seen = new Set(), feats = [];
    for (const f of state.data.lines.concat(extra)) { const id = (f.properties.ROAD || '') + '|' + JSON.stringify(f.geometry && f.geometry.coordinates[0]); if (seen.has(id)) continue; seen.add(id); feats.push(f); }
    state.local = { key, g: RAV.build(feats, [], []) }; return state.local.g;
  }
  const closuresBlocking = () => state.alerts.filter(a => a.src === 'closure' && /clos/i.test(a.status) && !/open/i.test(a.status));

  function restrictions(G, profile, pts, prefs) {
    const dims = RR.vehicles.dims(profile);
    const zones = C.zones.filter(z => !pts.some(p => RAV.inPoly(p, z.poly)));
    const key = [state.key, JSON.stringify(dims), profile.dg, JSON.stringify(prefs), zones.length, state.alerts.length, G === state.base ? 'b' : state.local.key].join('/');
    if (state.restr && state.restrKey === key && state.restrG === G) return state.restr;
    const r = RAV.restrictions(G, dims, { structures: state.structures, zones, allZones: C.zones, prohibited: state.data.prohibited || [] });
    // placarded dangerous goods: Northbridge Tunnel
    if (profile.dg) { const b = C.dgTunnel.box; let n = 0; G.E.forEach((e, ei) => { const m = G.coords[e.path[Math.floor(e.path.length / 2)]]; if (m[0] > b[0] && m[0] < b[2] && m[1] > b[1] && m[1] < b[3] && C.dgTunnel.road.test(RAV.edgeName(G, ei))) { r.blocked.add(ei); n++; } }); if (n) r.notes.push({ kind: 'dg', text: 'Placarded dangerous goods: avoiding the Northbridge Tunnel (Graham Farmer Freeway).' }); }
    // live road closures
    let closed = 0;
    for (const a of closuresBlocking()) { const lines = a.geom.type === 'MultiLineString' ? a.geom.coordinates : a.geom.type === 'LineString' ? [a.geom.coordinates] : [[a.geom.coordinates]]; for (const L of lines) for (let i = 0; i < L.length; i += Math.max(1, Math.floor(L.length / 40))) for (const { ei } of RAV.nearEdges(G, L[i], 30)) { if (!r.blocked.has(ei)) closed++; r.blocked.add(ei); } }
    if (closed) r.notes.push({ kind: 'closure', text: 'Avoiding roads currently closed (Main Roads live data).' });
    // preferences as soft penalties
    const pen = new Map();
    if (prefs.avoidUnsealed || prefs.preferHighways) G.E.forEach((e, ei) => { const f = e.f >= 0 ? G.feats[e.f] : null; if (!f) return; let m = 1; if (prefs.avoidUnsealed && (f.unsealed || /unsealed/i.test(f.name))) m *= 4; if (prefs.preferHighways && !f.state && !(f.speed >= 80)) m *= 1.3; if (m > 1) pen.set(ei, m); });
    r.pen = pen;
    state.restr = r; state.restrKey = key; state.restrG = G; return r;
  }

  // classify each route section: confirmed / conditional / general / unverified
  function confidence(G, route) {
    const seg = { confirmed: 0, conditional: 0, general: 0, unverified: 0 }, parts = [];
    for (const lg of route.legs2 || [route]) for (const L of lg.legs || []) {
      const f = G.E[L.ei].f >= 0 ? G.feats[G.E[L.ei].f] : null;
      const cls = !f ? 'confirmed' : f.conds.length ? 'conditional' : (state.data.general && f.speed && f.speed <= 40) ? 'general' : 'confirmed';
      seg[cls] += L.len; parts.push({ cls, pts: L.pts });
    }
    const gaps = [];
    const ends = [route.s, ...(route.legs2 || []).slice(0, -1).map(l => l.t), route.t];
    ends.forEach(sn => { if (sn && sn.d > 300) { seg.unverified += sn.d; gaps.push(sn); } });
    return { seg, parts, gaps };
  }
  // project points onto the route; return along-distance (m) and offset (m)
  function locator(line) {
    const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + hav(line[i - 1], line[i]));
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90; line.forEach(p => { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    const stride = Math.max(1, Math.floor(line.length / 1500));
    return (pt, maxM) => {
      if (pt[0] < x0 - 0.1 || pt[0] > x1 + 0.1 || pt[1] < y0 - 0.1 || pt[1] > y1 + 0.1) return null;
      let best = Infinity, bi = 0;
      for (let i = 0; i < line.length; i += stride) { const d = hav(pt, line[i]); if (d < best) { best = d; bi = i; } }
      const lo = Math.max(0, bi - stride), hi = Math.min(line.length - 1, bi + stride);
      for (let i = lo; i <= hi; i++) { const d = hav(pt, line[i]); if (d < best) { best = d; bi = i; } }
      return best <= maxM ? { along: cum[bi], off: best } : null;
    };
  }
  function alongRoute(route) {
    const loc = locator(route.line), total = route.total;
    const alerts = [];
    for (const a of state.alerts) {
      const g = a.geom, pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : [];
      let hit = null; for (let i = 0; i < pts.length && !hit; i += Math.max(1, Math.floor(pts.length / 30))) hit = loc(pts[i], 400);
      if (hit) alerts.push({ ...a, along: hit.along });
    }
    const facilities = [];
    for (const f of state.facilities) { const h = loc(f.at, 3000); if (h) facilities.push({ ...f, along: h.along, off: h.off }); }
    alerts.sort((a, b) => a.along - b.along); facilities.sort((a, b) => a.along - b.along);
    return { alerts, facilities, total };
  }

  async function plan({ pts, labels, profile, prefs = {}, onStatus }) {
    const G = await graphFor(pts, onStatus);
    onStatus && onStatus('Checking height, width, length and live closures…'); await new Promise(r => setTimeout(r, 10));
    const restr = restrictions(G, profile, pts, prefs);
    onStatus && onStatus('Finding legal routes…'); await new Promise(r => setTimeout(r, 10));
    const t0 = performance.now();
    const routes = RAV.routeAlternatives(G, pts, labels, { blocked: restr.blocked, slow: restr.slow, pen: restr.pen }, 2);
    const ms = performance.now() - t0;
    if (routes[0].error) return { error: routes[0].error, restr };
    const dims = RR.vehicles.dims(profile);
    routes.forEach((r, i) => {
      r.idx = i; r.conf = confidence(G, r); r.along = alongRoute(r);
      r.tight = RAV.tightStructures(r.line, { structures: state.structures }, dims.height);
      r.zones = RAV.zonesOnRoute(r.line, C.zones);
      r.metro = r.line.some(C.metro);
      r.label = i === 0 ? 'Fastest legal route' : `Alternative ${i}`;
    });
    // name the alternatives by their main distinctive road
    routes.slice(1).forEach(r => { const names = r.steps.filter(s => s.len > 3000).map(s => s.name); const bestNames = new Set(routes[0].steps.map(s => s.name)); const via = names.find(n => !bestNames.has(n)); if (via) r.label = 'Via ' + via; });
    return { routes, restr, G, ms };
  }
  function reroute(G, pts, labels, firstStopNo) { const r = state.restr; return RAV.routeVia(G, pts, labels, firstStopNo, { blocked: r && r.blocked, slow: r && r.slow, pen: r && r.pen }); }
  // ---------- road train assembly area swap ----------
  // The big combination drives to an RTAA on its own network, drops trailers, and the smaller vehicle carries on
  // to the destination on its network. Tries the most promising assembly areas and keeps the quickest.
  const G2cache = new Map();
  async function graphForKey(key, onStatus) {
    if (G2cache.has(key)) return G2cache.get(key);
    onStatus && onStatus(`Loading ${RR.net(key).short} for the second half…`);
    const data = await RR.mainroads.network(key);
    const G = RAV.build(data.lines, data.ints, data.br); const out = { G, data }; G2cache.set(key, out); return out;
  }
  function mergeConf(c1, c2) { const seg = {}; for (const k of Object.keys(c1.seg)) seg[k] = c1.seg[k] + (c2.seg[k] || 0); return { seg, parts: c1.parts.concat(c2.parts), gaps: c1.gaps.concat(c2.gaps) }; }
  async function planSwap({ pts, labels, profile, profile2, prefs = {}, onStatus }) {
    if (pts.length !== 2 || !profile2) return null;
    const rtaas = state.facilities.filter(f => f.kind === 'rtaa');
    if (!rtaas.length) return null;
    const G1 = state.base, { G: G2, data: d2 } = await graphForKey(profile2.net, onStatus);
    onStatus && onStatus('Checking road train assembly areas…'); await new Promise(r => setTimeout(r, 10));
    const r1 = restrictions(G1, profile, pts, prefs);
    const dims2 = RR.vehicles.dims(profile2), zones = C.zones.filter(z => !pts.some(p => RAV.inPoly(p, z.poly)));
    const r2 = RAV.restrictions(G2, dims2, { structures: state.structures, zones, allZones: C.zones, prohibited: d2.prohibited || [] });
    const [a, b] = pts, direct = hav(a, b);
    const cands = rtaas.map(f => ({ f, score: hav(a, f.at) + hav(f.at, b) })).filter(x => x.score < direct * 1.6 + 30000).sort((x, y) => x.score - y.score).slice(0, 8);
    let best = null;
    for (const { f } of cands) {
      const leg1 = RAV.routeVia(G1, [a, f.at], [labels[0], f.name], 1, { blocked: r1.blocked, slow: r1.slow, pen: r1.pen });
      if (leg1.error || leg1.t.d > 400) continue;
      const leg2 = RAV.routeVia(G2, [f.at, b], [f.name, labels[1]], 1, { blocked: r2.blocked, slow: r2.slow });
      if (leg2.error || leg2.s.d > 400) continue;
      const secs = leg1.secs + leg2.secs + 30 * 60; // allow ~30 min to drop trailers
      if (!best || secs < best.secs) best = { f, leg1, leg2, secs };
    }
    if (!best) return null;
    const { f, leg1, leg2 } = best;
    const steps = leg1.steps.concat([{ instr: 'Arrive at stop 1:', name: `${f.name}: drop trailers, continue as ${profile2.name}`, len: 0, at: f.at, pts: [f.at], stop: 1 }], leg2.steps.map(s => ({ ...s, instr: s.instr.replace(/^Start on/, 'Leave on') })));
    const r = { line: leg1.line.concat(leg2.line.slice(1)), steps, total: leg1.total + leg2.total, secs: leg1.secs + leg2.secs + 30 * 60, s: leg1.s, t: leg2.t,
      legs2: leg1.legs2.concat(leg2.legs2), conditions: leg1.conditions.concat(leg2.conditions), rulesNear: leg1.rulesNear.concat(leg2.rulesNear), bridgesNear: (leg1.bridgesNear || []).concat(leg2.bridgesNear || []),
      swap: { at: f.at, name: f.name, to: profile2.name, net2: profile2.net } };
    r.conf = mergeConf(confidence(G1, { ...leg1, s: leg1.s, t: { d: 0 } }), confidence(G2, { ...leg2, s: { d: 0 }, t: leg2.t }));
    r.along = alongRoute(r); r.tight = RAV.tightStructures(leg1.line, { structures: state.structures }, RR.vehicles.dims(profile).height).concat(RAV.tightStructures(leg2.line, { structures: state.structures }, dims2.height));
    r.zones = RAV.zonesOnRoute(leg2.line, C.zones); r.metro = r.line.some(C.metro);
    r.label = `Swap at ${f.name.replace(/road train assembly area/i, 'RTAA')}`;
    return r;
  }
  return { state, prepare, plan, reroute, alongRoute, closuresBlocking, restrictions, planSwap };
})();
