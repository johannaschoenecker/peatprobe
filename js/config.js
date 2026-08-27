// PeatProbe configuration.
// Everything you are likely to change lives in this file.

export const APP = {
  name: 'PeatProbe',
  // Bump when the pack format changes so downloaded packs are flagged stale.
  // v2: tile cache keys are namespaced by layer, and packs may carry CORINE.
  packVersion: 2,
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
  maxZoom: 16,        // detail you can actually navigate by on foot
  bufferKm: 2,        // people park outside the perimeter and walk in
  // Real EFFIS 25/26 distribution: median fire ~260 tiles (~5 MB), 90th
  // percentile ~355. Only the largest (West Moray, 9,809 ha) approaches the
  // cap at ~8,100 tiles / ~140 MB - big, but it is exactly the kind of fire
  // this project exists for, so it stays downloadable behind a confirmation.
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
  corineAvailable: false,
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
export const FIREBASE = {
  enabled: false,
  config: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  },
};
