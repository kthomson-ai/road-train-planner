// Speed limits along a route, from Main Roads WA "Legal Speed Limit" (queried only for the roads on the route).
// limitAt(route, along) -> { posted, limit, why } where `limit` also applies the heavy vehicle cap and any network speed condition.
RR.speed = (() => {
  const URL8 = () => RR.config.endpoints.assets + '8/query';
  const HV_CAP = 100, STEP = 50; // WA: vehicles over 12 t GVM are limited to 100 km/h; route sampled every 50 m
  const ramp = s => /\b(on|off) to\b|\bramp\b/i.test(s || '');
  // Douglas-Peucker in degrees (tolerance ~25 m)
  function simplify(pts, tol = 0.00025) {
    if (pts.length < 3) return pts; const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
    while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const [x1, y1] = pts[a], [x2, y2] = pts[b], dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy || 1e-12;
      for (let i = a + 1; i < b; i++) { const t = Math.max(0, Math.min(1, ((pts[i][0] - x1) * dx + (pts[i][1] - y1) * dy) / L)); const d = Math.hypot(pts[i][0] - x1 - t * dx, pts[i][1] - y1 - t * dy); if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
    return pts.filter((p, i) => keep[i]);
  }
  function densify(line, step) { const out = [line[0]]; for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], d = RAV.hav(a, b), n = Math.max(1, Math.ceil(d / step)); for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); } return out; }
  const cell = p => Math.floor(p[0] / 0.001) + ',' + Math.floor(p[1] / 0.001);

  function prepare(route) {
    const P = densify(route.line, STEP), cum = new Float64Array(P.length);
    for (let i = 1; i < P.length; i++) cum[i] = cum[i - 1] + RAV.hav(P[i - 1], P[i]);
    const grid = new Map(); P.forEach((p, i) => { const k = cell(p); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    // road name at each sample, from the turn-by-turn steps
    const names = new Array(P.length).fill(''); let a = 0, si = 0; const steps = route.steps.filter(s => s.len > 0); let end = steps.length ? steps[0].len : 0;
    for (let i = 0; i < P.length; i++) { while (si < steps.length - 1 && cum[i] > end) { si++; end += steps[si].len; } names[i] = steps[si] ? steps[si].name : ''; }
    // network speed conditions (e.g. "Max speed 90") from the approved-network data, where the route came from one graph
    const net = new Float32Array(P.length);
    try { const G = RR.routing.state.data.general ? null : RR.routing.state.base; if (G && !route.swap) { let d = 0; const spans = []; for (const lg of (route.legs2 || [])) for (const L of (lg.legs || [])) { const e = G.E[L.ei], f = e && e.f >= 0 ? G.feats[e.f] : null; if (f && f.speed) spans.push([d, d + L.len, f.speed]); d += L.len; } let j = 0; for (let i = 0; i < P.length; i++) { while (j < spans.length && spans[j][1] < cum[i]) j++; if (j < spans.length && spans[j][0] <= cum[i]) net[i] = spans[j][2]; } } } catch { }
    return { P, cum, grid, names, net, posted: new Float32Array(P.length), dist: new Float32Array(P.length).fill(1e9), done: false, failed: false };
  }
  function apply(S, feats) {
    for (const f of feats) {
      const v = /^(\d+)\s*km\/h$/i.exec(String(f.properties.SPEED_LIMIT || '').trim()); if (!v) continue; // "50 built-up / 110 outside" = no posted limit here
      const fname = f.properties.ROAD_NAME, isRamp = ramp(fname);
      const lines = f.geometry ? (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]) : [];
      for (const ln of lines) for (const q of densify(ln, 30)) {
        const cx = Math.floor(q[0] / 0.001), cy = Math.floor(q[1] / 0.001);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of (S.grid.get((cx + dx) + ',' + (cy + dy)) || [])) {
          const d = RAV.hav(q, S.P[i]); if (d > 35 || d >= S.dist[i]) continue;
          if (isRamp !== ramp(S.names[i]) || !RAV.namesMatch(fname, S.names[i])) continue;
          S.dist[i] = d; S.posted[i] = +v[1];
        }
      }
    }
  }
  async function load(route) {
    if (route._speed) return route._speed; const S = route._speed = prepare(route);
    // chunks of roughly 40 km, simplified, queried with a 40 m buffer
    const chunks = []; let start = 0;
    for (let i = 1; i < S.P.length; i++) if (S.cum[i] - S.cum[start] > 40000 || i === S.P.length - 1) { let pts = simplify(S.P.slice(start, i + 1)); if (pts.length > 45) pts = simplify(pts, 0.0006); chunks.push(pts.slice(0, 80)); start = i; }
    let fails = 0;
    const run = async pts => {
      const body = new URLSearchParams({ where: '1=1', geometry: JSON.stringify({ paths: [pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)])], spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPolyline', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', distance: '40', units: 'esriSRUnit_Meter', outFields: 'ROAD_NAME,SPEED_LIMIT', outSR: '4326', geometryPrecision: '5', maxAllowableOffset: '0.0001', f: 'geojson' });
      try { const r = await fetch(URL8(), { method: 'POST', body }); const j = await r.json(); if (j.error) throw new Error('q'); apply(S, j.features || []); RR.emit('speedlimits', route); } catch { fails++; }
    };
    for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(run)); // nearest chunks first
    // close small gaps (under 300 m) between equal limits
    for (let i = 1; i < S.posted.length; i++) if (!S.posted[i] && S.posted[i - 1]) { let j = i; while (j < S.posted.length && !S.posted[j] && j - i < 6) j++; if (j < S.posted.length && S.posted[j] === S.posted[i - 1]) for (let k = i; k < j; k++) S.posted[k] = S.posted[i - 1]; }
    S.done = true; S.failed = fails === chunks.length && chunks.length > 0; RR.emit('speedlimits', route);
    if (S.failed) setTimeout(() => { delete route._speed; }, 60000); // no signal: try again in a minute
    return S;
  }
  function limitAt(route, along, vehicle) {
    const S = route._speed; if (!S) return null;
    const i = Math.max(0, Math.min(S.P.length - 1, Math.round(along / STEP)));
    // the 50 m samples aren't exactly even, so settle on the nearest by distance
    let k = i; while (k > 0 && S.cum[k] > along) k--; while (k < S.P.length - 1 && S.cum[k + 1] <= along) k++;
    const posted = S.posted[k] || 0, net = S.net[k] || 0;
    const m = vehicle ? RR.vehicles.dims(vehicle).mass : 0, heavy = !m || m > 12;
    let limit = posted, why = '';
    if (heavy && (!limit || limit > HV_CAP) && posted) { limit = Math.min(posted, HV_CAP); if (posted > HV_CAP) why = 'Heavy vehicle limit'; }
    if (net && (!limit || net < limit)) { limit = net; why = 'Network condition'; }
    return { posted, limit, why };
  }
  return { load, limitAt, HV_CAP };
})();
