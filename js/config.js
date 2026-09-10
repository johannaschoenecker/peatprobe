// PeatProbe configuration.
// Everything you are likely to change lives in this file.

export const APP = {
  name: 'PeatProbe',
  // Bump when the pack format changes so downloaded packs are flagged stale.
  // v2: tile cache keys namespaced by layer; packs may carry CORINE.
  // v3: packs carry the dNBR overlay and the land cover x severity stats.
  // v4: packs carry the 100 m sampling grid.
  packVersion: 4,
};

// ---------------------------------------------------------------------------
// BASEMAP
// ---------------------------------------------------------------------------
// MapTiler is the active provider: unlike the public OSM tile service, its
// terms permit the offline caching that field packs depend on.
//
// Format note: .webp measured at 18.5 kB/tile over peat terrain against
// 48.6 kB for .png - a 2.6x saving that decides whether the largest fire is a
// 146 MB download or a 383 MB one. Keep webp unless you hit a device that
// cannot decode it.
//
// SECURITY: this key ships inside client-side JavaScript and is visible to
// anyone who opens the page. That is unavoidable for a web map - the control
// is the origin whitelist at MapTiler's end, not secrecy.
//
// MapTiler Cloud > Keys > (your key) > Edit > "Allowed HTTP origins".
// Bare hostnames, one per line, no protocol and no path:
//
//     localhost
//     YOUR-USERNAME.github.io
//
// Anything not listed is rejected AND not billed to you. Until this is set,
// treat the key as spendable by anyone who views source.
//
// QUOTA: building a pack spends one tile request per tile, in a burst. The
// median fire is ~260 requests, the largest ~8,100. Check your plan's monthly
// allowance before opening the link to volunteers.
export const BASEMAPS = {
  active: 'maptiler',
  maptiler: {
    label: 'MapTiler Topo',
    url: 'https://api.maptiler.com/maps/topo-v4/{z}/{x}/{y}.webp?key=VlIcRVNyPsyt1ufADwbn',
    attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 20,
  },
  // Kept as a fallback for local development only. Their usage policy
  // prohibits bulk downloading, so do not ship packs built from this.
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
};

// Satellite is online-only: too heavy to package, and useful mainly for
// planning rather than for standing in a burn scar.
export const SATELLITE = {
  label: 'Satellite (online only)',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery &copy; Esri',
  maxZoom: 18,
};

// ---------------------------------------------------------------------------
// FIELD PACKS
// ---------------------------------------------------------------------------
export const PACK = {
  minZoom: 10,        // shared, coarse context tiles
  // z15 rather than z16: each zoom level quadruples the tile count, so the
  // deepest level alone was ~3/4 of every pack. Dropping it cuts tile spend
  // (and pack size) roughly 4x, at ~4 m/px ground detail instead of ~2 m/px -
  // still comfortably navigable on foot, and the sampling-grid nodes carry
  // the precise positions anyway. This is what blew the MapTiler free tier
  // in Sep 2026.
  maxZoom: 15,
  bufferKm: 2,        // people park outside the perimeter and walk in
  // Post-cut distribution: median fire ~68 tiles (~1.3 MB), largest
  // (West Moray) ~2,100 tiles (~37 MB).
  maxTiles: 10000,    // refuse to start a download bigger than this
  warnTiles: 1200,    // ask for confirmation above this
  concurrency: 4,     // parallel tile fetches
};

// ---------------------------------------------------------------------------
// DATA QUALITY
// ---------------------------------------------------------------------------
export const QUALITY = {
  maxAccuracyM: 30,       // warn above this; do not block, tree cover is real
  maxDepthCm: 500,
  photoMaxEdgePx: 1400,
  photoQuality: 0.8,
  photoMaxBytes: 2_000_000,
};

// ---------------------------------------------------------------------------
// LAYERS
// ---------------------------------------------------------------------------
export const LAYERS = {
  fireIndex: 'data/fires-index.geojson',

  // CORINE Land Cover 2018, exported from Earth Engine and tiled locally:
  //   1. tools/gee_corine.js       -> GeoTIFF to Drive
  //   2. tools/build_corine_tiles.sh -> data/corine/{z}/{x}/{y}.png
  // Flip corineAvailable once the tiles exist. Until then the app simply
  // omits the layer rather than showing a broken one.
  corineTiles: 'data/corine/{z}/{x}/{y}.png',
  corineAvailable: true,
  // Must match MAX_Z in tools/build_corine_tiles.sh. At z11 a pixel is ~44 m,
  // already finer than the 100 m source; Leaflet upscales beyond this rather
  // than requesting tiles that were never generated.
  corineMaxZoom: 11,
};

// ---------------------------------------------------------------------------
// FIREBASE  (optional)
// ---------------------------------------------------------------------------
// Leave `enabled: false` to run the app entirely on-device. Everything works;
// nothing leaves the phone until you turn this on. Fill in the config from
// Firebase console > Project settings > Your apps > Web app.
// These values are identifiers, not secrets - they are safe in a public repo.
// All access control lives in firestore.rules / storage.rules.
export const FIREBASE = {
  enabled: true,
  config: {
    apiKey: 'AIzaSyDk7FyDu2CY-L-QpkYZTuit3TuuAS1v1YI',
    authDomain: 'peatprobe-bfe85.firebaseapp.com',
    projectId: 'peatprobe-bfe85',
    storageBucket: 'peatprobe-bfe85.firebasestorage.app',
    messagingSenderId: '673291971922',
    appId: '1:673291971922:web:1d5e974a99db04698c9e8b',
  },
};
