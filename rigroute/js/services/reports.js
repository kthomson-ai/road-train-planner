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
  // ---- shared backend (REST, ready to point at a database service) ----
  const remote = {
    async list(bbox) { const r = await fetch(`${cfg().endpoint}/reports?bbox=${bbox ? bbox.join(',') : ''}`); if (!r.ok) throw new Error(r.status); return (await r.json()).map(x => ({ ...x, mine: false })); },
    async add(r) { const res = await fetch(`${cfg().endpoint}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }); if (!res.ok) throw new Error(res.status); return res.json(); },
    async vote(id, still) { await fetch(`${cfg().endpoint}/reports/${id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ still }) }); },
    async remove(id) { await fetch(`${cfg().endpoint}/reports/${id}`, { method: 'DELETE' }); }
  };
  const be = () => (cfg().mode === 'remote' && cfg().endpoint ? remote : local);
  const shared = () => be() === remote;

  async function add(typeKey, at, extra = {}) {
    const t = type(typeKey), now = Date.now();
    const r = { id: 'r' + now.toString(36) + Math.random().toString(36).slice(2, 6), type: typeKey, at, heading: extra.heading ?? null, note: extra.note || '', side: extra.side || '', created: now, expires: now + t.ttl, up: 0, down: 0, mine: true, source: shared() ? 'Driver report' : 'Your report (this device)' };
    await be().add(r); RR.emit('reports'); return r;
  }
  async function list(bbox) { try { return await be().list(bbox); } catch { return local.list(); } }
  async function vote(id, still) { await be().vote(id, still); RR.emit('reports'); }
  async function remove(id) { await be().remove(id); RR.emit('reports'); }
  // as alert objects so they show on the map, in Alerts and along the route
  const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
  const asAlerts = reps => reps.map(r => { const t = type(r.type); return { id: r.id, cat: 'report', rtype: r.type, tone: t.tone, icon: t.icon, title: `${t.label}${r.note ? ': ' + r.note : ''}`, status: `Reported ${ago(Date.now() - r.created)}${r.up ? ` · ${r.up} confirmed` : ''}`, impact: r.side ? (r.side === 'mine' ? 'My side of the road' : 'Other side of the road') : '', at: r.at, source: r.source, report: r }; });
  return { TYPES, type, add, list, vote, remove, asAlerts, shared };
})();
