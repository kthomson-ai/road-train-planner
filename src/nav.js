// ===== Driving mode: GPS follow, spoken turns, reroute, voice input =====
// Expects globals from the UI script: map, RAV, G (via getG), P, curNet, render helpers passed in init.
const NAV = (() => {
  const D2R = Math.PI / 180;
  const hav = (a, b) => RAV.hav(a, b);
  const kx = lat => 111320 * Math.cos(lat * D2R), KY = 110574;
  function proj(p, a, b) { const cx = kx(p[1]); const ax = (a[0] - p[0]) * cx, ay = (a[1] - p[1]) * KY, bx = (b[0] - p[0]) * cx, by = (b[1] - p[1]) * KY; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return { d: Math.hypot(ax + t * dx, ay + t * dy), t }; }

  // ---- speech ----
  let muted = false, voice = null;
  function pickVoice() { try { const vs = speechSynthesis.getVoices(); voice = vs.find(v => /en-AU/i.test(v.lang)) || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null; } catch { } }
  try { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } catch { }
  function say(text, urgent) {
    if (muted || !('speechSynthesis' in window)) return;
    try { if (urgent) speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); if (voice) u.voice = voice; u.lang = voice ? voice.lang : 'en-AU'; u.rate = 1; speechSynthesis.speak(u); } catch { }
  }
  const ABBR = [[/\bHwy\b/g, 'Highway'], [/\bGNH\b/g, 'Great Northern Highway'], [/\bRd\b/g, 'Road'], [/\bSt\b/g, 'Street'], [/\bDr\b/g, 'Drive'], [/\bAve?\b/g, 'Avenue'], [/\bPde\b/g, 'Parade'], [/\bTce\b/g, 'Terrace'], [/\bCres\b/g, 'Crescent'], [/\bPl\b/g, 'Place'], [/\bCt\b/g, 'Court'], [/\bBvd\b/g, 'Boulevard'], [/\bWy\b/g, 'Way'], [/\bRty\b/g, 'roundabout'], [/\bNth\b/g, 'North'], [/\bSth\b/g, 'South'], [/\bMt\b/g, 'Mount'], [/\s*\((North|South|East|West)bound\)/gi, ''], [/ - /g, ' ']];
  const speakName = n => { let s = n || 'the road'; for (const [re, r] of ABBR) s = s.replace(re, r); s = s.replace(/\boff to\b/i, 'exit to').replace(/\bon to\b/i, 'ramp to'); return s; };
  const speakInstr = st => { const verb = st.instr.replace(/ onto$/, '').replace(/^Continue$/, 'Continue'); return `${verb} onto ${speakName(st.name)}`; };
  const speakDist = m => m >= 950 ? `In ${m >= 9500 ? Math.round(m / 1000) : (Math.round(m / 500) / 2).toString()} kilometres` : `In ${m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50)} metres`;

  // ---- state ----
  let arrived = false, map = null, R = null, cum = null, man = null, warn = null, ui = null, watchId = null, lock = null, lastIdx = 0, offCount = 0, sim = null, active = false, lastFix = null, rerouting = false, opts = null, posMarker = null, endInfo = null;

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
    lastIdx = 0; offCount = 0; arrived = false;
  }
  function alongOf(pt) { const L = R.line; let best = 1e18, bi = 0, bt = 0; for (let i = 1; i < L.length; i++) { const p = proj(pt, L[i - 1], L[i]); if (p.d < best) { best = p.d; bi = i; bt = p.t; } } return cum[bi - 1] + bt * (cum[bi] - cum[bi - 1]); }
  function locate(pt) { // search near last index first
    const L = R.line; let best = 1e18, bi = lastIdx || 1, bt = 0;
    const lo = Math.max(1, lastIdx - 30), hi = Math.min(L.length - 1, lastIdx + 400);
    for (let i = lo; i <= hi; i++) { const p = proj(pt, L[i - 1], L[i]); if (p.d < best) { best = p.d; bi = i; bt = p.t; } }
    if (best > 150) for (let i = 1; i < L.length; i++) { const p = proj(pt, L[i - 1], L[i]); if (p.d < best) { best = p.d; bi = i; bt = p.t; } }
    lastIdx = bi; return { off: best, along: cum[bi - 1] + bt * (cum[bi] - cum[bi - 1]) };
  }

  const fmtKm = m => m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 20000 ? 1 : 0) + ' km';
  const fmtT = s => { const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); };

  function onFix(lon, lat, acc, speed) {
    if (!active || !R) return;
    const pt = [lon, lat]; lastFix = { pt, acc, speed, t: Date.now() };
    posMarker.setLatLng([lat, lon]);
    if (opts.follow()) map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });
    const { off, along } = locate(pt);
    const total = cum[cum.length - 1], remain = Math.max(0, total - along);
    // off route?
    if (off > Math.max(80, (acc || 0) * 1.5)) { if (++offCount >= 3 && !rerouting) return reroute(pt); } else offCount = 0;
    // next maneuver
    const next = man.find(m => m.d > along - 5);
    const v = speed && speed > 2 ? speed : 22; // m/s, ~80 km/h default
    if (next) {
      const dist = next.d - along;
      const far = Math.max(1500, v * 75), mid = Math.max(400, v * 22), now = Math.max(80, v * 6);
      if (dist <= far && dist > mid * 1.3 && !next.said.far && dist > 1200) { next.said.far = 1; say(`${speakDist(dist)}, ${speakInstr(next.step).toLowerCase()}`); }
      else if (dist <= mid && dist > now * 1.5 && !next.said.mid) { next.said.mid = 1; next.said.far = 1; say(`${speakDist(dist)}, ${speakInstr(next.step).toLowerCase()}`); }
      else if (dist <= now && !next.said.now) { next.said.now = next.said.mid = next.said.far = 1; say(speakInstr(next.step), true); }
      showBanner(next.step, dist, remain);
    } else showBanner(null, remain, remain);
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
    const r = opts.reroute(pt);
    rerouting = false; offCount = 0;
    if (r && !r.error) { prepare(r); opts.drawRoute(r); say(`New route. ${fmtKm(r.total).replace('km', 'kilometres')} to go.`); }
    else { say('Could not find a legal route from here. Head back to the approved route.'); flash('No legal route from here. Return to the approved route (blue line).'); }
  }

  async function keepAwake() { try { if ('wakeLock' in navigator) { lock = await navigator.wakeLock.request('screen'); } } catch { } }
  document.addEventListener('visibilitychange', () => { if (active && document.visibilityState === 'visible' && !lock) keepAwake(); });
  function stopTracking() { if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch { } watchId = null; } if (sim) { clearInterval(sim.t); sim = null; } }

  function start(route, o, demo) {
    opts = o; ui = o.ui; map = o.map; endInfo = o.endInfo || null;
    prepare(route); active = true; document.body.classList.add('driving');
    if (!posMarker) posMarker = L.circleMarker([route.line[0][1], route.line[0][0]], { radius: 9, color: '#fff', weight: 3, fillColor: '#0b62d6', fillOpacity: 1 }).addTo(map); else posMarker.addTo(map);
    keepAwake();
    const first = route.steps[0];
    say(`Starting route on Network ${o.net}. ${fmtKm(route.total).replace('km', 'kilometres')}. Head off on ${speakName(first.name)}.`, true);
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
  return { start, stop, setMuted, isActive: () => active, _fix: onFix, _speakName: speakName, _say: say };
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
