// ===== RAV routing core (no DOM) =====
const RAV = (() => {
  const R = 6371008.8, D2R = Math.PI / 180;
  function hav(a, b) { // [lon,lat]
    const dLat = (b[1] - a[1]) * D2R, dLon = (b[0] - a[0]) * D2R;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin((b[0] - a[0]) * D2R) * Math.cos(b[1] * D2R);
    const x = Math.cos(a[1] * D2R) * Math.sin(b[1] * D2R) - Math.sin(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.cos((b[0] - a[0]) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  const turnDelta = (bin, bout) => ((bout - bin + 540) % 360) - 180; // <0 left, >0 right
  // local planar projection (metres) around a latitude
  const kx = lat => 111320 * Math.cos(lat * D2R), KY = 110574;
  function projPointSeg(p, a, b) { // returns {d, t}
    const cx = kx(p[1]);
    const ax = (a[0] - p[0]) * cx, ay = (a[1] - p[1]) * KY, bx = (b[0] - p[0]) * cx, by = (b[1] - p[1]) * KY;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.hypot(x, y), t };
  }
  const normName = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(road|rd|street|st|highway|hwy|drive|dr|avenue|ave|av|way|wy|lane|ln|place|pl|terrace|tce|parade|pde|crescent|cres|court|ct|boulevard|bvd|blvd|north|south|east|west|nth|sth|n|s|e|w|access|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const namesMatch = (a, b) => { a = normName(a); b = normName(b); return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a)); };
  const stripHtml = s => (s || '').replace(/<\/li>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').split('\n').map(x => x.trim()).filter(Boolean);
  const NOT_THROUGH = /not be used as a through route|local (access|delivery)|access to local properties/i;

  // ---- spatial grid ----
  function Grid(cell) { this.cell = cell; this.m = new Map(); }
  Grid.prototype.key = function (lon, lat) { return Math.floor(lon / this.cell) + ':' + Math.floor(lat / this.cell); };
  Grid.prototype.add = function (lon, lat, v) { const k = this.key(lon, lat); let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(v); };
  Grid.prototype.near = function (lon, lat, r) { // r in cells
    const cx = Math.floor(lon / this.cell), cy = Math.floor(lat / this.cell), out = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) { const a = this.m.get((cx + i) + ':' + (cy + j)); if (a) for (const v of a) out.push(v); }
    return out;
  };

  // ---- graph build ----
  // features: GeoJSON features (LineString/MultiLineString) with props ROAD_NAME, CONDITION, CURFEW, MAX_SPEED, COMMENTS
  // turnRules: GeoJSON point features with props CONDITION, NODE_DESCR
  function build(features, turnRules, bridges, opts = {}) {
    const healM = opts.healMetres ?? 25;
    // vertices within ~1.5 m are merged (source data has sub-metre mismatches at joins)
    const idx = new Map(), coords = [], vadj = []; // vertex graph
    const node = c => {
      const gx = Math.round(c[0] * 1e5), gy = Math.round(c[1] * 1e5);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const i = idx.get((gx + dx) + ',' + (gy + dy));
        if (i !== undefined && Math.abs(coords[i][0] - c[0]) < 1.6e-5 && Math.abs(coords[i][1] - c[1]) < 1.4e-5) return i;
      }
      const i = coords.length; idx.set(gx + ',' + gy, i); coords.push([+c[0].toFixed(6), +c[1].toFixed(6)]); vadj.push([]); return i;
    };
    const feats = features.map(f => {
      const p = f.properties || {};
      const conds = [...stripHtml(p.CONDITION), ...stripHtml(p.COMMENTS)];
      if (p.CURFEW) conds.push('Curfew: ' + stripHtml(p.CURFEW).join(' '));
      const ms = parseFloat(p.MAX_SPEED);
      if (p.MAX_SPEED && !conds.some(c => /speed/i.test(c))) conds.push('Max speed ' + stripHtml(String(p.MAX_SPEED)).join(' ') + (isNaN(ms) ? '' : ' km/h'));
      return { name: p.ROAD_NAME || 'Unnamed road', conds, notThrough: conds.some(c => NOT_THROUGH.test(c)), speed: (!isNaN(ms) && ms > 10 && ms < 120) ? ms : null, state: /state/i.test(p.NETWORK_TYPE || ''), unsealed: conds.some(c => /unsealed/i.test(c)) };
    });
    features.forEach((f, fi) => {
      const g = f.geometry; if (!g) return;
      const lines = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
      for (const L of lines) for (let k = 1; k < L.length; k++) {
        const a = node(L[k - 1]), b = node(L[k]); if (a === b) continue;
        vadj[a].push([b, fi]); vadj[b].push([a, fi]);
      }
    });
    // heal: connect dead ends to nearest vertex of a different feature within healM
    const cellDeg = 0.002, grid = new Grid(cellDeg);
    coords.forEach((c, i) => grid.add(c[0], c[1], i));
    let healed = 0;
    for (let i = 0; i < coords.length; i++) {
      if (vadj[i].length !== 1) continue;
      // vertices already close along the graph (same line, a few steps back) don't count
      const near = new Set([i]); let fr = [i];
      for (let h = 0; h < 6; h++) { const nf = []; for (const u of fr) for (const [w] of vadj[u]) if (!near.has(w)) { near.add(w); nf.push(w); } fr = nf; }
      let best = -1, bd = healM;
      for (const j of grid.near(coords[i][0], coords[i][1], 1)) {
        if (near.has(j)) continue;
        const d = hav(coords[i], coords[j]); if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) { vadj[i].push([best, -1]); vadj[best].push([i, -1]); healed++; }
    }
    // contract to junction graph: junction = degree != 2, or feature changes, or rule point
    const nV = coords.length, isJ = new Uint8Array(nV);
    for (let i = 0; i < nV; i++) { const a = vadj[i]; if (a.length !== 2 || a[0][1] !== a[1][1]) isJ[i] = 1; }
    // rule points -> force junction at nearest vertex
    const rules = [];
    for (const r of (turnRules || [])) {
      const c = r.geometry && r.geometry.coordinates; if (!c) continue;
      let best = -1, bd = 40;
      for (const j of grid.near(c[0], c[1], 1)) { if (vadj[j].length < 3) continue; const d = hav(c, coords[j]); if (d < bd) { bd = d; best = j; } }
      const text = stripHtml(r.properties.CONDITION).join(' ');
      const parsed = parseRule(text);
      rules.push({ v: best, text, where: r.properties.NODE_DESCR, at: c, parsed });
      if (best >= 0) isJ[best] = 1;
    }
    const jId = new Int32Array(nV).fill(-1), J = [];
    for (let i = 0; i < nV; i++) if (isJ[i]) { jId[i] = J.length; J.push(i); }
    // edges (undirected chains), directed ids: 2e (a->b), 2e+1 (b->a)
    const E = []; const seen = new Set();
    for (const s of J) for (const [n1, f1] of vadj[s]) {
      const pk = s < n1 ? s + '_' + n1 : n1 + '_' + s; if (seen.has(pk + '_' + f1)) continue;
      const path = [s]; let prev = s, cur = n1, len = hav(coords[s], coords[n1]); seen.add(pk + '_' + f1);
      let guard = 0;
      while (!isJ[cur] && guard++ < 1e6) {
        path.push(cur);
        const nx = vadj[cur][0][0] === prev ? vadj[cur][1] : vadj[cur][0];
        const k2 = cur < nx[0] ? cur + '_' + nx[0] : nx[0] + '_' + cur; seen.add(k2 + '_' + nx[1]);
        len += hav(coords[cur], coords[nx[0]]); prev = cur; cur = nx[0];
      }
      if (cur === s && path.length < 2) continue;
      path.push(cur);
      const f = f1;
      E.push({ a: jId[s], b: jId[cur], path, len, f });
    }
    // adjacency of directed edges out of junction
    const out = J.map(() => []);
    E.forEach((e, i) => { out[e.a].push(2 * i); out[e.b].push(2 * i + 1); });
    // attach rules to junctions
    const jRules = new Map();
    for (const r of rules) if (r.v >= 0 && r.parsed) { const j = jId[r.v]; if (!jRules.has(j)) jRules.set(j, []); jRules.get(j).push(r); }
    // segment grid for snapping
    const sgrid = new Grid(0.01);
    E.forEach((e, ei) => { for (let k = 1; k < e.path.length; k++) { const a = coords[e.path[k - 1]], b = coords[e.path[k]]; sgrid.add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ei * 1e6 + k); } });
    // long segments may cross several cells: also index endpoints
    E.forEach((e, ei) => { for (let k = 1; k < e.path.length; k++) { const a = coords[e.path[k - 1]], b = coords[e.path[k]]; const L = hav(a, b); if (L > 800) { const n = Math.ceil(L / 800); for (let s = 1; s < n; s++) sgrid.add(a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n, ei * 1e6 + k); } } });
    const brs = (bridges || []).filter(b => b.geometry).map(b => ({ at: b.geometry.coordinates, props: b.properties }));
    return { coords, feats, E, J, out, jRules, rules, sgrid, healed, brs, nVert: nV };
  }

  function parseRule(t) {
    const tf = /no\s+access\s+to\s+or\s+from\s+(.+?)\.?$/i.exec(t);
    if (tf) return { kind: 'tofrom', road: tf[1].replace(/\.$/, '') };
    const m = /no\s+(left|right|u)[\s-]*turns?\b.*?(?:into|onto|to)\s+(.+?)\s+from\s+(.+?)\.?$/i.exec(t)
      || /no\s+(access|entry|through)\b.*?(?:into|onto|to)\s+(.+?)\s+from\s+(.+?)\.?$/i.exec(t);
    if (!m) return null;
    return { kind: m[1].toLowerCase(), into: m[2].replace(/\.$/, ''), from: m[3].replace(/\.$/, '') };
  }

  // directed edge helpers
  const dirPath = (G, d) => { const e = G.E[d >> 1]; return (d & 1) ? e.path.slice().reverse() : e.path; };
  const head = (G, d) => { const e = G.E[d >> 1]; return (d & 1) ? e.a : e.b; };
  const tail = (G, d) => { const e = G.E[d >> 1]; return (d & 1) ? e.b : e.a; };
  function endBearing(G, d) { const p = dirPath(G, d); const n = p.length; const end = G.coords[p[n - 1]]; let k = n - 2, acc = 0; while (k > 0 && (acc = hav(G.coords[p[k]], end)) < 30) k--; return bearing(G.coords[p[k]], end); }
  function startBearing(G, d) { const p = dirPath(G, d); const st = G.coords[p[0]]; let k = 1; while (k < p.length - 1 && hav(st, G.coords[p[k]]) < 30) k++; return bearing(st, G.coords[p[k]]); }
  const nameOfEdge = (G, d) => { const f = G.E[d >> 1].f; return f >= 0 ? G.feats[f].name : ''; };

  function banned(G, din, dout) {
    if ((din ^ 1) === dout) return true; // no U-turn back along same edge
    const j = head(G, din); const rs = G.jRules.get(j); if (!rs) return false;
    const nin = nameOfEdge(G, din), nout = nameOfEdge(G, dout);
    for (const r of rs) {
      const p = r.parsed;
      if (p.kind === 'tofrom') { if (nin !== nout && (namesMatch(nin, p.road) || namesMatch(nout, p.road)) && !(namesMatch(nin, p.road) && namesMatch(nout, p.road))) return true; continue; }
      if (!namesMatch(nin, p.from) || !namesMatch(nout, p.into)) continue;
      if (p.kind === 'access' || p.kind === 'entry' || p.kind === 'through' || p.kind === 'u') return true;
      const td = turnDelta(endBearing(G, din), startBearing(G, dout));
      if (p.kind === 'left' && td < -20) return true;
      if (p.kind === 'right' && td > 20) return true;
    }
    return false;
  }

  // planning speed (km/h): posted RAV limit if given, else 90 on state roads, 70 on local roads
  const speedOf = f => !f ? 60 : f.speed ? Math.min(f.speed, 90) : f.state ? 90 : 70;
  function edgeCost(G, ei, len, endpointEdges) {
    const e = G.E[ei]; const f = e.f >= 0 ? G.feats[e.f] : null;
    let c = len / (speedOf(f) / 3.6);
    if (f && f.conds.length) c *= 1.25; // prefer roads without conditions
    if (f && f.notThrough && !endpointEdges.has(ei)) c *= 25;
    return c;
  }

  function snap(G, p, maxM = 50000) {
    let best = null;
    const test = code => { const ei = Math.floor(code / 1e6), k = code % 1e6, e = G.E[ei]; const pr = projPointSeg(p, G.coords[e.path[k - 1]], G.coords[e.path[k]]); if (!best || pr.d < best.d) best = { d: pr.d, ei, k, t: pr.t }; };
    let r = 1;
    for (; r <= 64; r *= 2) { for (const c of G.sgrid.near(p[0], p[1], r)) test(c); if (best) break; }
    if (best && r <= 64) for (const c of G.sgrid.near(p[0], p[1], r * 2 + 1)) test(c); // nearer segment may sit in an outer ring
    if (!best || best.d > maxM) return null;
    const e = G.E[best.ei], a = G.coords[e.path[best.k - 1]], b = G.coords[e.path[best.k]];
    const pt = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
    let toA = hav(pt, a); for (let k = best.k - 1; k > 0; k--) toA += hav(G.coords[e.path[k]], G.coords[e.path[k - 1]]);
    return { ...best, pt, toA, toB: Math.max(0, e.len - toA) };
  }

  // binary heap
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; };
  Heap.prototype.pop = function () { const k = this.k, v = this.v, top = v[0], tk = k[0]; const lk = k.pop(), lv = v.pop(); const n = k.length; if (n) { let i = 0; while (true) { let l = 2 * i + 1, r = l + 1, m = i, mk = lk; if (l < n && k[l] < mk) { m = l; mk = k[l]; } if (r < n && k[r] < mk) { m = r; mk = k[r]; } if (m === i) break; k[i] = k[m]; v[i] = v[m]; i = m; } k[i] = lk; v[i] = lv; } this.lastKey = tk; return top; };
  Heap.prototype.size = function () { return this.k.length; };

  // edge-based Dijkstra with turn bans
  function route(G, from, to) {
    const s = snap(G, from), t = snap(G, to);
    if (!s || !t) return { error: 'Could not find the approved network near ' + (!s ? 'the start' : 'the destination') + '.' };
    const ends = new Set([s.ei, t.ei]);
    const nD = G.E.length * 2, dist = new Float64Array(nD).fill(Infinity), prev = new Int32Array(nD).fill(-2);
    const H = new Heap();
    const se = G.E[s.ei];
    const vS = speedOf(se.f >= 0 ? G.feats[se.f] : null) / 3.6;
    // virtual arrivals: travelling from snap point toward b == directed 2*ei arriving at b ; toward a == 2*ei+1 arriving at a
    const init = [[2 * s.ei, s.toB / vS], [2 * s.ei + 1, s.toA / vS]];
    for (const [d, c] of init) { dist[d] = c; prev[d] = -1; H.push(c, d); }
    const te = G.E[t.ei];
    const vT = speedOf(te.f >= 0 ? G.feats[te.f] : null) / 3.6;
    // same-edge direct case
    let best = Infinity, bestEnd = -1, bestMode = null;
    if (s.ei === t.ei) {
      const sa = s.toA, ta = t.toA;
      best = Math.abs(ta - sa) / vS; bestMode = 'same';
    }
    while (H.size()) {
      const d = H.pop(), c = H.lastKey; if (c > dist[d]) continue; if (c >= best) break;
      const j = head(G, d);
      // reaching destination edge from node j: entering t.ei from its a (dir 2ei) costs toA; from b (dir 2ei+1) costs toB
      for (const dout of G.out[j]) {
        if ((dout >> 1) === t.ei) {
          if (!banned(G, d, dout)) {
            const extra = (dout & 1) ? t.toB : t.toA; const tot = c + extra / vT;
            if (tot < best) { best = tot; bestEnd = d; bestMode = dout; }
          }
        }
        if (banned(G, d, dout)) continue;
        const ei = dout >> 1; const nc = c + edgeCost(G, ei, G.E[ei].len, ends);
        if (nc < dist[dout]) { dist[dout] = nc; prev[dout] = d; H.push(nc, dout); }
      }
    }
    if (best === Infinity) return { error: 'No legal route found on this network between those points.', s, t };
    // reconstruct
    const seq = [];
    if (bestMode !== 'same') { let d = bestEnd; while (d >= 0) { seq.push(d); d = prev[d]; } seq.reverse(); }
    return assemble(G, s, t, seq, bestMode, best);
  }

  function assemble(G, s, t, seq, finalDir, secs) {
    // build polyline + steps. seq[0] is a virtual directed edge on s.ei (partial)
    const legs = []; // {name, f, coords:[...], len}
    const C = G.coords;
    function partial(ei, fromPt, k, dirToB) { // from snapped point along edge toward b (dirToB) or a
      const e = G.E[ei]; const pts = [fromPt];
      if (dirToB) for (let i = k; i < e.path.length; i++) pts.push(C[e.path[i]]);
      else for (let i = k - 1; i >= 0; i--) pts.push(C[e.path[i]]);
      return pts;
    }
    if (finalDir === 'same') {
      const e = G.E[s.ei]; const forward = t.toA >= s.toA; const pts = [s.pt];
      if (forward) { for (let i = s.k; i < t.k; i++) pts.push(C[e.path[i]]); } else { for (let i = s.k - 1; i >= t.k; i--) pts.push(C[e.path[i]]); }
      pts.push(t.pt); legs.push({ ei: s.ei, d: forward ? 2 * s.ei : 2 * s.ei + 1, pts });
    } else {
      seq.forEach((d, i) => {
        const ei = d >> 1;
        if (i === 0) legs.push({ ei, d, pts: partial(ei, s.pt, s.k, (d & 1) === 0) });
        else legs.push({ ei, d, pts: dirPath(G, d).map(v => C[v]) });
      });
      const de = finalDir, ei = de >> 1; const e = G.E[ei];
      // from node into t edge to snap point
      const pts = [];
      if ((de & 1) === 0) { for (let i = 0; i < t.k; i++) pts.push(C[e.path[i]]); } else { for (let i = e.path.length - 1; i >= t.k; i--) pts.push(C[e.path[i]]); }
      pts.push(t.pt); legs.push({ ei, d: de, pts });
    }
    // lengths
    for (const L of legs) { L.len = 0; for (let i = 1; i < L.pts.length; i++) L.len += hav(L.pts[i - 1], L.pts[i]); }
    // steps: merge by name
    const nm = L => { const f = G.E[L.ei].f; return f >= 0 ? G.feats[f].name : null; };
    const steps = [];
    let cur = null;
    legs.forEach((L, i) => {
      const name = nm(L) || (cur ? cur.name : 'connector');
      if (cur && (name === cur.name || L.len < 1)) { cur.len += L.len; cur.pts.push(...L.pts.slice(1)); return; }
      let instr = 'Start on', td = 0;
      if (cur) {
        const a = cur.pts, b = L.pts;
        const pin = pick(a, true), pout = pick(b, false);
        td = turnDelta(bearing(pin, a[a.length - 1]), bearing(b[0], pout));
        instr = td < -135 || td > 135 ? 'Make a sharp ' + (td < 0 ? 'left' : 'right') + ' onto'
          : td < -45 ? 'Turn left onto' : td > 45 ? 'Turn right onto'
          : td < -15 ? 'Bear left onto' : td > 15 ? 'Bear right onto' : 'Continue onto';
      }
      cur = { name, len: L.len, pts: L.pts.slice(), instr, at: L.pts[0], td };
      steps.push(cur);
    });
    // fold short roundabout / slip-road pieces into the following step
    const MINOR = /\bRty\b|roundabout|\boff to\b|\bon to\b|\bslip\b|\bramp\b/i;
    for (let i = 1; i < steps.length - 1; i++) {
      const s = steps[i];
      if (s.len < 250 && MINOR.test(s.name)) {
        const nx = steps[i + 1], pv = steps[i - 1];
        nx.pts = s.pts.concat(nx.pts.slice(1)); nx.len += s.len; nx.at = s.at; nx.viaRty = nx.viaRty || /\bRty\b|roundabout/i.test(s.name);
        steps.splice(i, 1); i--;
        const a = pv.pts, b = nx.pts, pin = pick(a, true);
        // bearing out: ~250 m along next step so the roundabout loop doesn't dominate
        let pout = b[b.length - 1]; for (let k = 1; k < b.length; k++) if (hav(b[0], b[k]) >= 250) { pout = b[k]; break; }
        const td = turnDelta(bearing(pin, a[a.length - 1]), bearing(b[0], pout));
        nx.instr = td < -45 ? 'Turn left onto' : td > 45 ? 'Turn right onto' : td < -15 ? 'Bear left onto' : td > 15 ? 'Bear right onto' : 'Continue onto';
        if (nx.viaRty) nx.instr = 'At the roundabout, ' + (td < -45 ? 'turn left onto' : td > 45 ? 'turn right onto' : td < -135 || td > 135 ? 'go back onto' : 'continue onto');
        if (pv.name === nx.name) { pv.len += nx.len; pv.pts.push(...nx.pts.slice(1)); steps.splice(i + 1, 1); }
      }
    }
    steps.forEach(s => { s.name = s.name.replace(/\s*\bRty\b/, ' roundabout'); });
    function pick(pts, fromEnd) { // point ~30m back/forward from the junction
      if (fromEnd) { const end = pts[pts.length - 1]; for (let i = pts.length - 2; i >= 0; i--) if (hav(pts[i], end) >= 30) return pts[i]; return pts[0]; }
      const st = pts[0]; for (let i = 1; i < pts.length; i++) if (hav(st, pts[i]) >= 30) return pts[i]; return pts[pts.length - 1];
    }
    const line = []; legs.forEach((L, i) => line.push(...(i ? L.pts.slice(1) : L.pts)));
    // conditions along route
    const condMap = new Map();
    for (const L of legs) { const f = G.E[L.ei].f; if (f < 0) continue; const F = G.feats[f]; for (const c of F.conds) { const k = F.name + '|' + c; if (!condMap.has(k)) condMap.set(k, { road: F.name, text: c, at: L.pts[Math.floor(L.pts.length / 2)], notThrough: NOT_THROUGH.test(c) }); } }
    // turn rules / bridges near route
    const near = (pt, m) => { for (let i = 1; i < line.length; i++) if (projPointSeg(pt, line[i - 1], line[i]).d < m) return true; return false; };
    const rulesNear = [];
    const lb = bbox(line, 0.01);
    for (const r of G.rules) if (inB(r.at, lb) && near(r.at, 40)) rulesNear.push(r);
    const bridgesNear = G.brs.filter(b => inB(b.at, lb) && near(b.at, 40));
    const total = legs.reduce((a, L) => a + L.len, 0);
    return { line, steps, legs, total, secs, s, t, conditions: [...condMap.values()], rulesNear, bridgesNear };
  }
  const bbox = (pts, pad) => { let x0 = 180, y0 = 90, x1 = -180, y1 = -90; for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]; };
  const inB = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

  return { build, route, snap, hav, parseRule, namesMatch, stripHtml };
})();
if (typeof module !== 'undefined') module.exports = RAV;
