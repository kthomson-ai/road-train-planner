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
  return { ...ls, cacheGet, cachePut, cached };
})();
