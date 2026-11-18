// Small persistence layer: localStorage for settings/profiles, IndexedDB for big cached datasets.
RR.store = (() => {
  const ls = {
    get(k, d) { try { const v = localStorage.getItem('rr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('rr.' + k, JSON.stringify(v)); } catch { } }
  };
  function db() { return new Promise((res, rej) => { try { const r = indexedDB.open('rigroute', 1); r.onupgradeneeded = () => r.result.createObjectStore('cache'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } }); }
  async function cacheGet(k) { try { const d = await db(); return await new Promise(res => { const q = d.transaction('cache').objectStore('cache').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch { return null; } }
  async function cachePut(k, v) { try { const d = await db(); d.transaction('cache', 'readwrite').objectStore('cache').put(v, k); } catch { } }
  // cached(key, maxAgeMs, loader)
  async function cached(key, maxAge, loader, force) {
    const c = !force && await cacheGet(key);
    if (c && Date.now() - c.t < maxAge) return c.v;
    const v = await loader(); cachePut(key, { t: Date.now(), v }); return v;
  }
  // fresh(): serve the saved copy straight away; at most every `checkEvery` ask the source for a tiny
  // signature (record counts / last-edit dates) and only re-download when it has changed.
  const busy = new Set();
  async function fresh(key, { sig, loader, checkEvery = 20 * 3600e3, maxAge = 30 * 864e5, force }) {
    const c = !force && await cacheGet(key);
    if (c && c.v && Date.now() - c.t < maxAge) {
      if (Date.now() - (c.checked || c.t) > checkEvery) setTimeout(() => revalidate(key, c, sig, loader), 4000);
      return c.v;
    }
    const s = await sig().catch(() => null);
    const v = await loader(); const now = Date.now();
    await cachePut(key, { t: now, checked: now, sig: s, v }); return v;
  }
  async function revalidate(key, c, sig, loader) {
    if (busy.has(key)) return; busy.add(key);
    try {
      const s = await sig();
      if (s && c.sig && s === c.sig) { c.checked = Date.now(); c.failed = 0; await cachePut(key, c); RR.emit && RR.emit('datachecked', { key, changed: false }); }
      else {
        const conn = navigator.connection || {};
        if (conn.saveData) { RR.emit && RR.emit('datachecked', { key, changed: true, deferred: true }); return; }
        const v = await loader(); const now = Date.now();
        await cachePut(key, { t: now, checked: now, sig: s, v }); RR.emit && RR.emit('dataupdated', { key });
      }
    } catch { c.failed = Date.now(); await cachePut(key, c); RR.emit && RR.emit('dataoffline', { key }); }
    finally { busy.delete(key); }
  }
  async function info(key) { const c = await cacheGet(key); return c ? { t: c.t, checked: c.checked || c.t, failed: c.failed || 0 } : null; }
  return { ...ls, cacheGet, cachePut, cached, fresh, info };
})();
