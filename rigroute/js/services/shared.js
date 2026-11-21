// Shared data in Supabase (public key; row level security limits what the app can do):
//  - saved sites: depots / customer sites with access notes, visible to all ROAM testers
//  - ETA shares: a private link showing the truck's position and ETA while driving
RR.shared = (() => {
  const cfg = () => RR.config.reports || {};
  const dev = () => { let d = RR.store.get('device', null); if (!d) { d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); RR.store.set('device', d); } return d; };
  async function req(path, opt = {}) {
    const r = await fetch(cfg().endpoint + path, { ...opt, headers: { apikey: cfg().key, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    if (!r.ok) { let m = r.status; try { m = (await r.json()).message || m; } catch { } throw new Error(m); }
    return r.status === 204 || r.status === 201 ? null : r.json();
  }
  const on = () => !!(cfg().endpoint && cfg().key);

  // ---------- saved sites ----------
  let sites = RR.store.get('sitesCache', []);
  const mineSet = () => new Set(RR.store.get('mySites', []));
  async function listSites() {
    if (!on()) return sites;
    try { const rows = await req('/sites?select=id,name,kind,lon,lat,notes,updated&order=name.asc&limit=1000'); sites = rows.map(x => ({ ...x, at: [x.lon, x.lat], mine: mineSet().has(x.id) })); RR.store.set('sitesCache', sites); }
    catch { /* offline: keep the cached copy */ }
    RR.emit('sites'); return sites;
  }
  async function saveSite(s) {
    const row = { id: s.id || 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: s.name.slice(0, 80), kind: s.kind || 'customer', lon: +s.at[0].toFixed(6), lat: +s.at[1].toFixed(6), notes: (s.notes || '').slice(0, 600) };
    if (s.id) await req('/rpc/update_site', { method: 'POST', body: JSON.stringify({ sid: s.id, dev: dev(), nm: row.name, kd: row.kind, nt: row.notes }) });
    else { await req('/sites', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...row, device: dev() }) }); RR.store.set('mySites', [...mineSet(), row.id]); }
    await listSites(); return row.id;
  }
  async function deleteSite(id) { await req('/rpc/delete_site', { method: 'POST', body: JSON.stringify({ sid: id, dev: dev() }) }); await listSites(); }
  const siteNear = (pt, m = 300) => sites.map(s => ({ s, d: RAV.hav(pt, s.at) })).filter(x => x.d < m).sort((a, b) => a.d - b.d).map(x => x.s)[0] || null;

  // ---------- ETA shares ----------
  let share = RR.store.get('activeShare', null), timer = null;
  const token = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join(''); };
  async function startShare({ dest, destAt, vehicle, pos, eta }) {
    const t = token();
    await req('/shares', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ token: t, dest: dest.slice(0, 120), dest_lon: destAt[0], dest_lat: destAt[1], vehicle: vehicle.slice(0, 60), lon: pos[0], lat: pos[1], eta: eta.toISOString(), status: 'driving', expires: new Date(Date.now() + 12 * 3600e3).toISOString() }) });
    share = { token: t, started: Date.now() }; RR.store.set('activeShare', share);
    return shareUrl(t);
  }
  const shareUrl = t => new URL('share.html?t=' + t, location.href).href;
  async function updateShare(pos, eta, status = 'driving') {
    if (!share) return;
    try { await req('/rpc/update_share', { method: 'POST', body: JSON.stringify({ tk: share.token, lo: +pos[0].toFixed(5), la: +pos[1].toFixed(5), et: eta ? eta.toISOString() : null, st: status }) }); } catch { /* retry next tick */ }
  }
  async function stopShare(status = 'arrived') { if (!share) return; const s = share; share = null; RR.store.set('activeShare', null); try { await req('/rpc/update_share', { method: 'POST', body: JSON.stringify({ tk: s.token, lo: null, la: null, et: null, st: status }) }); } catch { } }
  const activeShare = () => share && Date.now() - share.started < 12 * 3600e3 ? { ...share, url: shareUrl(share.token) } : null;

  return { listSites, saveSite, deleteSite, siteNear, sites: () => sites, startShare, updateShare, stopShare, activeShare, shareUrl };
})();
