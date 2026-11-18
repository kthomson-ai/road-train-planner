// Trip checks: fuel range, departure-time rules, permits, fatigue reminders, weather along the route.
RR.trip = (() => {
  const MIN = 60e3, H = 3600e3;
  const hhmm = d => d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  const dayName = d => d.toLocaleDateString('en-AU', { weekday: 'short' });

  // ---------- ETA along a route ----------
  function etaAt(route, leave, alongM) { const secs = route.trueSecs || route.secs; return new Date(leave.getTime() + secs * 1000 * Math.min(1, Math.max(0, alongM / (route.total || 1)))); }

  // ---------- fuel range ----------
  // stops: [{name, along (m), source}] diesel points on/near the route
  function fuelPlan(route, v, fuelPct, stops) {
    const tank = +v.tankL || 0, use = +v.useL || 0, reserve = +v.reserveL || 0;
    if (!tank || !use) return null;
    const perKm = use / 100, total = route.total / 1000;
    const full = Math.max(0, (tank - reserve) / perKm), now = Math.max(0, (tank * fuelPct / 100 - reserve) / perKm);
    const list = stops.map(s => ({ ...s, km: s.along / 1000 })).filter(s => s.km > 0.5 && s.km < total - 0.5).sort((a, b) => a.km - b.km);
    const out = { rangeNow: now, rangeFull: full, total, fills: [], gaps: [], arriveL: null };
    let pos = 0, reach = now, guard = 0;
    while (pos + reach < total && guard++ < 30) {
      const cands = list.filter(s => s.km > pos + 0.1 && s.km <= pos + reach);
      if (!cands.length) { const nxt = list.find(s => s.km > pos + reach); out.gaps.push({ fromKm: pos, runsOutKm: pos + reach, nextKm: nxt ? nxt.km : null, next: nxt ? nxt.name : null }); break; }
      const c = cands[cands.length - 1]; out.fills.push(c); pos = c.km; reach = full;
    }
    if (!out.gaps.length) { const startL = out.fills.length ? tank : tank * fuelPct / 100; const fromKm = out.fills.length ? out.fills[out.fills.length - 1].km : 0; out.arriveL = Math.max(0, startL - (total - fromKm) * perKm); }
    // the longest stretch between diesel on this route (useful even when the plan works)
    let prev = 0, longest = { km: 0, from: 'start', to: '' };
    for (const s of list.concat([{ km: total, name: 'destination' }])) { if (s.km - prev > longest.km) longest = { km: s.km - prev, fromKm: prev, toKm: s.km, to: s.name }; prev = s.km; }
    out.longest = longest; out.longestOk = longest.km <= full;
    return out;
  }

  // ---------- departure time: metro curfew and timed conditions ----------
  const toMin = (h, m, ap) => { h = +h; m = +(m || 0); if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; } return h * 60 + m; };
  function timeWindows(text) {
    const t = text.replace(/\s+/g, ' '), out = [];
    // 24 h: "between 0700 and 0900", "0730-0900", "07:30 to 09:00"
    const re24 = /\b([01]?\d|2[0-3])[:.]?([0-5]\d)\s*(?:hrs?|hours)?\s*(?:-|–|to|and|until)\s*([01]?\d|2[0-3])[:.]?([0-5]\d)\b/gi;
    let m; while ((m = re24.exec(t))) out.push([toMin(m[1], m[2]), toMin(m[3], m[4])]);
    // 12 h: "7.30am to 9am", "4:30 pm - 6 pm"
    const re12 = /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(am|pm)\s*(?:-|–|to|and|until)\s*(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(am|pm)\b/gi;
    while ((m = re12.exec(t))) out.push([toMin(m[1], m[2], m[3]), toMin(m[4], m[5], m[6])]);
    const weekdays = /mon(day)?\s*(-|to|–)\s*fri(day)?|weekdays?|school days?/i.test(t);
    return out.filter(w => w[1] > w[0]).map(w => ({ from: w[0], to: w[1], weekdays }));
  }
  const inWin = (d, w) => { const mm = d.getHours() * 60 + d.getMinutes(), wd = d.getDay(); return mm >= w.from && mm < w.to && (!w.weekdays || (wd >= 1 && wd <= 5)); };
  const fmtWin = w => `${String(Math.floor(w.from / 60)).padStart(2, '0')}:${String(w.from % 60).padStart(2, '0')}–${String(Math.floor(w.to / 60)).padStart(2, '0')}:${String(w.to % 60).padStart(2, '0')}${w.weekdays ? ' weekdays' : ''}`;
  function timeChecks(route, leave, v, alongOf) {
    const out = { arrive: etaAt(route, leave, route.total), issues: [], notes: [] };
    // Perth metro peak curfew for long/wide vehicles
    if ((+v.length > 22 || +v.width > 2.7) && route.metro) {
      const peaks = [{ from: 450, to: 540, weekdays: true }, { from: 990, to: 1080, weekdays: true }];
      let along = 0; const L = route.line;
      for (let i = 0; i < L.length; i += Math.max(1, Math.floor(L.length / 400))) {
        if (i) along += RAV.hav(L[Math.max(0, i - Math.max(1, Math.floor(L.length / 400)))], L[i]);
        if (!RR.config.metro(L[i])) continue;
        const d = etaAt(route, leave, along); const w = peaks.find(p => inWin(d, p));
        if (w) { out.issues.push({ kind: 'curfew', title: `Metro peak curfew at about ${hhmm(d)} ${dayName(d)}`, text: `Over 22 m long or 2.7 m wide: you'd be in the Perth metro area during ${fmtWin(w)}. Check your permit; leaving earlier or later avoids it.` }); break; }
      }
    }
    // timed conditions on the route's roads
    for (const c of route.conditions || []) {
      const wins = timeWindows(c.text); if (!wins.length || !c.at) continue;
      const a = alongOf(c.at); if (a == null) continue;
      const d = etaAt(route, leave, a); const w = wins.find(x => inWin(d, x));
      if (w) out.issues.push({ kind: 'timed', title: `${c.road}: time limit at about ${hhmm(d)}`, text: `Condition: "${c.text.slice(0, 160)}${c.text.length > 160 ? '…' : ''}" You'd reach it around ${hhmm(d)} ${dayName(d)}.` });
      else out.notes.push(`${c.road}: limited ${wins.map(fmtWin).join(', ')}. You'd pass about ${hhmm(d)}, outside it.`);
    }
    return out;
  }

  // ---------- permits ----------
  const normRoad = s => String(s || '').toLowerCase().replace(/\b(road|rd|highway|hwy|street|st|avenue|ave|drive|dr|freeway|fwy|terrace|tce|parade|pde|crescent|cres|way|place|pl|lane|ln)\b/g, '').replace(/[^a-z0-9]/g, '');
  function permitCheck(route, permit, leave, arrive) {
    const out = { ok: true, items: [] };
    const from = permit.from ? new Date(permit.from + 'T00:00') : null, to = permit.to ? new Date(permit.to + 'T23:59') : null;
    if (to && to < leave) { out.ok = false; out.items.push({ bad: true, text: `Expired on ${to.toLocaleDateString('en-AU')}.` }); }
    else if (to && to < arrive) { out.ok = false; out.items.push({ bad: true, text: `Expires ${to.toLocaleDateString('en-AU')}, before you arrive.` }); }
    else if (from && from > leave) { out.ok = false; out.items.push({ bad: true, text: `Not valid until ${from.toLocaleDateString('en-AU')}.` }); }
    else if (to) out.items.push({ text: `Valid until ${to.toLocaleDateString('en-AU')}.` });
    const allowed = String(permit.roads || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    if (allowed.length) {
      const A = allowed.map(normRoad);
      const used = [...new Set((route.steps || []).filter(s => s.len > 300 && s.name && !/unnamed/i.test(s.name)).map(s => s.name))];
      const missing = used.filter(n => { const k = normRoad(n); return k && !A.some(x => x && (k.includes(x) || x.includes(k))); });
      if (missing.length) { out.ok = false; out.items.push({ bad: true, text: `Roads on this route that aren't in the permit's road list: ${missing.join(', ')}.` }); }
      else out.items.push({ text: `Every road on this route is in the permit's road list.` });
    }
    if (permit.notes) out.items.push({ text: `Conditions noted: ${permit.notes.slice(0, 200)}` });
    return out;
  }

  // ---------- fatigue reminders (WA standard solo operating standard; driving time only) ----------
  // 20 min break from driving per 5 h of work, including at least 10 consecutive minutes; max 17 h between 7 h breaks.
  const FKEY = 'fatigue1';
  const blankF = () => ({ shiftStart: null, work: 0, brk: 0, maxStop: 0, stop: 0, lastTs: null, lastPos: null, warned: {} });
  let F = Object.assign(blankF(), RR.store.get(FKEY, {}));
  const saveF = () => RR.store.set(FKEY, F);
  function fatigueTick(pos, ts, onPrompt) {
    if (F.lastTs == null) { F.lastTs = ts; F.lastPos = pos; if (!F.shiftStart) F.shiftStart = ts; saveF(); return; }
    const dt = ts - F.lastTs; if (dt <= 0) return;
    const dist = F.lastPos ? RAV.hav(F.lastPos, pos) : 0, kmh = dist / (dt / 1000) * 3.6;
    F.lastTs = ts; F.lastPos = pos;
    if (dt > 6 * H) { // phone was off a long time: treat as rest
      if (dt >= 7 * H) Object.assign(F, blankF(), { shiftStart: ts, lastTs: ts, lastPos: pos }); else { F.brk += 20 * MIN; F.maxStop = Math.max(F.maxStop, 10 * MIN); }
    } else if (kmh > 8) { // moving
      if (F.stop >= 5 * MIN) { F.brk += F.stop; F.maxStop = Math.max(F.maxStop, F.stop); }
      F.stop = 0; F.work += dt;
    } else F.stop += dt;
    if (F.stop >= 7 * H) Object.assign(F, blankF(), { lastTs: ts, lastPos: pos });
    // a qualifying break resets the 5-hour clock
    const curBrk = F.brk + (F.stop >= 5 * MIN ? F.stop : 0), curMax = Math.max(F.maxStop, F.stop);
    if (curBrk >= 20 * MIN && curMax >= 10 * MIN) { F.work = 0; F.brk = 0; F.maxStop = 0; F.warned.b45 = F.warned.b5 = false; }
    const elapsed = F.shiftStart ? ts - F.shiftStart : 0;
    if (F.work >= 4.5 * H && !F.warned.b45) { F.warned.b45 = true; onPrompt && onPrompt('soon'); }
    if (F.work >= 5 * H && !F.warned.b5) { F.warned.b5 = true; onPrompt && onPrompt('due'); }
    if (elapsed >= 16 * H && !F.warned.s16) { F.warned.s16 = true; onPrompt && onPrompt('shift16'); }
    if (elapsed >= 17 * H && !F.warned.s17) { F.warned.s17 = true; onPrompt && onPrompt('shift17'); }
    saveF();
  }
  function fatigueStatus(now = Date.now()) {
    const left = Math.max(0, 5 * H - F.work), elapsed = F.shiftStart ? now - F.shiftStart : 0;
    return { breakIn: left, workSinceBreak: F.work, onBreak: F.stop >= 5 * MIN, stoppedFor: F.stop, shiftElapsed: elapsed, shiftLeft: Math.max(0, 17 * H - elapsed), started: F.shiftStart };
  }
  function fatigueReset() { F = blankF(); saveF(); }

  // ---------- weather along the route (Open-Meteo forecast; not official warnings) ----------
  async function weather(route, leave) {
    const L = route.line, n = Math.min(10, Math.max(2, Math.round(route.total / 100000) + 1)), pts = [];
    let cum = [0]; for (let i = 1; i < L.length; i++) cum.push(cum[i - 1] + RAV.hav(L[i - 1], L[i]));
    for (let k = 0; k < n; k++) { const target = route.total * (k / (n - 1)); let i = cum.findIndex(c => c >= target); if (i < 0) i = L.length - 1; pts.push({ at: L[i], along: cum[i] }); }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${pts.map(p => p.at[1].toFixed(3)).join(',')}&longitude=${pts.map(p => p.at[0].toFixed(3)).join(',')}&hourly=wind_gusts_10m,temperature_2m,precipitation&forecast_days=3&timezone=Australia%2FPerth`;
    const r = await fetch(url); if (!r.ok) throw new Error('weather ' + r.status);
    let j = await r.json(); if (!Array.isArray(j)) j = [j];
    const issues = [];
    pts.forEach((p, k) => {
      const h = j[k] && j[k].hourly; if (!h) return;
      const when = etaAt(route, leave, p.along); const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}T${String(when.getHours()).padStart(2, '0')}:00`;
      const i = h.time.indexOf(key); if (i < 0) return;
      const g = h.wind_gusts_10m[i], t = h.temperature_2m[i], pr = h.precipitation[i];
      if (g >= 70) issues.push({ kind: 'wind', along: p.along, at: p.at, title: `Wind gusts about ${Math.round(g)} km/h`, text: `Forecast around ${hhmm(when)} where you'd be. Strong crosswinds affect high-sided and empty trailers.` });
      if (t >= 42) issues.push({ kind: 'heat', along: p.along, at: p.at, title: `Extreme heat: about ${Math.round(t)}°C`, text: `Forecast around ${hhmm(when)}. Watch tyres and brakes, carry water, plan rest in shade.` });
      if (pr >= 8) issues.push({ kind: 'rain', along: p.along, at: p.at, title: `Heavy rain: about ${Math.round(pr)} mm/h`, text: `Forecast around ${hhmm(when)}. Floodways and unsealed roads may close.` });
    });
    // one line per kind of weather, covering the stretch where it applies
    const merged = [];
    for (const kind of ['wind', 'heat', 'rain']) {
      const xs = issues.filter(i => i.kind === kind); if (!xs.length) continue;
      const first = xs[0], last = xs[xs.length - 1], peak = xs.reduce((m, i) => (parseFloat(i.title.replace(/[^0-9.]/g, ' ').trim().split(' ').pop()) > parseFloat(m.title.replace(/[^0-9.]/g, ' ').trim().split(' ').pop()) ? i : m), first);
      merged.push({ ...peak, along: first.along, text: xs.length > 1 ? `${peak.text} Affects about ${Math.round((last.along - first.along) / 1000)} km of the route from ${Math.round(first.along / 1000)} km.` : peak.text });
    }
    return { issues: merged, checked: pts.length };
  }

  return { etaAt, fuelPlan, timeWindows, timeChecks, permitCheck, fatigueTick, fatigueStatus, fatigueReset, weather, hhmm };
})();

// Permits stored on this phone (details in local storage, the file itself in IndexedDB)
RR.permits = (() => {
  const all = () => RR.store.get('permits', []);
  const save = l => RR.store.set('permits', l);
  return {
    all, forVehicle: id => all().filter(p => !p.vehicleId || p.vehicleId === id),
    upsert(p) { const l = all(); const i = l.findIndex(x => x.id === p.id); if (i >= 0) l[i] = p; else l.push(p); save(l); RR.emit('permits'); },
    remove(id) { save(all().filter(p => p.id !== id)); RR.store.cachePut('permitfile-' + id, null); RR.emit('permits'); },
    async putFile(id, file) { await RR.store.cachePut('permitfile-' + id, { t: Date.now(), v: file }); },
    async getFile(id) { const c = await RR.store.cacheGet('permitfile-' + id); return c && c.v; }
  };
})();
