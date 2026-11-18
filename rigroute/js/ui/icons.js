// Icon set (stroke icons, 24px grid) and a tiny event bus.
RR.ICONS = {
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
  route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M7 8h5"/><path d="M15 9h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8l-3-3"/>',
  truck: '<path d="M2 6h11v10H2zM13 9h4.5L21 12.5V16h-8"/><circle cx="6" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  locate: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  water: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  fire: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 2 1.5 3 2.5 3-1-3 0-5.5 0-8Z"/>',
  cone: '<path d="M9.5 4h5l4.5 16H5L9.5 4Z"/><path d="M7.5 11h9M6.3 15.5h11.4M3 20h18"/>',
  bridge: '<path d="M2 9h20M4 9v10M20 9v10M4 14c3-4 13-4 16 0"/>',
  height: '<path d="M12 3v18M8 6l4-3 4 3M8 18l4 3 4-3M3 3h4M3 21h4"/>',
  weight: '<path d="M6 8h12l2 12H4L6 8Z"/><circle cx="12" cy="5" r="2"/>',
  wide: '<path d="M3 12h18M6 8l-4 4 4 4M18 8l4 4-4 4"/>',
  rest: '<path d="M4 18V9a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9M4 14h16M7 18v2M17 18v2"/>',
  parking: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
  food: '<path d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 2-2 6 0 8v10"/>',
  wrench: '<path d="M14.5 6a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 0-2-2Z"/>',
  shower: '<path d="M5 21V8a4 4 0 0 1 8 0M9 8h8M10 12v.01M13 12v.01M16 12v.01M11 15v.01M14 15v.01M17 15v.01"/>',
  wash: '<path d="M3 15h18l-2-6H5l-2 6ZM6 19v-4M18 19v-4M8 5c0 1 1 1 1 2M12 4c0 1 1 1 1 2M16 5c0 1 1 1 1 2"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7ZM8 21h8"/>',
  road: '<path d="M8 3 4 21M16 3l4 18M12 4v3M12 11v3M12 18v2"/>',
  play: '<path d="M7 4v16l13-8L7 4Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  check: '<path d="m5 12 4 4 10-10"/>'
};
RR.icon = (n, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${RR.ICONS[n] || ''}</svg>`;
RR.paintIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach(el => { if (!el.firstElementChild || el.dataset.painted !== el.dataset.icon) { el.innerHTML = RR.icon(el.dataset.icon); el.dataset.painted = el.dataset.icon; } });
(() => { const h = {}; RR.on = (e, f) => (h[e] = h[e] || []).push(f); RR.emit = (e, d) => (h[e] || []).forEach(f => { try { f(d); } catch (err) { console.error(err); } }); })();
