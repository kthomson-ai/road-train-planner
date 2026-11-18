// Driver reports (Waze-style). One interface, swappable backend:
//  - 'local'  : stored on this device only (works now, nothing shared)
//  - 'remote' : shared between drivers via RR.config.reports.endpoint (to be connected)
// Each report: { id, type, at:[lon,lat], heading, note, side, created, expires, up, down, mine, source }
RR.reports = (() => {
  const H = 3600e3;
  const TYPES = [
    { key: 'crash', label: 'Crash', icon: 'crash', tone: 'red', ttl: 2 * H },
    { key: 'hazard', label: 'Hazard on road', icon: 'alert', tone: 'amber', ttl: 2 * H, details: ['Object on road', 'Pothole', 'Stopped vehicle', 'Broken-down truck', 'Debris / tyre'] },
    { key: 'animal', label: 'Animals / stock', icon: 'paw', tone: 'amber', ttl: 1 * H, details: ['Livestock on road', 'Kangaroos', 'Stock crossing', 'Roadkill'] },
    { key: 'closure', label: 'Road closed', icon: 'block', tone: 'red', ttl: 6 * H },
    { key: 'flood', label: 'Flooding', icon: 'water', tone: 'blue', ttl: 12 * H, details: ['Water over road', 'Washout', 'Floodway rising'] },
    { key: 'roadworks', label: 'Roadworks', icon: 'cone', tone: 'amber', ttl: 24 * H, details: ['Stop/slow', 'Lane closed', 'Single lane', 'Gravel / loose surface'] },
    { key: 'police', label: 'Police / inspection', icon: 'shield', tone: 'blue', ttl: 1 * H, details: ['Police', 'Heavy vehicle inspection', 'Breath testing'] },
    { key: 'weighbridge', label: 'Weighbridge open', icon: 'scale', tone: 'blue', ttl: 3 * H },
    { key: 'clearance', label: 'Low clearance', icon: 'height', tone: 'red', ttl: 30 * 24 * H, details: ['Low branches', 'Low cable', 'Signed clearance wrong'] },
    { key: 'surface', label: 'Rough / unsealed', icon: 'road', tone: 'amber', ttl: 7 * 24 * H, details: ['Corrugations', 'Soft edges', 'Bulldust', 'Unsealed section'] },
    { key: 'fire', label: 'Fire / smoke', icon: 'fire', tone: 'red', ttl: 3 * H }
  ];
  const type = k => TYPES.find(t => t.key === k) || TYPES[1];
  const KEY = 'reports';
  const cfg = () => (RR.config.reports || { mode: 'local' });

  // ---- local backend ----
  const local = {
    async list() { const now = Date.now(); const all = (RR.store.get(KEY, []) || []).filter(r => r.expires > now && r.down < 3); RR.store.set(KEY, all); return all; },
    async add(r) { const all = await local.list(); all.push(r); RR.store.set(KEY, all); return r; },
    async vote(id, still) { const all = await local.list(); const r = all.find(x => x.id === id); if (r) { if (still) { r.up++; r.expires = Math.max(r.expires, Date.now() + type(r.type).ttl / 2); } else r.down++; RR.store.set(KEY, all); } return r; },
    async remove(id) { RR.store.set(KEY, (await local.list()).filter(r => r.id !== id)); }
  };
  // ---- shared backend: Supabase REST (public key; the database's security rules limit what it can do) ----
  const dev = () => { let d = RR.store.get('device', null); if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); RR.store.set('device', d); } return d; };
  const hdr = () => ({ apikey: cfg().key, 'Content-Type': 'application/json' });
  const mine = () => new Set(RR.store.get('myReports', []));
  const COLS = 'id,type,lon,lat,note,side,created,expires,up,down';
  const fromRow = x => ({ id: x.id, type: x.type, at: [x.lon, x.lat], note: x.note || '', side: x.side || '', created: Date.parse(x.created), expires: Date.parse(x.expires), up: x.up, down: x.down, mine: mine().has(x.id), source: mine().has(x.id) ? 'Your report' : 'Driver report' });
  async function req(path, opt = {}) { const r = await fetch(cfg().endpoint + path, { ...opt, headers: { ...hdr(), ...(opt.headers || {}) } }); if (!r.ok) { let m = r.status; try { m = (await r.json()).message || m; } catch { } throw new Error(m); } return r.status === 204 || r.status === 201 ? null : r.json(); }
  const toRow = r => ({ id: r.id, type: r.type, lon: +r.at[0].toFixed(6), lat: +r.at[1].toFixed(6), note: (r.note || '').slice(0, 80), side: r.side || '', expires: new Date(r.expires).toISOString(), device: dev() });
  // reports made without signal wait in a queue and are sent on the next successful contact
  const queue = { get: () => RR.store.get('repQueue', []), set: q => RR.store.set('repQueue', q) };
  async function flush() { const q = queue.get(); if (!q.length) return; const left = []; for (const r of q) { if (r.expires < Date.now()) continue; try { await req('/reports', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(toRow(r)) }); } catch (e) { if (/fetch|network|Failed/i.test(e.message)) left.push(r); } } queue.set(left); }
  const remote = {
    async list(bbox) {
      await flush().catch(() => { });
      const box = bbox ? `&lon=gte.${bbox[0]}&lon=lte.${bbox[2]}&lat=gte.${bbox[1]}&lat=lte.${bbox[3]}` : '';
      const rows = await req(`/reports?select=${COLS}&order=created.desc&limit=500${box}`);
      const out = rows.map(fromRow);
      for (const r of queue.get()) if (!out.some(o => o.id === r.id)) out.push({ ...r, source: 'Your report (waiting for signal)' });
      return out;
    },
    async add(r) {
      RR.store.set('myReports', [...mine(), r.id].slice(-200));
      try { await req('/reports', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(toRow(r)) }); }
      catch (e) { if (/fetch|network|Failed/i.test(e.message)) { queue.set([...queue.get(), r]); r.queued = true; } else throw e; }
      return r;
    },
    async vote(id, still) { await req('/rpc/vote_report', { method: 'POST', body: JSON.stringify({ rid: id, still }) }); },
    async remove(id) { queue.set(queue.get().filter(r => r.id !== id)); await req('/rpc/delete_report', { method: 'POST', body: JSON.stringify({ rid: id, dev: dev() }) }).catch(() => { }); }
  };
  // tester feedback (write-only from the app)
  async function feedback(f) { await req('/feedback', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...f, device: dev() }) }); }
  const be = () => (cfg().mode === 'remote' && cfg().endpoint && cfg().key ? remote : local);
  const shared = () => be() === remote;

  let lastOk = 0, lastList = null;
  async function add(typeKey, at, extra = {}) {
    const t = type(typeKey), now = Date.now();
    const r = { id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6), type: typeKey, at, heading: extra.heading ?? null, note: extra.note || '', side: extra.side || '', created: now, expires: now + t.ttl, up: 0, down: 0, mine: true, source: shared() ? 'Your report' : 'Your report (this device)' };
    await be().add(r); RR.emit('reports'); return r;
  }
  async function list(bbox) { try { const l = await be().list(bbox); lastOk = Date.now(); return l; } catch { return shared() ? (lastList || []) : local.list(); } }
  async function vote(id, still) { await be().vote(id, still); RR.emit('reports'); }
  async function remove(id) { await be().remove(id); RR.emit('reports'); }
  // as alert objects so they show on the map, in Alerts and along the route
  const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const asAlerts = reps => reps.map(r => { const t = type(r.type); return { id: r.id, cat: 'report', rtype: r.type, tone: t.tone, icon: t.icon, title: `${t.label}${r.note ? ': ' + r.note : ''}`, status: `Reported ${ago(Date.now() - r.created)}${r.up ? ` · ${r.up} confirmed` : ''}`, impact: r.side ? (r.side === 'mine' ? 'My side of the road' : 'Other side of the road') : '', at: r.at, source: r.source, report: r }; });
  return { TYPES, type, add, list, vote, remove, asAlerts, shared, feedback };
})();
