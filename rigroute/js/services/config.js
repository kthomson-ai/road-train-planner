// RigRoute configuration: endpoints, vehicle catalogue, rule zones.
window.RR = window.RR || {};
RR.config = (() => {
  const MR = 'https://gisservices.mainroads.wa.gov.au/arcgis/rest/services/OpenData/';
  return {
    version: '1.0',
    endpoints: {
      hvs: MR + 'HVS_Networks_DataPortal/MapServer/',
      assets: MR + 'RoadAssets_DataPortal/MapServer/',
      webeoc: 'https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/',
      nominatim: 'https://nominatim.openstreetmap.org/search'
    },
    // Google Maps Platform demo key, restricted to kthomson-ai.github.io
    // shared driver reports + tester feedback (Supabase; public key, protected by row level security)
    reports: { mode: 'remote', endpoint: 'https://xybywnjskowqaxlbrfya.supabase.co/rest/v1', key: 'sb_publishable_uGKkcwYOZHcgKP2VZBptKg_xmNXwFwR' },
    appVersion: '0.9 field test',
    googleKey: 'AIzaSyBVhkli3WgpzPo3JtEOVtvlOBGC-58daU4',
    cacheDays: 7,
    WA: { west: 112, south: -35.3, east: 129.2, north: -13.5 },
    // Main Roads HVS layer groups: group id g -> bridges g+1, intersections g+2, lines g+3 (with conditions) / g+4
    networks: [
      { key: 'GEN', label: 'General access (Network 1)', short: 'General access', group: 'General access', maxLen: 19, general: true },
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({ key: 'TD' + n, label: 'Tandem Drive Network ' + n, short: 'Network ' + n, group: 'Tandem drive RAV', g: 28 + 5 * (n - 1), maxLen: { 2: 25, 3: 27.5, 4: 27.5, 5: 27.5, 6: 36.5, 7: 36.5, 8: 36.5, 9: 53.5, 10: 53.5 }[n] })),
      ...[1, 2, 3, 4, 5].map(n => ({ key: 'TRI' + n, label: 'Tri Drive Network ' + n, short: 'Tri Drive ' + n, group: 'Tri drive RAV', g: 216 + 5 * (n - 1), maxLen: { 1: 27.5, 2: 36.5, 3: 36.5, 4: 53.5, 5: 53.5 }[n] })),
      { key: 'OSL', label: 'Oversize load (any truck)', short: 'Oversize', group: 'Oversize', maxLen: 0, general: true },
      { key: 'OSBD27', label: '27.5 m Oversize B-double network', short: 'Oversize B-double', group: 'Oversize', g: 687, maxLen: 27.5 },
      { key: 'PLAT', label: 'Platform trailer relocation network', short: 'Platform trailer', group: 'Oversize', g: 770, maxLen: 25 }
    ],
    // vehicle type presets (dimensions are starting points; the driver confirms them)
    vehicleTypes: [
      { key: 'rigid', label: 'Rigid truck', net: 'GEN', h: 4.3, w: 2.5, l: 12.5, axles: 3, trailer: 'None' },
      { key: 'semi', label: 'Semi-trailer', net: 'GEN', h: 4.3, w: 2.5, l: 19, axles: 6, trailer: 'Tri-axle semi' },
      { key: 'bdouble', label: 'B-double', net: 'TD3', h: 4.3, w: 2.5, l: 26, axles: 9, trailer: 'B-double (lead + rear)' },
      { key: 'adouble', label: 'A-double', net: 'TD7', h: 4.3, w: 2.5, l: 36.5, axles: 11, trailer: 'Semi + dolly + semi' },
      { key: 'roadtrain', label: 'Road train (double)', net: 'TD7', h: 4.3, w: 2.5, l: 36.5, axles: 11, trailer: 'Double road train' },
      { key: 'triple', label: 'Road train (triple)', net: 'TD10', h: 4.3, w: 2.5, l: 53.5, axles: 15, trailer: 'Triple road train' },
      { key: 'oversize', label: 'Oversize combination', net: 'OSL', h: 4.8, w: 4.0, l: 25, axles: 7, trailer: 'Low loader / float' }
    ],
    // Perth and Fremantle Central Zones, traced from the Main Roads permit appendix maps (approximate)
    zones: [
      { name: 'Perth Central Zone', poly: [[115.81821,-31.96467],[115.84194,-31.94334],[115.84576,-31.93927],[115.86898,-31.94984],[115.86779,-31.95299],[115.87743,-31.95448],[115.87461,-31.96072],[115.87386,-31.96238],[115.86458,-31.95935],[115.86409,-31.96054],[115.85839,-31.95864],[115.85585,-31.9561],[115.85349,-31.95541],[115.85007,-31.95505],[115.84791,-31.95587],[115.84655,-31.95769],[115.84608,-31.95987],[115.8462,-31.96087],[115.8425,-31.9638],[115.8385,-31.9662],[115.834,-31.9695],[115.83,-31.9735],[115.8262,-31.9765],[115.8222,-31.9787],[115.8185,-31.979],[115.81782,-31.97303],[115.81777,-31.96691]] },
      { name: 'Fremantle Central Zone', poly: [[115.74331,-32.0576],[115.74214,-32.05503],[115.74591,-32.05232],[115.74862,-32.04937],[115.752,-32.0466],[115.75369,-32.04504],[115.7556,-32.0437],[115.7581,-32.04414],[115.7582,-32.05083],[115.756,-32.0526],[115.75698,-32.06357],[115.75039,-32.06365],[115.747,-32.0605]] }
    ],
    // Northbridge (Graham Farmer Freeway) tunnel: no placarded dangerous goods (WorkSafe WA)
    dgTunnel: { name: 'Northbridge Tunnel', road: /graham farmer/i, box: [115.850, -31.952, 115.877, -31.940] },
    metro: p => p[1] < -31.45 && p[1] > -32.6 && p[0] > 115.55 && p[0] < 116.3,
    limits: { width: 2.5, height: 4.3, rigid: 12.5, combination: 19, mass: 42.5 }
  };
})();
RR.net = key => RR.config.networks.find(n => n.key === key) || RR.config.networks[0];
