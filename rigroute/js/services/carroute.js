// Car routing. Cars don't run on the heavy vehicle networks, so their routes come from an OpenStreetMap
// routing service (OSRM, run by FOSSGIS: one request a second at most, no uptime promise), which knows one-way
// streets and turn bans where they are mapped. The answer is converted into the same route shape the truck
// router produces, so driving mode, the speed display, alerts and stops all work unchanged.
// Car routes are never offered to a truck profile.
RR.car = (() => {
  const C = RR.config, hav = (a, b) => RAV.hav(a, b);
  const is = v => !!v && v.type === 'car';
  let last = 0;
  async function ask(pts, alts) {
    const wait = last + 1100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); // service limit: one request a second
    last = Date.now();
    const url = C.endpoints.osrm + pts.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';') + '?overview=full&geometries=geojson&steps=true&alternatives=' + (alts ? '2' : 'false');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try {
      const res = await fetch(url, { signal: ctl.signal }); const j = await res.json().catch(() => null);
      if (j && j.code === 'Ok' && j.routes && j.routes.length) return j;
      if (j && (j.code === 'NoRoute' || j.code === 'NoSegment')) return { none: true };
      throw new Error((j && j.message) || 'Routing service returned ' + res.status);
    } finally { clearTimeout(t); }
  }
  const DIR = { 'sharp left': 'Make a sharp left', left: 'Turn left', 'slight left': 'Bear left', straight: 'Continue', 'slight right': 'Bear right', right: 'Turn right', 'sharp right': 'Make a sharp right', uturn: 'Make a U-turn' };
  const side = m => /left/.test(m) ? ' left' : /right/.test(m) ? ' right' : '';
  // "66: City Centre, Northbridge" -> "City Centre"
  const destOfStep = s => String(s.destinations || '').split(',')[0].replace(/^[^:]*:\s*/, '').trim();
  function verbFor(s, first) {
    const mv = s.maneuver, t = mv.type, m = mv.modifier || 'straight';
    if (t === 'depart') return first ? 'Start on' : 'Leave on';
    if (t === 'roundabout' || t === 'rotary') return 'At the roundabout, take exit ' + (mv.exit || 1);
    if (t === 'roundabout turn') return 'At the roundabout, ' + (DIR[m] || 'continue').replace(/^[A-Z]/, c => c.toLowerCase());
    if (t === 'merge') return 'Merge';
    if (t === 'on ramp') return 'Take the ramp' + (side(m) ? ' on the' + side(m) : '');
    if (t === 'off ramp') return 'Take the exit' + (side(m) ? ' on the' + side(m) : '');
    if (t === 'fork') return 'Keep' + (side(m) || ' straight');
    return DIR[m] || 'Continue';
  }
  // the service leaves long straights as two far-apart points; the app matches alerts, stops and closures against
  // route points, so fill straights in to one point every ~100 m
  function densify(L) { const out = [L[0]]; for (let i = 1; i < L.length; i++) { const a = L[i - 1], b = L[i], n = Math.min(400, Math.ceil(hav(a, b) / 100)); for (let k = 1; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); out.push(b); } return out; }
  function lanesFor(s, prevS) {
    const at = s.maneuver.location; let L = s.intersections && s.intersections[0] && s.intersections[0].lanes;
    if (!L && prevS && prevS.intersections) for (let i = prevS.intersections.length - 1; i >= 0; i--) { const x = prevS.intersections[i]; if (hav(x.location, at) > 300) break; if (x.lanes) { L = x.lanes; break; } }
    if (!L || L.length < 2 || L.every(l => l.valid) || !L.some(l => l.valid)) return null; // only worth showing when some lanes are wrong
    return L.map(l => ({ ind: (l.indications || ['none']).filter(Boolean), ok: !!l.valid }));
  }
  function convert(o, wps, labels, firstStopNo) {
    const steps = []; let rb = null, prevS = null;
    o.legs.forEach((leg, li) => (leg.steps || []).forEach(s => {
      const ps = prevS; prevS = s;
      const mv = s.maneuver, t = mv.type, g = (s.geometry && s.geometry.coordinates) || [mv.location];
      if (t === 'arrive') { if (li < o.legs.length - 1) steps.push({ instr: `Arrive at stop ${firstStopNo + li}:`, name: labels[li + 1], len: 0, at: g[0], pts: [g[0]], stop: firstStopNo + li }); rb = null; return; }
      const name = s.name || (s.ref ? String(s.ref).split(';')[0] : ''), prev = steps[steps.length - 1];
      const add = () => { prev.len += s.distance; prev.pts.push(...g.slice(1)); };
      if ((t === 'exit roundabout' || t === 'exit rotary') && rb) { if (name) { rb.name = name; if (!/ onto$/.test(rb.instr)) rb.instr += ' onto'; } add(); rb = null; return; }
      rb = null;
      const straight = (mv.modifier || 'straight') === 'straight';
      // same road carrying straight on, or a sliver with nothing to say: fold into the step before
      if (prev && !prev.stop && t !== 'depart' && ((straight && (t === 'new name' || t === 'continue' || t === 'notification' || t === 'turn') && (!name || name === prev.name)) || (s.distance < 3 && !name))) return add();
      let verb = verbFor(s, li === 0), nm = name, prep = ' onto';
      if (!nm && (t === 'off ramp' || t === 'on ramp' || t === 'fork')) { nm = destOfStep(s); prep = ' towards'; }
      const st = { instr: t === 'depart' ? (nm ? verb : verb.replace(/ on$/, '')) : verb + (nm ? prep : ''), name: nm, len: s.distance, at: mv.location, pts: g.slice(), td: mv.bearing_before != null && mv.bearing_after != null ? ((mv.bearing_after - mv.bearing_before + 540) % 360) - 180 : 0 };
      const lanes = lanesFor(s, ps); if (lanes) st.lanes = lanes;
      steps.push(st); if (t === 'roundabout' || t === 'rotary') rb = st;
    }));
    const line = densify(o.geometry.coordinates), snapOf = i => ({ d: wps[i].distance || 0, pt: wps[i].location });
    const r = {
      car: true, line, steps, total: o.distance, secs: o.duration,
      legs2: o.legs.map((leg, i) => ({ legs: [], total: leg.distance, secs: leg.duration, s: snapOf(i), t: snapOf(i + 1) })),
      s: snapOf(0), t: snapOf(wps.length - 1), conditions: [], rulesNear: [], bridgesNear: [], tight: [], zones: [],
      conf: { seg: { confirmed: 0, conditional: 0, general: o.distance, unverified: 0 }, parts: [], gaps: [] }
    };
    r.metro = line.some(C.metro); r.along = RR.routing.alongRoute(r); r.closed = closuresOn(r);
    return r;
  }
  // live Main Roads closures that sit on this route (the routing service doesn't know about them)
  function closuresOn(r) {
    const L = r.line, st = Math.max(1, Math.floor(L.length / 3000)), out = [];
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90; for (const p of L) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    for (const a of RR.routing.closuresBlocking()) {
      const g = a.geom, pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : [];
      let hit = false;
      for (let j = 0; j < pts.length && !hit; j += Math.max(1, Math.floor(pts.length / 40))) { const p = pts[j]; if (p[0] < x0 - 0.002 || p[0] > x1 + 0.002 || p[1] < y0 - 0.002 || p[1] > y1 + 0.002) continue; for (let i = 0; i < L.length; i += st) if (hav(p, L[i]) < 60) { hit = true; break; } }
      if (hit) out.push(a);
    }
    return out;
  }
  // one route through the points, in the app's route shape; throws when the service can't be reached
  async function route(pts, labels, firstStopNo = 1, alts = false) {
    const j = await ask(pts, alts && pts.length === 2);
    if (j.none) return [{ error: 'No drivable route was found between those points.' }];
    return j.routes.map(o => convert(o, j.waypoints, labels, firstStopNo));
  }
  async function plan({ pts, labels, onStatus }) {
    onStatus && onStatus('Finding car routes…');
    const routes = await route(pts, labels, 1, true);
    if (routes[0].error) return { error: routes[0].error, restr: { notes: [] }, car: true };
    // a route with no live closure on it goes first
    const fastestClosed = routes[0].closed.length > 0;
    routes.sort((a, b) => (a.closed.length ? 1 : 0) - (b.closed.length ? 1 : 0) || a.secs - b.secs);
    const notes = fastestClosed && !routes[0].closed.length ? [{ kind: 'closure', text: 'The quickest way has a road closed on it (Main Roads live data), so this route goes another way.' }] : [];
    routes.forEach((r, i) => { r.idx = i; r.label = i === 0 ? (notes.length ? 'Fastest open route' : 'Fastest route') : `Alternative ${i}`; });
    routes.slice(1).forEach(r => { const base = new Set(routes[0].steps.map(s => s.name)); const via = r.steps.filter(s => s.len > 1500 && s.name && !s.stop).map(s => s.name).find(n => !base.has(n)); if (via) r.label = 'Via ' + via; });
    return { routes, restr: { notes }, car: true };
  }
  // while driving: a fresh route from here, preferring one that avoids live closures
  async function reroute(pts, labels, firstStopNo) {
    const routes = await route(pts, labels, firstStopNo, true);
    if (routes[0].error) return routes[0];
    routes.sort((a, b) => (a.closed.length ? 1 : 0) - (b.closed.length ? 1 : 0) || a.secs - b.secs);
    return routes[0];
  }
  return { is, plan, route, reroute, closuresOn };
})();
