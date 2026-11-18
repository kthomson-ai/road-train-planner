// RigRoute app controller: screens, search, planning, route details, alerts, truck stops, profiles, driving.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtKm = m => m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 20000 ? 1 : 0) + ' km';
  const fmtT = s => { const m = Math.round(s / 60); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let toastT; const toast = (t, ms = 3200) => { const el = $('toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), ms); };
  const S = RR.routing.state;
  const app = { ME: null, P: { from: null, to: null }, stops: [], RES: null, sel: 0, alerts: [], alertCat: 'all', alertScope: 'route', stopCat: 'diesel', stopScope: 'route' };
  window.RRapp = app; // debugging/tests

  // ---------- facility categories ----------
  const FAC = [
    { key: 'diesel', label: 'Diesel', icon: 'fuel', mr: f => f.tags.includes('diesel'), g: 'diesel fuel truck stop' },
    { key: 'parking', label: 'Truck parking', icon: 'parking', mr: f => f.tags.includes('parking') },
    { key: 'rest', label: 'Rest areas', icon: 'rest', mr: f => f.tags.includes('rest') },
    { key: 'weighbridge', label: 'Weighbridges', icon: 'scale', g: 'weighbridge' },
    { key: 'roadhouse', label: 'Roadhouses', icon: 'food', mr: f => f.kind === 'roadhouse', g: 'roadhouse' },
    { key: 'showers', label: 'Showers', icon: 'shower', g: 'truck stop showers' },
    { key: 'food', label: 'Food', icon: 'food', mr: f => f.tags.includes('food'), g: 'roadhouse cafe' },
    { key: 'mechanical', label: 'Mechanical', icon: 'wrench', g: 'truck repairs mechanic' },
    { key: 'wash', label: 'Truck wash', icon: 'wash', g: 'truck wash' }
  ];
  RR.facIcon = f => f.kind === 'rtaa' ? 'truck' : f.kind === 'hvrest' ? 'parking' : f.kind === 'rest' ? 'rest' : f.kind === 'roadhouse' ? 'food' : (FAC.find(c => c.key === f.cat) || {}).icon || 'pin';

  // ---------- sheets & tabs ----------
  const SHEETS = ['plan', 'route', 'alerts', 'stops', 'profile', 'vedit'];
  function openSheet(name) {
    SHEETS.forEach(n => $('sheet-' + n).classList.toggle('on', n === name));
    document.body.classList.toggle('sheet-open', !!name);
    const tab = { plan: 'plan', route: 'plan', alerts: 'alerts', stops: 'stops', profile: 'profile', vedit: 'profile' }[name] || 'map';
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    const fabs = document.querySelector('.fabs'), pb = $('planBtn');
    const lift = name && window.innerWidth < 900 ? Math.min(window.innerHeight * 0.55, $('sheet-' + name).offsetHeight) : 0;
    fabs.style.bottom = pb.style.bottom = `calc(var(--tab-h) + var(--safe-b) + 16px + ${lift}px)`;
    pb.style.display = name ? 'none' : '';
    if (name === 'alerts') renderAlerts();
    if (name === 'stops') renderStops();
    if (name === 'profile') renderProfiles();
    app.sheet = name;
  }
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => openSheet(null));
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { const k = t.dataset.tab; if (k === 'map') return openSheet(null); if (k === 'plan') return openSheet(app.RES && !app.RES.error && app.sheet !== 'plan' ? 'route' : 'plan'); openSheet(k); });
  $('planBtn').onclick = () => openSheet(app.RES && !app.RES.error ? 'route' : 'plan');
  $('routeBack').onclick = () => openSheet('plan');
  $('fabAlerts').onclick = () => openSheet('alerts');
  $('fabLayers').onclick = () => toast(RR.map.cycleBase());
  $('fabLocate').onclick = () => locate(true);
  $('vchip').onclick = () => openSheet('profile');

  // ---------- location ----------
  function locate(fly) {
    if (!navigator.geolocation) return toast('Location isn\'t available in this browser.');
    navigator.geolocation.getCurrentPosition(p => {
      app.ME = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'My location' };
      RR.map.setMe(app.ME.lat, app.ME.lon); if (fly) RR.map.get().setView([app.ME.lat, app.ME.lon], 13);
    }, e => fly && toast('Couldn\'t get your location: ' + e.message), { enableHighAccuracy: true, timeout: 12000 });
  }

  // ---------- vehicle chip & plan vehicle ----------
  const VT = k => RR.config.vehicleTypes.find(t => t.key === k) || {};
  function vehSummary(v) { const n = RR.net(v.net); return `${n.short} · ${v.height} m H · ${v.width} m W · ${v.length} m L`; }
  function paintVehicle() {
    const v = RR.vehicles.active();
    $('vchipName').textContent = v.name; $('vchipSub').textContent = RR.net(v.net).short;
    $('planVeh').innerHTML = `<span class="vi">${RR.icon('truck')}</span><span class="tx"><b>${esc(v.name)}</b><small>${esc(vehSummary(v))}</small></span>`;
    $('pH').value = v.height; $('pW').value = v.width; $('pL').value = v.length; $('pM').value = v.gcm || v.gvm || ''; $('pDG').checked = !!v.dg;
    paintPlanPermit();
  }
  // trip profile = vehicle + this trip's load dimensions
  const tripProfile = () => ({ ...RR.vehicles.active(), height: +$('pH').value || 0, width: +$('pW').value || 0, length: +$('pL').value || 0, gcm: +$('pM').value || '', dg: $('pDG').checked });
  function permitHtml(v) { const p = RR.vehicles.permit(v); const icon = { none: '✓', order: 'i', permit: '!' }[p.level]; return `<div class="permit ${{ none: 'none', order: 'order', permit: 'req' }[p.level]}"><span class="pi">${icon}</span><div><b>${esc(p.title)}</b><ul>${p.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div></div>`; }
  const paintPlanPermit = () => { $('planPermit').innerHTML = permitHtml(tripProfile()); };
  ['pH', 'pW', 'pL', 'pM'].forEach(id => $(id).addEventListener('input', paintPlanPermit)); $('pDG').onchange = paintPlanPermit;
  $('planEditVeh').onclick = () => openSheet('profile');

  // ---------- network loading ----------
  async function loadNetwork(force) {
    const v = RR.vehicles.active();
    $('go').disabled = true; setPlanStatus('Loading ' + RR.net(v.net).short + '…');
    try {
      if (force) { S.key = null; await RR.store.cachePut('net2-' + v.net, null); }
      await RR.routing.prepare(v.net, setPlanStatus);
      RR.map.drawNetwork(S.data, $('setNet').checked);
      $('dataInfo').textContent = `${RR.net(v.net).short}: ${S.data.lines.length.toLocaleString()} road sections · ${S.structures.length} structures · ${app.alerts.length} live alerts`;
      setPlanStatus('');
    } catch (e) { setPlanStatus('Couldn\'t reach Main Roads WA (' + e.message + '). Check your connection.'); }
    updateGo(); refreshAlertMarkers();
  }
  const setPlanStatus = t => { $('planStatus').textContent = t; };
  RR.on('profiles', () => { const id = RR.vehicles.active().id; if (app.RES && app.vehId && app.vehId !== id) { app.RES = null; RR.map.clearRoutes(); toast('Vehicle changed: plan the route again for this vehicle.'); } app.vehId = id; paintVehicle(); if (S.key !== RR.vehicles.active().net) loadNetwork(); else refreshAlertMarkers(); });

  // ---------- trip inputs ----------
  function setPoint(w, pt) {
    app.P[w] = pt; const el = $(w); if (el) el.value = pt ? pt.label : '';
    paintWaypoints(); updateGo();
  }
  function paintWaypoints() {
    const pts = [];
    if (app.P.from) pts.push({ ...app.P.from, kind: 'start' });
    app.stops.forEach((id, i) => app.P[id] && pts.push({ ...app.P[id], kind: 'stop', n: i + 1 }));
    if (app.P.to) pts.push({ ...app.P.to, kind: 'end' });
    RR.map.setWaypoints(pts);
  }
  const usedStops = () => app.stops.filter(id => $(id) && $(id).value.trim());
  const updateGo = () => { $('go').disabled = !(S.base && ($('from').value.trim() || app.P.from) && ($('to').value.trim() || app.P.to)); };
  const sugT = {};
  function wireInput(w) {
    const el = $(w), box = $(w + 'Choices');
    el.addEventListener('input', () => {
      if (app.P[w] && el.value !== app.P[w].label) app.P[w] = null; updateGo();
      clearTimeout(sugT[w]); const q = el.value.trim(); if (q.length < 3 || !RR.google.ok()) { box.innerHTML = ''; return; }
      sugT[w] = setTimeout(async () => { try { const s = await RR.google.suggest(q); if (el.value.trim() !== q || app.P[w]) return; box.className = s.length ? 'choices' : ''; box.innerHTML = ''; s.forEach(x => { const d = document.createElement('div'); d.textContent = x.label; d.onmousedown = e => e.preventDefault(); d.onclick = async () => { box.innerHTML = ''; box.className = ''; setPoint(w, await x.resolve()); }; box.appendChild(d); }); } catch { } }, 300);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); resolveInput(w); } });
  }
  async function resolveInput(w) {
    const el = $(w), box = $(w + 'Choices'), q = el.value.trim();
    clearTimeout(sugT[w]); if (!q) return false; if (app.P[w] && app.P[w].label === q) return true;
    box.innerHTML = ''; box.className = '';
    try {
      const res = await RR.geocode(q);
      if (!res.length) { setPlanStatus(`No match in WA for "${q}".`); return false; }
      setPoint(w, res[0]);
      if (res.length > 1) { box.className = 'choices'; box.innerHTML = '<div class="h">Not the right place? Tap another:</div>'; res.slice(1).forEach(x => { const d = document.createElement('div'); d.textContent = x.label; d.onclick = () => { setPoint(w, x); box.innerHTML = ''; box.className = ''; }; box.appendChild(d); }); }
      return true;
    } catch (e) { setPlanStatus('Address search failed: ' + e.message); return false; }
  }
  ['from', 'to'].forEach(wireInput);
  $('useLoc').onclick = () => { if (app.ME) return setPoint('from', { ...app.ME }); locate(false); toast('Getting your location…'); setTimeout(() => app.ME && setPoint('from', { ...app.ME }), 2500); };
  let stopSeq = 0;
  function renumberStops() { app.stops.forEach((id, i) => { const r = $('row-' + id); if (r) r.querySelector('input').placeholder = `Stop ${i + 1}`; }); $('optStops').hidden = app.stops.length < 2; $('addStop').disabled = app.stops.length >= 8; paintWaypoints(); }
  $('addStop').onclick = () => {
    const id = 's' + (++stopSeq); app.stops.push(id);
    const row = document.createElement('div'); row.className = 'wp stop'; row.id = 'row-' + id;
    row.innerHTML = `<span class="pin"></span><div class="row"><input class="inp" id="${id}" autocomplete="off"><button class="iconbtn" data-mic="${id}" aria-label="Say this stop">${RR.icon('mic')}</button><button class="iconbtn" data-del aria-label="Remove stop">${RR.icon('x')}</button></div><div id="${id}Choices"></div>`;
    $('stops').appendChild(row); wireInput(id); wireMic(row.querySelector('[data-mic]'));
    row.querySelector('[data-del]').onclick = () => { app.stops = app.stops.filter(x => x !== id); delete app.P[id]; row.remove(); renumberStops(); };
    renumberStops(); $(id).focus();
  };
  $('optStops').onclick = async () => {
    const run = await resolveAll(); if (!run || run.pts.length < 4) return toast('Add at least two stops to optimise.');
    setPlanStatus('Working out the quickest stop order…'); await sleep(20);
    const G = S.data.general ? await RR.routing.state.local.g || S.base : S.base;
    const res = RAV.optimiseOrder(G, run.pts, {});
    const saved = (res.before - res.secs) / 60;
    if (saved > 1) { const used = run.ids.slice(1, -1); const re = res.order.map(k => used[k]); app.stops = re.concat(app.stops.filter(id => !re.includes(id))); app.stops.forEach(id => $('stops').appendChild($('row-' + id))); renumberStops(); toast(`Stops reordered: saves about ${Math.round(saved)} min.`); }
    else toast('Stops are already in the best order.');
    setPlanStatus('');
  };
  async function resolveAll() {
    if (!await resolveInput('from')) return null;
    for (const id of usedStops()) if (!await resolveInput(id)) return null;
    if (!await resolveInput('to')) return null;
    const ids = ['from', ...usedStops(), 'to'];
    return { ids, pts: ids.map(i => [app.P[i].lon, app.P[i].lat]), labels: ids.map(i => app.P[i].label) };
  }

  // ---------- voice input ----------
  function wireMic(b) {
    if (!VOICE.supported) { b.style.display = 'none'; return; }
    b.onclick = () => VOICE.listen(txt => { const w = b.dataset.mic; $(w).value = txt; app.P[w] = null; updateGo(); resolveInput(w); }, (st, err) => { b.style.color = st === 'listening' ? 'var(--red)' : ''; if (st === 'listening') toast('Listening… say a town, address or place.'); if (st === 'error') toast(err === 'not-allowed' ? 'Microphone access is blocked.' : 'Didn\'t catch that. Try again.'); });
  }
  document.querySelectorAll('[data-mic]').forEach(wireMic);

  // ---------- top search ----------
  const q = $('q'), sug = $('suggest'); let qT;
  q.addEventListener('input', () => {
    clearTimeout(qT); const t = q.value.trim(); if (t.length < 3) { sug.classList.remove('on'); return; }
    qT = setTimeout(async () => {
      let items = [];
      try { items = RR.google.ok() ? await RR.google.suggest(t) : (await RR.geocode(t)).map(x => ({ label: x.label, resolve: async () => x })); } catch { }
      if (q.value.trim() !== t) return;
      sug.innerHTML = ''; items.forEach(x => { const d = document.createElement('div'); d.tabIndex = 0; d.innerHTML = RR.icon('pin') + `<span>${esc(x.label)}</span>`; d.onclick = async () => { sug.classList.remove('on'); q.value = ''; q.blur(); const pt = await x.resolve(); goTo(pt); }; sug.appendChild(d); });
      sug.classList.toggle('on', items.length > 0);
    }, 280);
  });
  q.addEventListener('keydown', async e => { if (e.key === 'Enter') { e.preventDefault(); const r = await RR.geocode(q.value.trim()).catch(() => []); if (r[0]) { sug.classList.remove('on'); q.value = ''; q.blur(); goTo(r[0]); } else toast('No match in WA.'); } });
  q.addEventListener('blur', () => setTimeout(() => sug.classList.remove('on'), 200));
  function goTo(pt) {
    setPoint('to', pt); RR.map.get().setView([pt.lat, pt.lon], 11);
    if (!app.P.from && app.ME) setPoint('from', { ...app.ME });
    openSheet('plan');
    if (app.P.from && S.base) $('go').click(); else toast(app.P.from ? 'Loading road network…' : 'Set your start point to plan the route.');
  }

  // ---------- planning ----------
  $('go').onclick = async () => {
    if (!S.base) return;
    const run = await resolveAll(); if (!run) return;
    const prof = tripProfile(), prefs = { avoidUnsealed: $('prefUnsealed').checked, preferHighways: $('prefHwy').checked };
    const keepAlerts = S.alerts; if (!$('prefClosures').checked) S.alerts = [];
    $('go').disabled = true;
    const res = await RR.routing.plan({ pts: run.pts, labels: run.labels, profile: prof, prefs, onStatus: setPlanStatus });
    S.alerts = keepAlerts; $('go').disabled = false; setPlanStatus('');
    app.RUN = run; app.PROF = prof; app.RES = res; app.sel = 0; app.vehId = RR.vehicles.active().id;
    if (res.error) { setPlanStatus(''); openSheet('route'); $('routeTitle').textContent = 'No legal route'; $('routeBody').innerHTML = `<div class="card" style="border-color:rgba(240,68,68,.4)"><b>No legal route found</b><p class="hint">${esc(res.error)}</p><p class="hint">The points may be on parts of the network that don't connect for this vehicle, or the height, width, length or closure rules block every way through. Check the vehicle and load, try a nearby place, or pick a higher network only if you're approved for it.</p></div>`; RR.map.clearRoutes(); return; }
    res.routes.forEach(r => r.conf.gaps.forEach(g => { const i = [r.s, ...(r.legs2 || []).slice(0, -1).map(l => l.t), r.t].indexOf(g); g.req = run.pts[i]; }));
    showRoute(0, true);
  };
  function showRoute(i, fit) {
    app.sel = i; const res = app.RES, r = res.routes[i];
    const b = RR.map.drawRoutes(res.routes, i, k => showRoute(k));
    if (fit && b) { const m = RR.map.get(); const pad = window.innerWidth < 900 ? { paddingTopLeft: [30, 90], paddingBottomRight: [30, window.innerHeight * 0.5] } : { paddingTopLeft: [470, 90], paddingBottomRight: [80, 90] }; m.fitBounds(b, pad); }
    renderRoute(r); openSheet('route'); refreshAlertMarkers();
  }

  // ---------- route details ----------
  function confBar(c) { const tot = Object.values(c.seg).reduce((a, b) => a + b, 0) || 1; const col = { confirmed: '#B7F23D', general: '#7FA83A', conditional: '#FFB020', unverified: '#F04444' }; return `<div class="confbar">${Object.entries(c.seg).filter(([, v]) => v > 0).map(([k, v]) => `<i style="width:${(100 * v / tot).toFixed(1)}%;background:${col[k]}" title="${k}"></i>`).join('')}</div>`; }
  function renderRoute(r) {
    const res = app.RES, prof = app.PROF, p = RR.vehicles.permit(prof);
    $('routeTitle').textContent = `To ${app.RUN.labels[app.RUN.labels.length - 1].split(',')[0]}`;
    let h = '';
    res.routes.forEach((x, i) => { h += `<div class="ropt ${i === app.sel ? 'on' : ''}" data-r="${i}"><div class="t">${fmtT(x.trueSecs || x.secs)}</div><div class="d">${fmtKm(x.total)}</div><div class="lbl"><b>${esc(x.label)}</b>${x.along.alerts.length ? `<span class="tag" style="color:var(--amber)">${x.along.alerts.length} alert${x.along.alerts.length > 1 ? 's' : ''}</span>` : ''}${x.conf.gaps.length ? '<span class="tag" style="color:var(--red)">Off-network leg</span>' : ''}</div>${confBar(x.conf)}</div>`; });
    h += `<div class="legend" style="margin:-2px 0 12px"><span><i class="sw" style="background:#B7F23D"></i>Confirmed access</span>${S.data.general ? '<span><i class="sw" style="background:#7FA83A"></i>General access street</span>' : ''}<span><i class="sw" style="background:#FFB020"></i>With conditions</span><span><i class="sw" style="background:#F04444"></i>Not verified</span></div>`;
    h += `<div class="drivebar" style="position:static;margin:0 0 12px;padding:0;background:none"><button class="btn primary big" id="startDrive" style="flex:1">${RR.icon('play')}Start</button><button class="btn big" id="demoDrive">Demo</button></div>`;
    h += permitHtml(prof);
    // access basis
    const basis = p.level === 'permit' ? ['red', 'Permit-dependent access', 'This trip is only legal under the permit noted above, on the route it specifies.'] : S.data.general ? ['lime', 'General access roads', 'Uses public roads open to general access vehicles, avoiding the Network 1 prohibited list.'] : ['lime', `Confirmed on ${RR.net(prof.net).short}`, `Every section is on the Main Roads ${RR.net(prof.net).label} (with conditions where marked).`];
    const items = [[basis[0], 'check', basis[1], basis[2]]];
    r.conf.gaps.forEach(g => items.push(['red', 'block', `${fmtKm(g.d)} off the approved network`, 'The run in or out isn\'t verified for this vehicle. It needs road-owner approval or a different vehicle.']));
    (res.restr.notes || []).filter(n => n.kind !== 'zone' || res.routes.some(x => x.metro)).forEach(n => items.push([n.kind === 'closure' ? 'red' : 'blue', { height: 'height', zone: 'wide', fwy: 'road', prohibited: 'block', dg: 'alert', closure: 'block' }[n.kind] || 'alert', { height: 'Low structures avoided', zone: 'Central Zones avoided', fwy: 'Freeways avoided', prohibited: 'Prohibited roads avoided', dg: 'Dangerous goods route', closure: 'Live closures avoided' }[n.kind] || 'Restriction', n.text]));
    r.tight.forEach(t => items.push(['amber', 'bridge', `Tight clearance: ${t.maxH.toFixed(2)} m`, `${t.descr} over ${t.road}${t.suburb ? ', ' + t.suburb : ''}. Within 0.5 m of what your load needs.`]));
    if (r.zones.length) items.push(['amber', 'wide', `Enters the ${r.zones.join(' and ')}`, 'Oversize vehicles have extra pilot, escort and convoy rules here.']);
    if (r.metro && (prof.width > 2.7 || prof.length > 22)) items.push(['amber', 'alert', 'Perth metro peak-hour curfew', 'Over 22 m long or 2.7 m wide: check your permit for 7:30–9:00 am and 4:30–6:00 pm limits.']);
    h += `<div class="card"><h3>Access and restrictions</h3><ul class="alist">${items.map(([t, ic, a, b]) => `<li><span class="ico ${t}">${RR.icon(ic)}</span><span class="tx"><b>${esc(a)}</b><small>${esc(b)}</small></span></li>`).join('')}</ul></div>`;
    // live alerts along route
    if (r.along.alerts.length) h += `<details class="sec" open><summary>${RR.icon('alert')} Live alerts on this route <span class="count">${r.along.alerts.length}</span><span class="tag live" style="margin-left:6px">Live</span></summary><div class="in"><ul class="alist">${RR.alerts.live(r.along.alerts).map((a, k) => `<li data-al="${k}"><span class="ico ${a.tone}">${RR.icon((RR.alerts.CATS.find(c => c.key === a.cat) || {}).icon || 'alert')}</span><span class="tx"><b>${esc(a.title)}</b><small>${esc(a.status || a.type)}${a.impact && a.impact !== a.status ? ' · ' + esc(a.impact) : ''}</small></span><span class="km">${fmtKm(r.along.alerts[k].along)}</span></li>`).join('')}</ul></div></details>`;
    // fuel and rest along route
    const fac = r.along.facilities.filter(f => f.kind !== 'rest' || f.tags.includes('toilets'));
    if (fac.length) h += `<details class="sec"><summary>${RR.icon('fuel')} Fuel, rest and parking on the way <span class="count">${fac.length}</span></summary><div class="in"><ul class="alist">${fac.slice(0, 40).map((f, k) => `<li data-fa="${k}"><span class="ico lime">${RR.icon(RR.facIcon(f))}</span><span class="tx"><b>${esc(f.name)}</b><small>${esc({ rtaa: 'Road train assembly area', hvrest: 'Heavy vehicle rest area', rest: 'Rest area', roadhouse: 'Roadhouse' }[f.kind] || '')}${tagTxt(f, ['rest', 'parking', 'roadhouse'])}</small></span><span class="km">${fmtKm(f.along)}</span></li>`).join('')}</ul><div class="hint">Main Roads WA rest areas, roadhouses and assembly areas within 3 km of the route. Truck Stops has diesel and services.</div></div></details>`;
    // directions
    h += `<details class="sec"><summary>${RR.icon('route')} Turn-by-turn <span class="count">${r.steps.length}</span><button class="iconbtn" id="copyDir" style="margin-left:auto;width:34px;height:34px" aria-label="Copy directions">${RR.icon('copy')}</button></summary><div class="in"><ul class="steps">${r.steps.map((s, k) => `<li data-st="${k}"><span class="ar">${ARROW(s.instr)}</span><span>${esc(s.instr)} <b>${esc(s.name)}</b></span><span class="km">${fmtKm(s.len)}</span></li>`).join('')}<li><span class="ar">⚑</span><span>Arrive</span><span></span></li></ul></div></details>`;
    if (r.conditions.length) h += `<details class="sec"><summary>${RR.icon('alert')} Road conditions <span class="count">${r.conditions.length}</span></summary><div class="in">${r.conditions.sort((a, b) => b.notThrough - a.notThrough).map((c, k) => `<div class="cond ${c.notThrough ? 'hard' : ''}" data-cd="${k}"><b>${esc(c.road)}</b>${esc(c.text)}</div>`).join('')}</div></details>`;
    if (r.rulesNear.length) h += `<details class="sec"><summary>${RR.icon('route')} Intersection restrictions <span class="count">${r.rulesNear.length}</span></summary><div class="in">${r.rulesNear.map((x, k) => `<div class="cond" data-rn="${k}"><b>${esc(x.where || 'Intersection')}</b>${esc(x.text)}${x.parsed ? '' : ' (check manually)'}</div>`).join('')}</div></details>`;
    h += `<div class="hint" style="margin-bottom:8px">Times are planning estimates. Routes use Main Roads WA data loaded live; always follow signs and your notice or permit.</div>`;
    const body = $('routeBody'); body.innerHTML = h; body.scrollTop = 0;
    body.querySelectorAll('[data-r]').forEach(el => el.onclick = () => showRoute(+el.dataset.r));
    const fly = (pt, z = 14) => RR.map.get().setView([pt[1], pt[0]], z);
    body.querySelectorAll('[data-st]').forEach(el => el.onclick = () => fly(r.steps[+el.dataset.st].at));
    body.querySelectorAll('[data-al]').forEach(el => el.onclick = () => { const a = RR.alerts.live(r.along.alerts)[+el.dataset.al]; fly(a.at, 12); });
    body.querySelectorAll('[data-fa]').forEach(el => el.onclick = () => fly(fac[+el.dataset.fa].at, 13));
    body.querySelectorAll('[data-cd]').forEach(el => el.onclick = () => fly(r.conditions[+el.dataset.cd].at, 13));
    body.querySelectorAll('[data-rn]').forEach(el => el.onclick = () => fly(r.rulesNear[+el.dataset.rn].at, 16));
    $('startDrive').onclick = () => drive(false); $('demoDrive').onclick = () => drive(true);
    $('copyDir').onclick = async e => { e.preventDefault(); e.stopPropagation(); const txt = [`RigRoute: ${app.RUN.labels.join(' → ')}`, `${prof.name} (${RR.net(prof.net).short}), ${fmtKm(r.total)}, ${fmtT(r.trueSecs || r.secs)}`, `Permit: ${p.title}`, ...r.steps.map((s, k) => `${k + 1}. ${s.instr} ${s.name} (${fmtKm(s.len)})`), 'Arrive'].join('\n'); try { await navigator.clipboard.writeText(txt); toast('Directions copied.'); } catch { toast('Copy isn\'t allowed here.'); } };
  }
  const ARROW = i => /^Arrive at stop/.test(i) ? '📍' : /^Leave on|^Start/.test(i) ? '●' : /sharp left/.test(i) ? '↰' : /sharp right/.test(i) ? '↱' : /left/.test(i) ? (/Bear/.test(i) ? '↖' : '←') : /right/.test(i) ? (/Bear/.test(i) ? '↗' : '→') : '↑';

  // ---------- driving ----------
  let follow = true;
  function drive(demo) {
    const r = app.RES.routes[app.sel]; if (!r) return; follow = true;
    const endInfo = r.t.d > 300 ? `Your destination is ${fmtKm(r.t.d)} further, off the approved network.` : null;
    const ok = NAV.start(r, {
      map: RR.map.get(), arrow: ARROW, net: RR.net(app.PROF.net).short, endInfo, follow: () => follow, simSpeed: () => 1,
      ui: { arrow: $('nArrow'), dist: $('nDist'), instr: $('nInstr'), eta: $('nEta'), flash: $('flash'), junc: { svg: $('jSvg'), dist: $('jDist'), bar: $('jBar'), label: $('jLabel') } },
      graph: () => S.data.general ? S.local.g || S.base : S.base,
      reroute: (pt, reached) => { const run = app.RUN; const stops = run.pts.slice(1, -1), labs = run.labels.slice(1, -1); const G = S.data.general ? S.local.g || S.base : S.base; const nr = RR.routing.reroute(G, [pt, ...stops.slice(reached), run.pts[run.pts.length - 1]], ['Current position', ...labs.slice(reached), run.labels[run.labels.length - 1]], reached + 1); if (nr && !nr.error) { app.RES.routes[app.sel] = Object.assign(nr, { conf: r.conf, along: r.along, tight: r.tight, zones: r.zones, label: r.label }); } return nr; },
      drawRoute: nr => RR.map.drawRoutes([nr], 0)
    }, demo);
    NAV.setMuted(!$('setVoice').checked);
    setTimeout(() => RR.map.get().invalidateSize(), 50);
    if (ok && !demo) toast('Driving mode on. Keep the screen open.');
  }
  RR.map.get && 0;
  $('nStop').onclick = () => { NAV.stop(); setTimeout(() => { RR.map.get().invalidateSize(); showRoute(app.sel, true); }, 60); };
  $('nCentre').onclick = () => { follow = true; };
  let muted = false; $('nMute').onclick = () => { muted = !muted; NAV.setMuted(muted); $('nMute').textContent = muted ? '🔇' : '🔊'; };

  // ---------- alerts ----------
  function allAlerts() { return RR.alerts.live(S.alerts).concat(RR.alerts.rules(RR.vehicles.active(), null)); }
  function scopedAlerts() {
    const all = allAlerts(), sc = app.alertScope, r = app.RES && !app.RES.error ? app.RES.routes[app.sel] : null;
    if (sc === 'route' && r) { const loc = RR.routing.alongRoute; const along = alongIdx(r); return all.map(a => { const d = along(a.at); return d == null ? null : { ...a, along: d }; }).filter(Boolean).sort((a, b) => a.along - b.along); }
    const c = sc === 'near' ? (app.ME ? [app.ME.lon, app.ME.lat] : (() => { const m = RR.map.get().getCenter(); return [m.lng, m.lat]; })()) : null;
    if (c) return all.map(a => ({ ...a, dist: RAV.hav(c, a.at) })).filter(a => a.dist < 100000).sort((a, b) => a.dist - b.dist);
    return all.filter(a => a.source && /live/.test(a.source)).concat(all.filter(a => !/live/.test(a.source || '') && ['lowbridge', 'oversize'].includes(a.cat)));
  }
  function alongIdx(r) { const line = r.line, stride = Math.max(1, Math.floor(line.length / 1500)); const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + RAV.hav(line[i - 1], line[i])); return pt => { let best = 1e12, bi = 0; for (let i = 0; i < line.length; i += stride) { const d = RAV.hav(pt, line[i]); if (d < best) { best = d; bi = i; } } return best < 1500 ? cum[bi] : null; }; }
  function renderAlerts() {
    const hasRoute = app.RES && !app.RES.error;
    if (!hasRoute && app.alertScope === 'route') app.alertScope = 'near';
    $('alertScope').innerHTML = [['route', 'Along my route', !hasRoute], ['near', 'Near me'], ['wa', 'All WA (live)']].map(([k, l, dis]) => `<button class="chip ${app.alertScope === k ? 'on' : ''}" data-sc="${k}" ${dis ? 'disabled style="opacity:.4"' : ''}>${l}</button>`).join('');
    const list = scopedAlerts();
    const counts = {}; list.forEach(a => counts[a.cat] = (counts[a.cat] || 0) + 1);
    $('alertCats').innerHTML = RR.alerts.CATS.map(c => `<button class="chip ${app.alertCat === c.key ? 'on' : ''}" data-cat="${c.key}">${c.label}<span class="n">${c.key === 'all' ? list.length : counts[c.key] || 0}</span></button>`).join('');
    const shown = list.filter(a => app.alertCat === 'all' || a.cat === app.alertCat).slice(0, 150);
    $('alertList').innerHTML = shown.length ? shown.map((a, k) => { const cat = RR.alerts.CATS.find(c => c.key === a.cat) || {}; const dist = a.along != null ? fmtKm(a.along) : a.dist != null ? fmtKm(a.dist) : ''; return `<li data-k="${k}"><span class="ico ${a.tone}">${RR.icon(cat.icon || 'alert')}</span><span class="tx"><b>${esc(a.title)}</b><small>${esc(a.status || cat.label)}${a.impact && a.impact !== a.status ? ' · ' + esc(a.impact) : ''}</small><small style="color:var(--dim)">${esc(a.source || '')}${a.updated ? ' · updated ' + esc(a.updated) : ''}</small></span><span class="km">${dist}</span></li>`; }).join('') : `<li><span class="tx"><b>Nothing here right now</b><small>No ${app.alertCat === 'all' ? '' : (RR.alerts.CATS.find(c => c.key === app.alertCat) || {}).label.toLowerCase() + ' '}alerts ${app.alertScope === 'route' ? 'on your route' : app.alertScope === 'near' ? 'within 100 km' : 'in WA'}.</small></span></li>`;
    $('alertNote').innerHTML = 'Closures, incidents, flooding and roadworks are live from the Main Roads WA Travel Map. Low bridges, height and weight limits come from Main Roads structure and network data for your vehicle. For bushfire and emergency warnings check <a href="https://www.emergency.wa.gov.au" target="_blank" rel="noopener">Emergency WA</a>.';
    $('alertScope').querySelectorAll('[data-sc]').forEach(b => b.onclick = () => { app.alertScope = b.dataset.sc; renderAlerts(); });
    $('alertCats').querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { app.alertCat = b.dataset.cat; renderAlerts(); });
    $('alertList').querySelectorAll('[data-k]').forEach(li => li.onclick = () => { const a = shown[+li.dataset.k]; RR.map.get().setView([a.at[1], a.at[0]], 13); if (window.innerWidth < 900) openSheet(null); });
  }
  function refreshAlertMarkers() {
    const live = RR.alerts.live(S.alerts);
    const r = app.RES && !app.RES.error ? app.RES.routes[app.sel] : null;
    const rules = RR.alerts.rules(RR.vehicles.active(), r).filter(a => a.cat === 'lowbridge' || a.cat === 'weight');
    // keep the map calm: live alerts always, vehicle-specific low bridges/limits only when zoomed in or near the route
    const z = RR.map.get().getZoom();
    const near = r ? alongIdx(r) : null;
    const extra = rules.filter(a => z >= 11 || (near && near(a.at) != null));
    RR.map.setAlerts(live.concat(extra), a => { RR.map.get().setView([a.at[1], a.at[0]], 13); toast(`${a.title}: ${a.status || ''}`, 5000); });
    const n = live.filter(a => a.tone === 'red').length + (r ? 0 : 0);
    $('alertBadge').hidden = !live.length; $('alertBadge').textContent = live.length; $('tabAlertDot').hidden = !n;
    const counts = { closure: 0, flood: 0, roadworks: 0 }; live.forEach(a => counts[a.cat] != null && counts[a.cat]++);
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    $('livepill').innerHTML = `<span class="pill" data-p="closure"><i style="background:var(--red)"></i>${pl(counts.closure, 'closure', 'closures')}</span><span class="pill" data-p="flood"><i style="background:var(--blue)"></i>${pl(counts.flood, 'flood alert', 'flood alerts')}</span><span class="pill" data-p="roadworks"><i style="background:var(--amber)"></i>${pl(counts.roadworks, 'roadworks site', 'roadworks sites')}</span>`;
    $('livepill').querySelectorAll('[data-p]').forEach(p => p.onclick = () => { app.alertCat = p.dataset.p; app.alertScope = 'wa'; openSheet('alerts'); });
  }
  RR.on('zoom', () => refreshAlertMarkers());

  // ---------- truck stops ----------
  const gCache = new Map();
  async function renderStops() {
    const r = app.RES && !app.RES.error ? app.RES.routes[app.sel] : null;
    if (!r && app.stopScope === 'route') app.stopScope = 'near';
    $('stopScope').innerHTML = [['route', 'Along my route', !r], ['near', 'Near me / map']].map(([k, l, dis]) => `<button class="chip ${app.stopScope === k ? 'on' : ''}" data-sc="${k}" ${dis ? 'disabled style="opacity:.4"' : ''}>${l}</button>`).join('');
    $('stopCats').innerHTML = FAC.map(c => `<button class="chip ${app.stopCat === c.key ? 'on' : ''}" data-cat="${c.key}">${RR.icon(c.icon)}${c.label}</button>`).join('');
    $('stopScope').querySelectorAll('[data-sc]').forEach(b => b.onclick = () => { app.stopScope = b.dataset.sc; renderStops(); });
    $('stopCats').querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { app.stopCat = b.dataset.cat; renderStops(); });
    const cat = FAC.find(c => c.key === app.stopCat);
    const centre = app.ME && app.stopScope === 'near' ? [app.ME.lon, app.ME.lat] : (() => { const m = RR.map.get().getCenter(); return [m.lng, m.lat]; })();
    const along = r && app.stopScope === 'route' ? alongIdx(r) : null;
    const place = f => { if (along) { const d = along(f.at); return d == null ? null : { ...f, along: d }; } const d = RAV.hav(centre, f.at); return d < 150000 ? { ...f, dist: d } : null; };
    let items = cat.mr ? S.facilities.filter(cat.mr).map(place).filter(Boolean) : [];
    $('stopList').innerHTML = '<li><span class="tx"><b>Searching…</b></span></li>';
    if (cat.g && RR.google.ok()) {
      const probes = along ? sampleLine(r.line, 6) : [centre];
      for (const p of probes) { const k = cat.key + p.map(v => v.toFixed(2)).join(); if (!gCache.has(k)) gCache.set(k, RR.google.nearby(cat.g, p, 50, 10).catch(() => [])); const got = await gCache.get(k); got.forEach(g => { const x = place({ ...g, cat: cat.key, kind: 'g', tags: [] }); if (x && !items.some(i => RAV.hav(i.at, x.at) < 150)) items.push(x); }); }
    }
    if (app.stopCat !== cat.key) return;
    items.sort((a, b) => (a.along ?? a.dist) - (b.along ?? b.dist));
    $('stopList').innerHTML = items.length ? items.slice(0, 60).map((f, k) => `<li data-k="${k}"><span class="ico lime">${RR.icon(RR.facIcon(f))}</span><span class="tx"><b>${esc(f.name)}</b><small>${esc(f.address || ({ rtaa: 'Road train assembly area', hvrest: 'Heavy vehicle rest area', rest: 'Rest area', roadhouse: 'Roadhouse' }[f.kind] || ''))}${tagTxt(f, ['rest', 'parking', 'roadhouse', 'diesel', 'food'])}</small><small style="color:var(--dim)">${esc(f.source)}</small></span><span class="km">${fmtKm(f.along ?? f.dist)}</span></li>`).join('') : `<li><span class="tx"><b>No ${cat.label.toLowerCase()} found</b><small>${cat.g && !RR.google.ok() ? 'Google Places isn\'t available right now.' : 'Try the other scope or move the map.'}</small></span></li>`;
    $('stopNote').textContent = (cat.mr ? 'Rest areas, roadhouses and assembly areas: Main Roads WA. ' : '') + (cat.g ? 'Businesses: Google Places, so check opening hours and truck access before relying on them.' : '');
    RR.map.setFacilities(items.slice(0, 60), f => RR.map.get().setView([f.at[1], f.at[0]], 14));
    $('stopList').querySelectorAll('[data-k]').forEach(li => li.onclick = () => { const f = items[+li.dataset.k]; RR.map.get().setView([f.at[1], f.at[0]], 14); if (window.innerWidth < 900) openSheet(null); });
  }
  function tagTxt(f, skip) { const t = (f.tags || []).filter(x => !skip.includes(x)); return t.length ? ' · ' + esc(t.join(', ')) : ''; }
  const sampleLine = (line, n) => { const out = []; for (let i = 0; i < n; i++) out.push(line[Math.floor((line.length - 1) * (i + 0.5) / n)]); return out; };

  // ---------- profiles ----------
  function renderProfiles() {
    const act = RR.vehicles.active();
    $('vehList').innerHTML = RR.vehicles.all().map(v => `<div class="vcard ${v.id === act.id ? 'on' : ''}" data-id="${v.id}"><span class="radio"></span><span class="vi">${RR.icon('truck')}</span><span class="tx"><b>${esc(v.name)}</b><small>${esc(VT(v.type).label || '')} · ${esc(vehSummary(v))}${v.dg ? ' · DG' : ''}</small></span><button class="iconbtn" data-edit="${v.id}" aria-label="Edit">${RR.icon('edit')}</button></div>`).join('');
    $('vehList').querySelectorAll('.vcard').forEach(el => el.onclick = e => { if (e.target.closest('[data-edit]')) return; RR.vehicles.setActive(el.dataset.id); renderProfiles(); toast(`${RR.vehicles.active().name} selected`); });
    $('vehList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editVehicle(RR.vehicles.all().find(v => v.id === b.dataset.edit)));
  }
  $('vehAdd').onclick = () => editVehicle(RR.vehicles.blank('semi'), true);
  let editing = null;
  $('veType').innerHTML = RR.config.vehicleTypes.map(t => `<option value="${t.key}">${t.label}</option>`).join('');
  const groups = [...new Set(RR.config.networks.map(n => n.group))];
  $('veNet').innerHTML = groups.map(g => `<optgroup label="${g}">${RR.config.networks.filter(n => n.group === g).map(n => `<option value="${n.key}">${n.label}</option>`).join('')}</optgroup>`).join('');
  const VE = { veName: 'name', veType: 'type', veNet: 'net', veH: 'height', veW: 'width', veL: 'length', veGVM: 'gvm', veGCM: 'gcm', veAxles: 'axles', veAxleLim: 'axleLimit', veTrailer: 'trailer', veOS: 'osClass' };
  function editVehicle(v, isNew) {
    editing = { ...v, _new: !!isNew };
    for (const [id, k] of Object.entries(VE)) $(id).value = v[k] ?? '';
    $('veDG').checked = !!v.dg; $('veTitle').textContent = isNew ? 'New vehicle' : 'Edit vehicle'; $('veDel').hidden = isNew;
    paintVePermit(); openSheet('vedit');
  }
  const readVe = () => { const v = { ...editing }; for (const [id, k] of Object.entries(VE)) v[k] = ['height', 'width', 'length', 'gvm', 'gcm', 'axles', 'axleLimit'].includes(k) ? ($(id).value === '' ? '' : +$(id).value) : $(id).value; v.dg = $('veDG').checked; return v; };
  const paintVePermit = () => { $('vePermit').innerHTML = permitHtml(readVe()); };
  Object.keys(VE).forEach(id => $(id).addEventListener('input', paintVePermit)); $('veDG').onchange = paintVePermit;
  $('veType').onchange = () => { const t = VT($('veType').value); if (!$('veName').value || RR.config.vehicleTypes.some(x => x.label === $('veName').value)) $('veName').value = t.label; $('veNet').value = t.net; $('veH').value = t.h; $('veW').value = t.w; $('veL').value = t.l; $('veAxles').value = t.axles; $('veTrailer').value = t.trailer; $('veOS').value = t.key === 'oversize' ? 'class1' : 'none'; paintVePermit(); };
  $('veSave').onclick = () => { const v = readVe(); delete v._new; if (!v.name.trim()) v.name = VT(v.type).label || 'Vehicle'; RR.vehicles.upsert(v); RR.vehicles.setActive(v.id); toast('Vehicle saved'); openSheet('profile'); };
  $('veDel').onclick = () => { if (!RR.vehicles.remove(editing.id)) return toast('Keep at least one vehicle.'); toast('Vehicle deleted'); openSheet('profile'); };
  $('veBack').onclick = () => openSheet('profile');
  $('setNet').onchange = () => RR.map.drawNetwork(S.data, $('setNet').checked);
  $('setVoice').checked = RR.store.get('voice', true); $('setVoice').onchange = () => RR.store.set('voice', $('setVoice').checked);
  $('refresh').onclick = async () => { toast('Refreshing Main Roads data…'); await loadNetwork(true); await loadLive(true); toast('Data refreshed'); };

  // ---------- live data ----------
  async function loadLive(force) {
    try { S.alerts = await RR.mainroads.liveAlerts(); app.liveAt = new Date(); } catch { S.alerts = S.alerts || []; }
    refreshAlertMarkers(); if (app.sheet === 'alerts') renderAlerts();
  }

  // ---------- boot ----------
  async function boot() {
    RR.paintIcons();
    RR.map.init(); RR.map.drawZones(RR.config.zones);
    paintVehicle();
    RR.google.load().then(() => { if (RR.map.addGoogle()) { } }).catch(() => { });
    locate(false);
    const net = loadNetwork();
    RR.mainroads.structures().then(s => { S.structures = s; refreshAlertMarkers(); });
    RR.mainroads.facilities().then(f => { S.facilities = f; });
    loadLive(); setInterval(loadLive, 5 * 60 * 1000);
    setTimeout(() => $('splash').classList.add('off'), 900);
    await net;
  }
  boot();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
