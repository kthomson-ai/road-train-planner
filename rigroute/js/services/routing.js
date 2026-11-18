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

  // Main Roads lists bridges a network must not cross ("Bridge not to be crossed.") or that have a mass limit
  // ("...by vehicles over 11t"). These block the route. With no mass entered, a mass-limited bridge is treated as closed.
  function bridgeRule(b, mass) {
    const c = String((b.properties || b.props || {}).CONDITION || ''); if (!c) return null;
    const m = c.match(/over\s+(\d+(?:\.\d+)?)\s*t/i);
    if (m) return (!mass || mass > +m[1]) ? { limit: +m[1], unknown: !mass, text: c } : null;
    return /not to be crossed/i.test(c) ? { limit: 0, text: c } : null;
  }
  function blockBridges(G, data, mass, r) {
    let n = 0, unk = 0;
    for (const b of (data && data.br) || []) {
      if (!b.geometry) continue; const rule = bridgeRule(b, mass); if (!rule) continue;
      let hit = 0; for (const { ei, d } of RAV.nearEdges(G, b.geometry.coordinates, 30)) if (RAV.namesMatch(RAV.edgeName(G, ei), (b.properties || {}).ROAD_NAME) || d < 8) { r.blocked.add(ei); hit++; }
      if (hit) { n++; if (rule.unknown) unk++; }
    }
    if (n) r.notes.push({ kind: 'bridge', text: `Avoiding ${n} bridge${n > 1 ? 's' : ''} Main Roads lists as not to be crossed by this network or mass.${unk ? ' No total mass entered, so mass-limited bridges are treated as closed to you.' : ''}` });
  }
  function blockClosures(G, r) {
    let closed = 0;
    for (const a of closuresBlocking()) { const lines = a.geom.type === 'MultiLineString' ? a.geom.coordinates : a.geom.type === 'LineString' ? [a.geom.coordinates] : [[a.geom.coordinates]]; for (const L of lines) for (let i = 0; i < L.length; i += Math.max(1, Math.floor(L.length / 40))) for (const { ei } of RAV.nearEdges(G, L[i], 30)) { if (!r.blocked.has(ei)) closed++; r.blocked.add(ei); } }
    if (closed) r.notes.push({ kind: 'closure', text: 'Avoiding roads currently closed (Main Roads live data).' });
  }
  function restrictions(G, profile, pts, prefs) {
    const dims = RR.vehicles.dims(profile);
    const zones = C.zones.filter(z => !pts.some(p => RAV.inPoly(p, z.poly)));
    const key = [state.key, JSON.stringify(dims), profile.dg, JSON.stringify(prefs), zones.length, state.alerts.length, G === state.base ? 'b' : state.local.key].join('/');
    if (state.restr && state.restrKey === key && state.restrG === G) return state.restr;
    const r = RAV.restrictions(G, dims, { structures: state.structures, zones, allZones: C.zones, prohibited: state.data.prohibited || [] });
    blockBridges(G, state.data, dims.mass, r);
    // placarded dangerous goods: Northbridge Tunnel
    if (profile.dg) { const b = C.dgTunnel.box; let n = 0; G.E.forEach((e, ei) => { const m = G.coords[e.path[Math.floor(e.path.length / 2)]]; if (m[0] > b[0] && m[0] < b[2] && m[1] > b[1] && m[1] < b[3] && C.dgTunnel.road.test(RAV.edgeName(G, ei))) { r.blocked.add(ei); n++; } }); if (n) r.notes.push({ kind: 'dg', text: 'Placarded dangerous goods: avoiding the Northbridge Tunnel (Graham Farmer Freeway).' }); }
    // live road closures
    blockClosures(G, r);
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
  // A swap trip is a chain of segments, each driven as vehicle 1 (the full combination, on its network) or
  // vehicle 2 (the broken-down vehicle, on its network). Stops between segments are the drop-off, the delivery
  // and the hook-up. `ret`: 'none' = finish at the delivery; 'rtaa' = come back and hook up; 'start' = then return to the start.
  const SWAP_MIN = 30; // minutes allowed to drop or hook up trailers
  let swapCtx = null;
  async function swapContext(profile, profile2, pts, prefs, onStatus) {
    const G1 = state.base, { G: G2, data: d2 } = await graphForKey(profile2.net, onStatus);
    const r1 = restrictions(G1, profile, pts, prefs);
    const dims2 = RR.vehicles.dims(profile2), zones = C.zones.filter(z => !pts.some(p => RAV.inPoly(p, z.poly)));
    const r2 = RAV.restrictions(G2, dims2, { structures: state.structures, zones, allZones: C.zones, prohibited: d2.prohibited || [] });
    blockBridges(G2, d2, dims2.mass, r2); if (prefs.closures !== false) blockClosures(G2, r2);
    swapCtx = { G1, G2, r1, r2, profile, profile2, dims2, pts, prefs };
    return swapCtx;
  }
  function swapSegs(a, b, f, labels, profile2, ret) {
    const segs = [
      { to: f.at, label: f.name, veh: 1, arrive: `${f.name}: drop trailers, continue as ${profile2.name}`, wait: SWAP_MIN },
      { to: b, label: labels[1], veh: 2, arrive: ret === 'none' ? null : `${labels[1].split(',')[0]}: deliver, then return for the trailers`, wait: 0 }
    ];
    if (ret !== 'none') segs.push({ to: f.at, label: f.name, veh: 2, arrive: ret === 'start' ? `${f.name}: hook up trailers, continue as the full combination` : null, wait: ret === 'start' ? SWAP_MIN : 0 });
    if (ret === 'start') segs.push({ to: a, label: labels[0], veh: 1, arrive: null, wait: 0 });
    return segs;
  }
  // route a chain of segments from `from`; stop numbers start at firstStopNo
  function chainSwap(from, fromLabel, segs, firstStopNo) {
    const X = swapCtx, legs = []; let p = from, pl = fromLabel;
    for (const sg of segs) {
      const G = sg.veh === 1 ? X.G1 : X.G2, rr = sg.veh === 1 ? X.r1 : X.r2;
      const leg = RAV.routeVia(G, [p, sg.to], [pl, sg.label], 1, { blocked: rr.blocked, slow: rr.slow, pen: sg.veh === 1 ? rr.pen : undefined });
      if (leg.error) return { error: `${sg.veh === 1 ? X.profile.name : X.profile2.name} to ${sg.label.split(',')[0]}: ${leg.error}` };
      legs.push({ leg, sg, G }); p = sg.to; pl = sg.label;
    }
    const r = { line: [], steps: [], total: 0, secs: 0, legs2: [], conditions: [], rulesNear: [], bridgesNear: [], tight: [] };
    let conf = null;
    legs.forEach(({ leg, sg, G }, i) => {
      r.line.push(...(i ? leg.line.slice(1) : leg.line));
      leg.steps.forEach(st => r.steps.push(i ? { ...st, instr: st.instr.replace(/^Start on/, 'Leave on') } : { ...st }));
      if (i < legs.length - 1) r.steps.push({ instr: `Arrive at stop ${firstStopNo + i}:`, name: sg.arrive || sg.label, len: 0, at: sg.to, pts: [sg.to], stop: firstStopNo + i });
      r.total += leg.total; r.secs += leg.secs + sg.wait * 60;
      r.legs2.push(...leg.legs2); r.conditions.push(...leg.conditions); r.rulesNear.push(...leg.rulesNear); r.bridgesNear.push(...(leg.bridgesNear || []));
      r.tight.push(...RAV.tightStructures(leg.line, { structures: state.structures }, sg.veh === 1 ? RR.vehicles.dims(X.profile).height : X.dims2.height));
      const c = confidence(G, { ...leg, s: i === 0 ? leg.s : { d: 0 }, t: i === legs.length - 1 ? leg.t : { d: 0 } });
      conf = conf ? mergeConf(conf, c) : c;
    });
    r.joinGap = Math.max(0, ...legs.flatMap(({ leg }, i) => [i < legs.length - 1 ? leg.t.d : 0, i > 0 ? leg.s.d : 0]));
    r.s = legs[0].leg.s; r.t = legs[legs.length - 1].leg.t; r.conf = conf;
    r.along = alongRoute(r); r.zones = RAV.zonesOnRoute(r.line, C.zones); r.metro = r.line.some(C.metro);
    return r;
  }
  async function planSwap({ pts, labels, profile, profile2, prefs = {}, ret = 'none', onStatus }) {
    if (pts.length !== 2 || !profile2) return null;
    const rtaas = state.facilities.filter(f => f.kind === 'rtaa'); if (!rtaas.length) return null;
    await swapContext(profile, profile2, pts, prefs, onStatus);
    onStatus && onStatus('Checking road train assembly areas…'); await new Promise(r => setTimeout(r, 10));
    const [a, b] = pts, direct = hav(a, b);
    const cands = rtaas.map(f => ({ f, score: hav(a, f.at) + hav(f.at, b) })).filter(x => x.score < direct * 1.6 + 30000).sort((x, y) => x.score - y.score).slice(0, 8);
    let best = null;
    for (const { f } of cands) {
      const out = chainSwap(a, labels[0], swapSegs(a, b, f, labels, profile2, 'none'), 1);
      if (out.error || out.legs2.length < 2) continue;
      if (out.joinGap > 400) continue; // both vehicles must actually be able to reach the assembly area
      if (!best || out.secs < best.secs) best = { f, secs: out.secs };
    }
    if (!best) return null;
    const f = best.f, segs = swapSegs(a, b, f, labels, profile2, ret);
    const r = chainSwap(a, labels[0], segs, 1); if (r.error) return null;
    return finishSwap(r, segs, { f, labels, pts, profile2, ret }, 0);
  }
  function finishSwap(r, allSegs, meta, done) {
    const { f, labels, pts, profile2, ret } = meta;
    r.swap = { at: f.at, name: f.name, to: profile2.name, net2: profile2.net, ret, done, dest: { pt: pts[1], label: labels[1] }, waits: allSegs.slice(done).reduce((n, sg) => n + sg.wait, 0), meta };
    r.allSegs = allSegs;
    r.run = { ids: [], pts: [pts[0], ...allSegs.map(sg => sg.to)], labels: [labels[0], ...allSegs.map(sg => sg.label)] };
    const short = f.name.replace(/road train assembly area/i, 'RTAA');
    r.label = ret === 'none' ? `Swap at ${short}` : ret === 'rtaa' ? `Swap at ${short}, return for trailers` : `Swap at ${short}, round trip`;
    return r;
  }
  // reroute a swap trip from the current position; `reached` = stops already passed
  function rerouteSwap(route, pos, reached, refreshClosures) {
    if (!swapCtx || !route.allSegs) return { error: 'Swap details are no longer loaded. Plan the trip again.' };
    if (refreshClosures) { swapCtx.r1 = restrictions(swapCtx.G1, swapCtx.profile, swapCtx.pts, swapCtx.prefs); blockClosures(swapCtx.G2, swapCtx.r2); }
    const rest = route.allSegs.slice(reached); if (!rest.length) return { error: 'Trip already complete.' };
    const r = chainSwap(pos, 'Current position', rest, reached + 1); if (r.error) return r;
    return finishSwap(r, route.allSegs, route.swap.meta, reached);
  }
  // which vehicle the driver is in after passing `reached` stops
  const swapVehicle = (route, reached) => (route.allSegs[Math.min(reached, route.allSegs.length - 1)] || {}).veh === 2 ? swapCtx && swapCtx.profile2 : swapCtx && swapCtx.profile;
  return { state, prepare, plan, reroute, alongRoute, closuresBlocking, restrictions, planSwap, rerouteSwap, swapVehicle, bridgeRule };
})();
