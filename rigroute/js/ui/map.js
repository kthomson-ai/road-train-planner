// Map rendering (Leaflet): dark basemap, approved network, routes, alerts, facilities, waypoints.
RR.map = (() => {
  let map, base = {}, baseKey = 'dark';
  const L_ = {};
  const tone = { red: '#F04444', amber: '#FFB020', blue: '#36A5F5', lime: '#B7F23D', grey: '#9AA6B2' };
  function init() {
    map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([-26.5, 121.5], 5);
    base.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap contributors © CARTO' }).addTo(map);
    ['net', 'zones', 'routes', 'alerts', 'facilities', 'wps', 'me'].forEach(k => L_[k] = L.layerGroup().addTo(map));
    L_.renderer = L.canvas({ padding: 0.4 });
    map.on('zoomend', () => RR.emit('zoom', map.getZoom()));
    return map;
  }
  function addGoogle() {
    if (!L.gridLayer || !L.gridLayer.googleMutant || !window.google) return false;
    base.google = L.gridLayer.googleMutant({ type: 'roadmap', maxZoom: 20, styles: DARK_STYLE });
    base.sat = L.gridLayer.googleMutant({ type: 'hybrid', maxZoom: 20 });
    return true;
  }
  const DARK_STYLE = [{ elementType: 'geometry', stylers: [{ color: '#151b21' }] }, { elementType: 'labels.text.fill', stylers: [{ color: '#9aa6b2' }] }, { elementType: 'labels.text.stroke', stylers: [{ color: '#101418' }] }, { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a333d' }] }, { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3b4652' }] }, { featureType: 'water', stylers: [{ color: '#0b1a26' }] }, { featureType: 'poi', stylers: [{ visibility: 'off' }] }, { featureType: 'transit', stylers: [{ visibility: 'off' }] }];
  function cycleBase() {
    const order = ['dark', ...(base.google ? ['google', 'sat'] : [])];
    const next = order[(order.indexOf(baseKey) + 1) % order.length];
    map.removeLayer(base[baseKey]); base[next].addTo(map); base[next].bringToBack && base[next].bringToBack(); baseKey = next;
    return { dark: 'Dark map', google: 'Google map (dark)', sat: 'Satellite' }[next];
  }
  // ---- approved network ----
  function drawNetwork(data, show) {
    L_.net.clearLayers(); if (!show || !data) return;
    const style = f => f.properties._cond ? { color: '#FFB020', weight: 2, opacity: 0.45 } : { color: '#B7F23D', weight: 2, opacity: data.general ? 0.16 : 0.32 };
    L.geoJSON({ type: 'FeatureCollection', features: data.lines }, { renderer: L_.renderer, interactive: false, style }).addTo(L_.net);
    if (data.prohibited && data.prohibited.length) L.geoJSON({ type: 'FeatureCollection', features: data.prohibited }, { renderer: L_.renderer, interactive: false, style: { color: '#F04444', weight: 3, opacity: 0.8 } }).addTo(L_.net);
  }
  function drawZones(zones) { L_.zones.clearLayers(); zones.forEach(z => L.polygon(z.poly.map(p => [p[1], p[0]]), { color: '#F04444', weight: 1.5, dashArray: '5 6', fillColor: '#F04444', fillOpacity: 0.07 }).addTo(L_.zones).bindTooltip(z.name + ' (approximate)')); }
  // ---- routes ----
  let routeClick = null;
  function drawRoutes(routes, sel, onSelect) {
    L_.routes.clearLayers(); routeClick = onSelect;
    routes.forEach((r, i) => { if (i === sel) return; const ll = r.line.map(c => [c[1], c[0]]); L.polyline(ll, { color: '#101418', weight: 9, opacity: 0.85 }).addTo(L_.routes); L.polyline(ll, { color: '#36A5F5', weight: 5, opacity: 0.85 }).addTo(L_.routes).on('click', () => routeClick && routeClick(i)).bindTooltip(`${r.label}`, { sticky: true }); });
    const r = routes[sel]; if (!r) return;
    const ll = r.line.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#101418', weight: 11, opacity: 0.95 }).addTo(L_.routes);
    const main = L.polyline(ll, { color: '#B7F23D', weight: 6 }).addTo(L_.routes);
    (r.conf ? r.conf.parts : []).forEach(p => { if (p.cls === 'conditional') L.polyline(p.pts.map(c => [c[1], c[0]]), { color: '#FFB020', weight: 4, dashArray: '2 8', opacity: 0.95 }).addTo(L_.routes); });
    (r.conf ? r.conf.gaps : []).forEach(sn => { const tgt = sn.req; if (!tgt) return; L.polyline([[tgt[1], tgt[0]], [sn.pt[1], sn.pt[0]]], { color: '#F04444', weight: 4, dashArray: '6 8' }).addTo(L_.routes).bindTooltip('Off the approved network: not verified for this vehicle'); });
    return main.getBounds();
  }
  const clearRoutes = () => L_.routes.clearLayers();
  // ---- markers ----
  const dotIcon = (t, icon, size = 30) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#101418;border:2px solid ${tone[t] || t};color:${tone[t] || t};display:grid;place-items:center;box-shadow:0 2px 8px rgba(0,0,0,.6)">${RR.icon(icon, 'i').replace('class="i"', `style="width:${size * 0.55}px;height:${size * 0.55}px"`)}</div>` });
  function setAlerts(list, onClick) {
    L_.alerts.clearLayers();
    list.forEach(a => { const cat = RR.alerts.CATS.find(c => c.key === a.cat) || {}; L.marker([a.at[1], a.at[0]], { icon: dotIcon(a.tone, cat.icon || 'alert', a.cat === 'height' ? 24 : 30), zIndexOffset: a.tone === 'red' ? 500 : 0 }).addTo(L_.alerts).bindTooltip(esc(a.title)).on('click', () => onClick && onClick(a)); });
  }
  function setFacilities(list, onClick) {
    L_.facilities.clearLayers();
    list.forEach(f => L.marker([f.at[1], f.at[0]], { icon: dotIcon('lime', RR.facIcon(f), 26) }).addTo(L_.facilities).bindTooltip(esc(f.name)).on('click', () => onClick && onClick(f)));
  }
  function setWaypoints(pts) { // [{lat,lon,kind,n}]
    L_.wps.clearLayers();
    pts.forEach(p => { const c = p.kind === 'start' ? '#B7F23D' : p.kind === 'end' ? '#F04444' : '#FFB020'; L.marker([p.lat, p.lon], { zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div style="width:26px;height:26px;border-radius:50%;background:${c};border:3px solid #101418;box-shadow:0 0 0 2px ${c}55,0 2px 8px rgba(0,0,0,.6);color:#101418;font:800 11px/20px Inter,sans-serif;text-align:center">${p.n || ''}</div>` }) }).addTo(L_.wps); });
  }
  let meMarker = null;
  function setMe(lat, lon, acc) {
    if (!meMarker) meMarker = L.marker([lat, lon], { zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div style="width:22px;height:22px;border-radius:50%;background:#36A5F5;border:4px solid #fff;box-shadow:0 0 0 6px rgba(54,165,245,.25)"></div>' }) }).addTo(L_.me);
    else meMarker.setLatLng([lat, lon]);
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return { init, addGoogle, cycleBase, drawNetwork, drawZones, drawRoutes, clearRoutes, setAlerts, setFacilities, setWaypoints, setMe, get: () => map, layer: k => L_[k] };
})();
