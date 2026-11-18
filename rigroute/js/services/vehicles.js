// Vehicle profiles (saved on this device) and the permit check.
RR.vehicles = (() => {
  const C = RR.config;
  const blank = t => { const p = C.vehicleTypes.find(x => x.key === t) || C.vehicleTypes[1]; return { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: p.label, type: p.key, net: p.net, height: p.h, width: p.w, length: p.l, gvm: '', gcm: '', axles: p.axles, axleLimit: '', trailer: p.trailer, dg: false, osClass: p.key === 'oversize' ? 'class1' : 'none' }; };
  let list = RR.store.get('profiles', null);
  if (!list || !list.length) { list = [Object.assign(blank('roadtrain'), { name: 'Road train (double)' }), Object.assign(blank('semi'), { name: 'Semi-trailer' }), Object.assign(blank('oversize'), { name: 'Low loader – oversize' })]; RR.store.set('profiles', list); }
  let activeId = RR.store.get('activeProfile', list[0].id);
  if (!list.some(v => v.id === activeId)) activeId = list[0].id;
  const save = () => { RR.store.set('profiles', list); RR.store.set('activeProfile', activeId); RR.emit && RR.emit('profiles'); };
  const api = {
    all: () => list,
    active: () => list.find(v => v.id === activeId) || list[0],
    setActive(id) { activeId = id; save(); },
    upsert(v) { const i = list.findIndex(x => x.id === v.id); if (i >= 0) list[i] = v; else list.push(v); save(); },
    remove(id) { if (list.length <= 1) return false; list = list.filter(v => v.id !== id); if (activeId === id) activeId = list[0].id; save(); return true; },
    blank,
    // dimensions used by the routing rules
    dims: v => ({ height: +v.height || 0, width: +v.width || 0, length: +v.length || 0, mass: +(v.gcm || v.gvm) || 0 })
  };

  // Main Roads: a vehicle over 2.5 m wide, 4.3 m high, 12.5 m (rigid) / 19 m (combination) long or 42.5 t is a
  // Restricted Access Vehicle and needs a permit or an order (notice).
  api.permit = function (v) {
    const L = C.limits, d = api.dims(v), net = RR.net(v.net), k = net.key;
    const over = [];
    if (d.width > L.width) over.push(`${d.width} m wide (limit ${L.width} m)`);
    if (d.height > L.height) over.push(`${d.height} m high (limit ${L.height} m)`);
    const lenLimit = v.type === 'rigid' ? L.rigid : L.combination;
    const oversize = d.width > L.width || d.height > L.height;
    const r = { level: 'none', title: '', items: [], basis: 'confirmed' };
    if (k === 'GEN' || k === 'OSL') {
      if (d.length > lenLimit) over.push(`${d.length} m long (limit ${lenLimit} m${v.type === 'rigid' ? ' for a rigid truck' : ''})`);
      if (d.mass > L.mass) over.push(`${d.mass} t (limit ${L.mass} t)`);
      if (!over.length) { r.title = 'No permit needed'; r.items.push(`Within general access limits: ${L.width} m wide, ${L.height} m high, ${lenLimit} m long, ${L.mass} t.`); }
      else {
        r.level = 'permit'; r.basis = 'permit'; r.title = oversize || k === 'OSL' ? 'Oversize permit required' : 'Permit required';
        r.items.push('Over: ' + over.join(', ') + '.');
        r.items.push(k === 'OSL' || oversize ? 'Usually a Class 1 RAV Oversize Period Permit, or a Single Trip permit that sets your route.' : 'Pick the RAV network your vehicle runs under in its profile.');
      }
    } else {
      if (/^TD/.test(k)) { r.level = 'order'; r.basis = 'order'; r.title = 'Main Roads order applies'; r.items.push(`A standard ${net.short} combination runs under the Main Roads Tandem Drive order and its operating conditions (no individual permit), on ${net.short} roads only.`); }
      if (/^TRI/.test(k)) { r.level = 'permit'; r.basis = 'permit'; r.title = 'Permit required'; r.items.push('Tri drive combinations run under a Tri Drive Period Permit from Main Roads.'); }
      if (k === 'OSBD27') { r.level = 'permit'; r.basis = 'permit'; r.title = 'Permit required'; r.items.push('Runs under an Oversize Road Train and B-Double Period Permit.'); }
      if (k === 'PLAT') { r.level = 'permit'; r.basis = 'permit'; r.title = 'Permit required'; r.items.push('Runs under a Platform Trailer Relocation Period Permit.'); }
      if (net.maxLen && d.length > net.maxLen) { r.level = 'permit'; r.basis = 'permit'; r.title = 'Permit required'; r.items.push(`${d.length} m is longer than ${net.short} allows (${net.maxLen} m): it needs a higher network or a specific permit.`); }
      if (oversize && (k === 'OSBD27' || k === 'PLAT')) r.items.push('Over-width and over-height loads must stay within the limits in that permit.');
      else if (oversize) { r.level = 'permit'; r.basis = 'permit'; r.title = /^TD/.test(k) ? 'Oversize permit required' : 'Permit required'; r.items.push('Load is over: ' + over.join(', ') + '. That needs an oversize permit on top of the ' + (/^TD/.test(k) ? 'order.' : 'vehicle permit.')); }
      if (d.mass) r.items.push(`RAV mass limits depend on the category and axle groups in your ${/^TD/.test(k) ? 'order' : 'permit'}, not the ${L.mass} t general limit.`);
    }
    if (d.width > 8.5 || d.length > 50) r.items.push('Over 8.5 m wide or 50 m long: an Oversize Overmass Transport Management Plan is required.');
    if (d.height > L.height) r.items.push(d.height <= 4.6 ? 'Over 4.3 m high: allowed up to 4.6 m on Tandem Drive Network 2 roads without overhead cable owners\' written confirmation; elsewhere you need it.' : 'Over 4.3 m high: written clearance confirmation from every overhead cable owner on the route is required.');
    if (v.dg) r.items.push('Placarded dangerous goods: the Northbridge Tunnel is off limits and is avoided.');
    return r;
  };
  return api;
})();
