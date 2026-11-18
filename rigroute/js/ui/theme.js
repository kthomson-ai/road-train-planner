// Light / dark theme. 'auto' follows daylight at your location (sunrise/sunset), like a car sat-nav,
// falling back to the phone's own light/dark setting when location isn't known.
RR.theme = (() => {
  let mode = RR.store.get('theme', 'auto'), current = null, where = null;
  const rad = Math.PI / 180;
  // solar elevation (degrees) — NOAA approximation, good to well under a degree
  function sunElevation(lat, lon, d = new Date()) {
    const jd = d.getTime() / 864e5 + 2440587.5, n = jd - 2451545.0;
    const L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 4e-7 * n) * rad;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const ha = ((gmst * 15 + lon) * rad) - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  }
  function resolve() {
    if (mode === 'light' || mode === 'dark') return mode;
    if (where) return sunElevation(where[1], where[0]) > -2 ? 'light' : 'dark'; // switch around civil dusk
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function apply(force) {
    const t = resolve(); if (t === current && !force) return;
    current = t; document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = t === 'light' ? '#F4F6F8' : '#101418';
    RR.emit('theme', t);
  }
  function set(m) { mode = m; RR.store.set('theme', m); apply(); }
  function locate(lon, lat) { where = [lon, lat]; apply(); }
  try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => apply()); } catch { }
  setInterval(apply, 60e3);
  apply(true);
  return { set, mode: () => mode, current: () => current, locate, sunElevation };
})();
