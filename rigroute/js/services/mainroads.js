// Main Roads WA open data: RAV networks, low structures, facilities, live alerts.
RR.mainroads = (() => {
  const C = RR.config, E = C.endpoints, DAY = 864e5;
  const ROADF = 'ROAD,ROAD_NAME,NETWORK_TYPE,CONDITION,COMMENTS,CURFEW,MAX_SPEED';
  // bus lanes, paths and car parks are in the road data but aren't for trucks
  const truckRoad = f => !/bus\s*lane|busway|bus only|bus bridge|\bpsp\b|shared path|cycle|bike|footpath|pedestrian|walkway|car\s*park|carpark/i.test((f.properties && f.properties.ROAD_NAME) || '');

  async function fetchLayer(base, id, fields, { where = '1=1', extra = '', onPage } = {}) {
    let out = [], off = 0;
    for (let page = 0; page < 80; page++) {
      const url = `${base}${id}/query?where=${encodeURIComponent(where)}&outFields=${fields}&outSR=4326&geometryPrecision=6&f=geojson&resultOffset=${off}&resultRecordCount=2000${extra}`;
      const r = await fetch(url); if (!r.ok) throw new Error('Main Roads server returned ' + r.status);
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'Main Roads query error');
      out = out.concat(j.features || []); onPage && onPage(out.length);
      const more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
      if (!more || !(j.features || []).length) break; off += 2000;
    }
    return out;
  }
  // tiny change signature for a set of layers: record count + last edit date (where the server publishes it)
  async function layerSig(base, ids) {
    const parts = await Promise.all(ids.map(async id => {
      const [cnt, meta] = await Promise.all([
        fetch(`${base}${id}/query?where=1%3D1&returnCountOnly=true&f=json`).then(r => r.json()),
        fetch(`${base}${id}?f=json`).then(r => r.json()).catch(() => ({}))
      ]);
      if (cnt.error) throw new Error('sig');
      return `${id}:${cnt.count}:${(meta.editingInfo && (meta.editingInfo.lastEditDate || meta.editingInfo.dataLastEditDate)) || ''}`;
    }));
    return parts.join('|');
  }
  const netIds = n => n.general ? [[E.assets, [16]], [E.hvs, [31, 32]]] : [[E.hvs, [n.g + 1, n.g + 2, n.g + 3, n.g + 4]]];
  const netSig = n => Promise.all(netIds(n).map(([b, ids]) => layerSig(b, ids))).then(x => x.join('#'));
  const envelope = (p, km) => { const d = km / 111, dx = km / (111 * Math.cos(p[1] * Math.PI / 180)); return `&geometry=${encodeURIComponent([p[0] - dx, p[1] - d, p[0] + dx, p[1] + d].join(','))}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`; };

  // ---- networks ----
  async function network(key, { force, onStatus } = {}) {
    const n = RR.net(key);
    return RR.store.fresh('net2-' + key, { force, sig: () => netSig(n), loader: async () => {
      if (n.general) {
        const lines = (await fetchLayer(E.assets, 16, 'ROAD,ROAD_NAME,NETWORK_TYPE,ROAD_HIERARCHY', { where: "ROAD_HIERARCHY <> 'Access Road'", onPage: c => onStatus && onStatus(`Downloading main roads… ${c}`) })).filter(truckRoad);
        lines.forEach(x => x.properties._cond = false);
        onStatus && onStatus('Downloading Network 1 prohibited roads…');
        const prohibited = (await fetchLayer(E.hvs, 31, ROADF).catch(() => [])).concat(await fetchLayer(E.hvs, 32, ROADF).catch(() => []));
        return { lines, ints: [], br: [], prohibited, general: true };
      }
      const lines = [];
      for (const [i, id] of [n.g + 3, n.g + 4].entries()) {
        const f = await fetchLayer(E.hvs, id, ROADF, { onPage: c => onStatus && onStatus(`Downloading ${n.short}… ${lines.length + c} road sections`) });
        f.forEach(x => x.properties._cond = i === 0); lines.push(...f);
      }
      onStatus && onStatus('Downloading turn restrictions and bridges…');
      const ints = await fetchLayer(E.hvs, n.g + 2, 'NODE_DESCR,CONDITION').catch(() => []);
      const br = await fetchLayer(E.hvs, n.g + 1, '*').catch(() => []);
      return { lines, ints, br, prohibited: [] };
    } });
  }
  // local streets around a point (full road network, adaptive radius) for general-access routing
  const LOCAL = new Map();
  async function localRoads(p) {
    const k = p[0].toFixed(3) + ',' + p[1].toFixed(3); if (LOCAL.has(k)) return LOCAL.get(k);
    let feats = [];
    for (const km of [6, 3, 1.5]) {
      const env = envelope(p, km);
      const cnt = await fetch(`${E.assets}17/query?where=1%3D1&returnCountOnly=true&f=json${env}`).then(r => r.json()).then(j => j.count || 0).catch(() => 0);
      if (cnt <= 7000 || km === 1.5) { feats = (await fetchLayer(E.assets, 17, 'ROAD,ROAD_NAME,NETWORK_TYPE', { extra: env }).catch(() => [])).filter(truckRoad); break; }
    }
    feats.forEach(f => { f.properties._cond = false; f.properties.ROAD_HIERARCHY = 'Access Road'; });
    LOCAL.set(k, feats); return feats;
  }

  // ---- low overpasses / rail bridges ----
  async function structures() {
    const f = await RR.store.fresh('structs1', { sig: () => layerSig(E.hvs, [781]), loader: () => fetchLayer(E.hvs, 781, 'ROAD_NAME,MAXIMUM_LOAD_HEIGHT,STR_DESCR,SUBURB,CROSSING_NAME') }).catch(() => []);
    return f.filter(x => x.geometry).map(x => ({ at: x.geometry.coordinates, road: x.properties.ROAD_NAME || '', maxH: +x.properties.MAXIMUM_LOAD_HEIGHT || 0, descr: x.properties.STR_DESCR || 'Structure', suburb: x.properties.SUBURB || '', crossing: x.properties.CROSSING_NAME || '' }));
  }

  // ---- facilities: assembly areas, rest areas, roadhouses ----
  async function facilities() {
    const layers = [[0, 'rtaa'], [1, 'hvrest'], [2, 'rest'], [3, 'rest'], [4, 'roadhouse']];
    const all = [];
    for (const [id, kind] of layers) {
      const f = await RR.store.fresh('fac1-' + id, { sig: () => layerSig(E.hvs, [id]), loader: () => fetchLayer(E.hvs, id, '*') }).catch(() => []);
      for (const x of f) {
        if (!x.geometry) continue; const p = x.properties || {};
        const yes = v => v && /^(y|yes|true|1)$/i.test(String(v));
        const name = (p.IIT_DESC || p.COMMON_USAGE_NAME || p.ROAD_NAME || 'Facility').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/Road Train Assembly Area/i, 'Road Train Assembly Area');
        const tags = [];
        if (kind === 'rtaa') tags.push('parking');
        if (kind === 'hvrest') tags.push('parking', 'rest');
        if (kind === 'rest') tags.push('rest');
        if (kind === 'roadhouse') tags.push('roadhouse', 'food', 'diesel');
        if (yes(p.TOILET)) tags.push('toilets'); if (yes(p.WATER)) tags.push('water'); if (yes(p.SHELTER)) tags.push('shelter'); if (yes(p.BBQ)) tags.push('bbq'); if (yes(p.BIN)) tags.push('bins');
        all.push({ id: kind + (p.OBJECTID || all.length), kind, name, road: p.ROAD_NAME || '', at: x.geometry.coordinates, tags, signal: p.PHONE_SIGNAL || '', source: 'Main Roads WA' });
      }
    }
    return all;
  }

  // ---- live alerts (Main Roads Travel Map data) ----
  async function liveAlerts() {
    const svc = [['WebEoc_RoadClosures', 4, 'closure'], ['WebEoc_RoadIncidents', 1, 'incident'], ['WebEoc_Roadworks', 2, 'roadworks'], ['WebEoc_Events', 0, 'event']];
    const out = [];
    await Promise.all(svc.map(async ([s, id, src]) => {
      const f = await fetchLayer(`${E.webeoc}${s}/FeatureServer/`, id, '*').catch(() => []);
      for (const x of f) {
        const p = x.properties || {}; if (!x.geometry) continue;
        const type = (p.IncidentTy || p.IncidentType || p.EventType || (src === 'roadworks' ? 'Roadworks' : src)).toString();
        const status = (p.ClosureTyp || p.ClosureType || p.TrafficImp || '').toString();
        out.push({ id: src + (p.Id || p.FID), src, type, status, title: (p.Location || p.Road || type).toString().trim(), road: p.Road || p.LocalRoadName || '', impact: (p.TrafficImp || '').toString(), region: p.Region || '', updated: p.UpdateDate || p.EntryDate || '', url: p.SeeMoreUrl || '', geom: x.geometry, source: 'Main Roads WA (live)' });
      }
    }));
    return out;
  }
  return { fetchLayer, network, localRoads, structures, facilities, liveAlerts, truckRoad };
})();
