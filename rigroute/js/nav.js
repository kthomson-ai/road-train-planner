// ===== Driving mode: GPS follow, spoken turns, reroute, voice input =====
// Expects globals from the UI script: map, RAV, G (via getG), P, curNet, render helpers passed in init.
const NAV = (() => {
  const D2R = Math.PI / 180;
  const hav = (a, b) => RAV.hav(a, b);
  const kx = lat => 111320 * Math.cos(lat * D2R), KY = 110574;
  function proj(p, a, b) { const cx = kx(p[1]); const ax = (a[0] - p[0]) * cx, ay = (a[1] - p[1]) * KY, bx = (b[0] - p[0]) * cx, by = (b[1] - p[1]) * KY; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return { d: Math.hypot(ax + t * dx, ay + t * dy), t }; }

  // ---- speech ----
  let muted = false, voice = null;
  let prefURI = null, rate = 1;
  try { const v = JSON.parse(localStorage.getItem('rr.voicePref') || 'null'); if (v) { prefURI = v.uri || null; rate = +v.rate || 1; } } catch { }
  function pickVoice() { try { const all = speechSynthesis.getVoices(); const off = !navigator.onLine; const vs = off && all.some(v => v.localService && /^en/i.test(v.lang)) ? all.filter(v => v.localService) : all; voice = (prefURI && vs.find(v => v.voiceURI === prefURI)) || vs.find(v => /en-AU/i.test(v.lang)) || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null; } catch { } }
  function setVoice(uri, r) { prefURI = uri || null; if (r) rate = +r; try { localStorage.setItem('rr.voicePref', JSON.stringify({ uri: prefURI, rate })); } catch { } pickVoice(); }
  try { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; addEventListener('online', pickVoice); addEventListener('offline', pickVoice); } catch { }
  const lc1 = t => t.charAt(0).toLowerCase() + t.slice(1);
  function say(text, urgent) {
    if (muted || !('speechSynthesis' in window)) return;
    try { if (urgent) speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); if (voice) u.voice = voice; u.lang = voice ? voice.lang : 'en-AU'; u.rate = rate; speechSynthesis.speak(u); } catch { }
  }
  const ABBR = [[/\bHwy\b/g, 'Highway'], [/\bGNH\b/g, 'Great Northern Highway'], [/\bRd\b/g, 'Road'], [/\bSt\b/g, 'Street'], [/\bDr\b/g, 'Drive'], [/\bAve?\b/g, 'Avenue'], [/\bPde\b/g, 'Parade'], [/\bTce\b/g, 'Terrace'], [/\bCres\b/g, 'Crescent'], [/\bPl\b/g, 'Place'], [/\bCt\b/g, 'Court'], [/\bBvd\b/g, 'Boulevard'], [/\bWy\b/g, 'Way'], [/\bRty\b/g, 'roundabout'], [/\bNth\b/g, 'North'], [/\bSth\b/g, 'South'], [/\bMt\b/g, 'Mount'], [/\s*\((North|South|East|West)bound\)/gi, ''], [/ - /g, ' ']];
  const speakName = n => { let s = n || 'the road'; for (const [re, r] of ABBR) s = s.replace(re, r); s = s.replace(/\boff to\b/i, 'exit to').replace(/\bon to\b/i, 'ramp to'); return s; };
  const speakInstr = st => { if (st.stop) return `arrive at stop ${st.stop}, ${speakName(st.name)}`; const verb = st.instr.replace(/ onto$/, '').replace(/^Leave on$/, 'Head off'); return `${verb} onto ${speakName(st.name)}`; };
  const speakDist = m => m >= 950 ? `In ${m >= 9500 ? Math.round(m / 1000) : (Math.round(m / 500) / 2).toString()} kilometres` : `In ${m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50)} metres`;

  // ---- state ----
  let reachedStop = 0, jKey = null, arrived = false, map = null, R = null, cum = null, man = null, warn = null, ui = null, watchId = null, lock = null, lastIdx = 0, offCount = 0, sim = null, active = false, lastFix = null, rerouting = false, opts = null, posMarker = null, endInfo = null;

  function prepare(route) {
    R = route; const L = route.line; cum = new Float64Array(L.length); for (let i = 1; i < L.length; i++) cum[i] = cum[i - 1] + hav(L[i - 1], L[i]);
    // maneuver distances from step lengths
    man = []; let acc = 0; route.steps.forEach((s, i) => { if (i > 0) man.push({ d: acc, step: s, said: {} }); acc += s.len; });
    const scale = acc > 0 ? cum[cum.length - 1] / acc : 1; man.forEach(m => m.d *= scale);
    // condition warnings at their along-route distance
    warn = [];
    const seen = new Set();
    for (const c of route.conditions) { if (!c.at) continue; const a = alongOf(c.at); const key = c.road; if (seen.has(key + '|' + Math.round(a / 2000))) continue; seen.add(key + '|' + Math.round(a / 2000)); warn.push({ d: a, text: c.text, road: c.road, said: false, hard: c.notThrough }); }
    for (const r of route.rulesNear || []) warn.push({ d: alongOf(r.at), text: r.text, road: r.where || 'intersection', said: false, rule: true });
    warn.sort((a, b) => a.d - b.d);
    lastIdx = 0; lastAlong = 0; prevPt = null; travel = null; offCount = 0; arrived = false;
  }
  function alongOf(pt) { const L = R.line; let best = 1e18, bi = 0, bt = 0; for (let i = 1; i < L.length; i++) { const p = proj(pt, L[i - 1], L[i]); if (p.d < best) { best = p.d; bi = i; bt = p.t; } } return cum[bi - 1] + bt * (cum[bi] - cum[bi - 1]); }
  // Match the GPS position to the route. Routes can overlap themselves (out and back along the same road), so
  // prefer the stretch just ahead of where we were, and the pass that runs in our direction of travel.
  let lastAlong = 0, prevPt = null, travel = null;
  function locate(pt) {
    const L = R.line;
    if (prevPt) { const dx = (pt[0] - prevPt[0]) * Math.cos(pt[1] * Math.PI / 180), dy = pt[1] - prevPt[1]; if (Math.hypot(dx, dy) * 111320 > 8) { travel = [dx, dy]; prevPt = pt; } } else prevPt = pt;
    const score = (i, p) => {
      let pen = 0; const a = cum[i - 1];
      if (a < lastAlong - 250 || a > lastAlong + 800) pen += 40;            // not where we expect to be
      if (travel) { const sx = (L[i][0] - L[i - 1][0]) * Math.cos(pt[1] * Math.PI / 180), sy = L[i][1] - L[i - 1][1]; if (sx * travel[0] + sy * travel[1] < 0) pen += 80; } // runs against our travel
      return p.d + pen;
    };
    let best = 1e18, bd = 1e18, bi = lastIdx || 1, bt = 0;
    const scan = (lo, hi) => { for (let i = lo; i <= hi; i++) { const p = proj(pt, L[i - 1], L[i]); const sc = score(i, p); if (sc < best) { best = sc; bd = p.d; bi = i; bt = p.t; } } };
    scan(Math.max(1, lastIdx - 30), Math.min(L.length - 1, lastIdx + 400));
    if (bd > 150) scan(1, L.length - 1);
    lastIdx = bi; lastAlong = cum[bi - 1] + bt * (cum[bi] - cum[bi - 1]);
    return { off: bd, along: lastAlong };
  }

  // ---- camera: close-in, speed-based zoom with the road ahead in view ----
  // Zoom 17 is about 450 m across a phone screen, 15.5 about 1.3 km. Closer for turns; a pinch-zoom by the
  // driver is kept as an offset for the rest of the session (it survives reroutes and added stops).
  let vEma = null, zoomBias = 0, autoZ = null, camMoving = false, camHooked = false;
  function targetZoom(distToTurn) {
    const kmh = (vEma || 0) * 3.6;
    let z = kmh < 25 ? 17.5 : kmh < 50 ? 17 : kmh < 75 ? 16.5 : kmh < 95 ? 16 : 15.5;
    if (distToTurn != null && distToTurn < 700) z = Math.max(z, 17);
    return Math.round(Math.max(13, Math.min(18.5, z + zoomBias)) * 2) / 2;
  }
  function camera(pt, along, off, distToTurn) {
    let z = targetZoom(distToTurn);
    if (autoZ != null && Math.abs(z - autoZ) < 0.5) z = autoZ; // no flicker on small speed changes
    autoZ = z;
    let c = [pt[1], pt[0]];
    if (off < 60) { // look ahead along the route so the truck sits below the middle of the screen
      const sz = map.getSize(), mpp = 156543.03 * Math.cos(pt[1] * D2R) / Math.pow(2, z);
      const a = pointAt(along + 0.22 * Math.min(sz.x, sz.y) * mpp);
      c = [a[1], a[0]];
    }
    camMoving = true; try { map.setView(c, z, { animate: false }); } finally { camMoving = false; }
  }

  const fmtKm = m => m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 20000 ? 1 : 0) + ' km';
  const fmtT = s => { const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); };

  function onFix(lon, lat, acc, speed) {
    try { RR.emit('navpos', [lon, lat]); } catch { }
    if (!active || !R) return;
    const pt = [lon, lat], now = Date.now();
    // some phones report no speed: work it out from the last fix
    let v0 = speed; if ((v0 == null || isNaN(v0)) && lastFix) { const dt = (now - lastFix.t) / 1000; if (dt > 0.5 && dt < 30) v0 = hav(lastFix.pt, pt) / dt; }
    if (v0 != null && !isNaN(v0)) vEma = vEma == null ? v0 : vEma * 0.7 + v0 * 0.3;
    lastFix = { pt, acc, speed, t: now };
    posMarker.setLatLng([lat, lon]);
    const { off, along } = locate(pt);
    try { RR.emit('navfix', { pt, speed, acc, along, off, t: Date.now() }); } catch { }
    const total = cum[cum.length - 1], remain = Math.max(0, total - along);
    // off route?
    if (off > Math.max(80, (acc || 0) * 1.5)) { if (++offCount >= 3 && !rerouting) return reroute(pt); } else offCount = 0;
    // next maneuver
    const next = man.find(m => m.d > along - 5);
    if (opts.follow()) camera(pt, along, off, next ? next.d - along : null);
    const v = speed && speed > 2 ? speed : 22; // m/s, ~80 km/h default
    if (next) {
      const dist = next.d - along;
      const far = Math.max(1500, v * 75), mid = Math.max(400, v * 22), now = Math.max(80, v * 6);
      if (dist <= far && dist > mid * 1.3 && !next.said.far && dist > 1200) { next.said.far = 1; say(`${speakDist(dist)}, ${lc1(speakInstr(next.step))}`); }
      else if (dist <= mid && dist > now * 1.5 && !next.said.mid) { next.said.mid = 1; next.said.far = 1; say(`${speakDist(dist)}, ${lc1(speakInstr(next.step))}`); }
      else if (dist <= now && !next.said.now) {
        next.said.now = next.said.mid = next.said.far = 1;
        if (next.step.stop) { reachedStop = Math.max(reachedStop, next.step.stop); try { RR.emit('stopreached', reachedStop); } catch { } say(`You've reached stop ${next.step.stop}, ${speakName(next.step.name)}.`, true); flash(`Stop ${next.step.stop} reached: ${next.step.name}`); }
        else say(speakInstr(next.step), true);
      }
      // stops passed without the 'now' call (e.g. GPS gap) still count as reached
      for (const m of man) if (m.step.stop && m.d < along - 30) reachedStop = Math.max(reachedStop, m.step.stop); try { RR.emit('stopreached', reachedStop); } catch { }
      showBanner(next.step, dist, remain);
      junction(next, dist);
    } else { showBanner(null, remain, remain); junction(null, remain); }
    // condition warnings ~1.5 km ahead
    for (const w of warn) { if (w.said) continue; const ahead = w.d - along; if (ahead < -50) { w.said = true; continue; } if (ahead <= 1500) { w.said = true; const txt = w.text.length > 160 ? w.text.slice(0, 157).replace(/\s\S*$/, '') + '…' : w.text; say(w.rule ? `Turn restriction ahead at ${speakName(w.road)}. ${txt}` : `Heads up. ${speakName(w.road)} has a condition. ${txt}`); flash(`${w.road}: ${w.text}`); } }
    // arrival
    if (remain < 40) arrive();
    ui.eta.textContent = `${fmtKm(remain)} · ${fmtT(remain / Math.max(v, 15))}`;
  }
  function showBanner(step, dist, remain) {
    if (!step) { ui.arrow.textContent = '⚑'; ui.dist.textContent = fmtKm(dist); ui.instr.textContent = endInfo || 'Destination ahead'; return; }
    ui.arrow.textContent = opts.arrow(step.instr); ui.dist.textContent = fmtKm(dist); ui.instr.textContent = `${step.instr} ${step.name}`;
  }
  let flashT = null;
  function flash(t) { ui.flash.textContent = t; ui.flash.style.display = 'block'; clearTimeout(flashT); flashT = setTimeout(() => ui.flash.style.display = 'none', 12000); }
  function arrive() {
    if (!active || arrived) return; arrived = true;
    say(endInfo ? `You've reached the end of the approved route. ${endInfo}` : 'You have arrived.', true);
    ui.instr.textContent = endInfo ? 'End of approved route. ' + endInfo : 'Arrived'; ui.arrow.textContent = '⚑'; ui.dist.textContent = '';
    stopTracking();
  }
  async function reroute(pt) {
    rerouting = true; say('Off route. Finding a new legal route.', true); flash('Off route, rerouting on approved roads…');
    await new Promise(r => setTimeout(r, 30));
    const r = opts.reroute(pt, reachedStop);
    rerouting = false; offCount = 0;
    if (r && !r.error) { prepare(r); opts.drawRoute(r); say(`New route. ${fmtKm(r.total).replace('km', 'kilometres')} to go.`); }
    else { say('Could not find a legal route from here. Head back to the approved route.'); flash('No legal route from here. Return to the approved route (lime line).'); }
  }

  // ---- next-turn junction diagram ----
  function pointAt(d) { const L = R.line; d = Math.max(0, Math.min(cum[cum.length - 1], d)); let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]); return [L[i - 1][0] + (L[i][0] - L[i - 1][0]) * t, L[i - 1][1] + (L[i][1] - L[i - 1][1]) * t]; }
  function slice(d0, d1) { const L = R.line, out = [pointAt(d0)]; for (let i = 0; i < L.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(L[i]); out.push(pointAt(d1)); return out; }
  function junction(m, dist) {
    const box = ui.junc; if (!box) return;
    const key = m ? m.d.toFixed(0) : 'end';
    if (key !== jKey) { jKey = key; box.svg.innerHTML = m ? (m.step.stop ? stopSvg(m.step.stop) : junctionSvg(m)) : flagSvg(); }
    box.dist.textContent = fmtKm(Math.max(0, dist));
    box.bar.style.width = (100 * (1 - Math.min(dist, 1000) / 1000)).toFixed(0) + '%';
    if (box.name) box.name.textContent = m ? String(m.step.name || '').split(':')[0] : (opts.destName || '');
    box.label.textContent = m ? (m.step.stop ? 'Stop ' + m.step.stop : m.step.instr.replace(/ onto$/, '').replace(/^At the roundabout, /, 'Roundabout: ')) : 'Destination';
  }
  const flagSvg = () => '<circle cx="0" cy="0" r="48" style="fill:var(--surface2)"/><path d="M-10 30 V-30 M-10 -30 L22 -18 L-10 -6" stroke="#B7F23D" stroke-width="7" fill="none" stroke-linejoin="round" stroke-linecap="round"/>';
  const stopSvg = n => `<circle cx="0" cy="0" r="48" style="fill:var(--surface2)"/><path d="M0 34 C-4 18 -22 6 -22 -10 A22 22 0 0 1 22 -10 C22 6 4 18 0 34Z" fill="#FFB020"/><text x="0" y="-4" text-anchor="middle" font-size="22" font-weight="700" fill="#101418" font-family="system-ui">${n}</text>`;
  function junctionSvg(m) {
    const c = m.step.at || pointAt(m.d), cx = kx(c[1]);
    const back = pointAt(m.d - 40);
    const bIn = Math.atan2((c[0] - back[0]) * cx, (c[1] - back[1]) * KY); // radians from north
    const S = 0.42; // px per metre
    const toXY = p => { const x = (p[0] - c[0]) * cx, y = (p[1] - c[1]) * KY; const r = bIn; const xr = x * Math.cos(r) - y * Math.sin(r), yr = x * Math.sin(r) + y * Math.cos(r); return [xr * S, -yr * S]; };
    const path = pts => pts.map((p, i) => (i ? 'L' : 'M') + toXY(p).map(v => v.toFixed(1)).join(' ')).join(' ');
    let side = '';
    const G = opts.graph && opts.graph();
    if (G) { // side roads at this junction
      let bj = -1, bd = 35; for (let j = 0; j < G.J.length; j++) { const v = G.coords[G.J[j]]; if (Math.abs(v[1] - c[1]) > 0.0005 || Math.abs(v[0] - c[0]) > 0.0006) continue; const d = hav(v, c); if (d < bd) { bd = d; bj = j; } }
      if (bj >= 0) for (const dd of G.out[bj]) { const e = G.E[dd >> 1]; const p = (dd & 1) ? e.path.slice().reverse() : e.path; const pts = [G.coords[p[0]]]; let acc = 0; for (let k = 1; k < p.length && acc < 170; k++) { acc += hav(G.coords[p[k - 1]], G.coords[p[k]]); pts.push(G.coords[p[k]]); } side += `<path d="${path(pts)}" style="stroke:var(--line2)" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`; }
    }
    const inPts = slice(m.d - 170, m.d), outPts = slice(m.d, m.d + 120);
    const o = outPts.map(toXY); const a = o[o.length - 1], b = o[Math.max(0, o.length - 2)];
    const ang = Math.atan2(a[1] - b[1], a[0] - b[0]); const tip = [a[0] + 9 * Math.cos(ang), a[1] + 9 * Math.sin(ang)];
    const w1 = [a[0] + 11 * Math.cos(ang + 2.2), a[1] + 11 * Math.sin(ang + 2.2)], w2 = [a[0] + 11 * Math.cos(ang - 2.2), a[1] + 11 * Math.sin(ang - 2.2)];
    const full = path(inPts.concat(outPts.slice(1)));
    return `<rect x="-70" y="-70" width="140" height="140" style="fill:var(--surface)"/>${side}<path d="${full}" stroke="#101418" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="${full}" stroke="#B7F23D" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${[tip, w1, w2].map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="#B7F23D" stroke="#101418" stroke-width="2"/><circle cx="0" cy="${(170 * S * 0.9).toFixed(0)}" r="0"/>`;
  }

  async function keepAwake() { try { if ('wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); } } catch { } }
  document.addEventListener('visibilitychange', () => { if (active && document.visibilityState === 'visible' && !lock) keepAwake(); });
  function stopTracking() { if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch { } watchId = null; } if (sim) { clearInterval(sim.t); sim = null; } }

  function start(route, o, demo) {
    opts = o; ui = o.ui; map = o.map; endInfo = o.endInfo || null; reachedStop = 0; jKey = null;
    vEma = null; autoZ = null; lastFix = null;
    if (!camHooked) { camHooked = true; map.on('zoomend', () => { if (!camMoving && active && autoZ != null && opts.follow()) zoomBias = Math.max(-3, Math.min(2, zoomBias + map.getZoom() - autoZ)); }); }
    prepare(route); active = true; document.body.classList.add('driving');
    if (!posMarker) posMarker = L.circleMarker([route.line[0][1], route.line[0][0]], { radius: 9, color: '#fff', weight: 3, fillColor: '#36A5F5', fillOpacity: 1 }).addTo(map); else posMarker.addTo(map);
    keepAwake();
    const first = route.steps[0];
    say(`Starting route on ${o.net}. ${fmtKm(route.total).replace('km', 'kilometres')}. Head off on ${speakName(first.name)}.`, true);
    showBanner(man[0] ? man[0].step : null, man[0] ? man[0].d : route.total, route.total);
    if (demo) { // simulate driving along the route
      let along = 0; const total = cum[cum.length - 1]; const stepM = Math.max(25, total / 600);
      sim = { t: setInterval(() => { along += stepM * o.simSpeed(); if (along >= total) along = total; const L = R.line; let i = 1; while (i < cum.length - 1 && cum[i] < along) i++; const t = (along - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]); const a = L[i - 1], b = L[i]; onFix(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 5, 25); if (along >= total) clearInterval(sim && sim.t); }, 500) };
      return true;
    }
    if (!navigator.geolocation) { flash('GPS not available in this browser.'); return false; }
    watchId = navigator.geolocation.watchPosition(p => onFix(p.coords.longitude, p.coords.latitude, p.coords.accuracy, p.coords.speed),
      e => flash('GPS problem: ' + e.message + (location.protocol === 'file:' ? ' (phones usually need the hosted link for GPS)' : '')), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    return true;
  }
  function stop() { active = false; stopTracking(); try { speechSynthesis.cancel(); } catch { } try { lock && lock.release(); } catch { } lock = null; document.body.classList.remove('driving'); if (posMarker) map.removeLayer(posMarker); }
  function setMuted(m) { muted = m; if (m) try { speechSynthesis.cancel(); } catch { } }
  // test hook
  return { start, stop, setMuted, setVoice, along: () => lastAlong, isActive: () => active, _fix: onFix, _speakName: speakName, _say: say };
})();

// ---- voice input for address boxes ----
const VOICE = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen(onText, onState) {
    if (!SR) return false;
    const r = new SR(); r.lang = 'en-AU'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = e => onText(e.results[0][0].transcript);
    r.onerror = e => onState('error', e.error);
    r.onend = () => onState('end');
    try { r.start(); onState('listening'); } catch (e) { onState('error', e.message); }
    return true;
  }
  return { supported: !!SR, listen };
})();
