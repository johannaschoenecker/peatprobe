// Map layer. Leaflet setup, offline-first tiles, the fire index, and the
// points layer.

import * as DB from './db.js';
import { BASEMAPS, SATELLITE, LAYERS, PACK } from './config.js';
import { tileKey, pointInGeometry, haversine } from './geo.js';
import { fireName, fireSubtitle, dnbrIndex, dnbrKey } from './packs.js';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const UK_CENTRE = [54.6, -3.4];
const DOT_ZOOM_MAX = 10;   // dots below this zoom, real perimeters at/above

let map, firePolys, fireDots, pointsLayer, gpsMarker, gpsCircle;
let fireIndex = null;          // GeoJSON FeatureCollection
let packStates = new Map();    // fireId -> 'none' | 'ready' | 'stale'
let dotById = new Map();       // fireId -> centroid marker, so it can restyle
let dnbrGroup;                 // burn severity image overlays
let dnbrOverlays = new Map();  // fireId -> L.ImageOverlay
let dnbrMeta;                  // data/dnbr/index.json, or null
let corineLayer;               // kept so the legend can tell if it is showing
let handlers = {};
let placingMode = false;

// ── offline-first tile layer ──────────────────────────────────────────────
const OfflineTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.setAttribute('role', 'presentation');
    tile.alt = '';
    tile.onload = () => done(null, tile);
    tile.onerror = () => done(null, tile); // a missing tile is not an error worth surfacing

    DB.getTile(tileKey(coords.z, coords.x, coords.y, this.options.layerId)).then((blob) => {
      if (blob) {
        tile._ppUrl = URL.createObjectURL(blob);
        tile.src = tile._ppUrl;
      } else if (navigator.onLine) {
        tile.src = this.getTileUrl(coords);
      } else {
        tile.src = BLANK; // offline and not packaged - show nothing, not a broken icon
      }
    }).catch(() => { tile.src = BLANK; });

    return tile;
  },
});

function offlineTiles(cfg, layerId) {
  const layer = new OfflineTileLayer(cfg.url, {
    layerId,
    attribution: cfg.attribution,
    maxZoom: cfg.maxZoom,
    // maxNativeZoom lets Leaflet upscale rather than blank out past the
    // source's real resolution - essential for 100 m CORINE at z16.
    maxNativeZoom: cfg.maxNativeZoom || cfg.maxZoom,
    opacity: cfg.opacity != null ? cfg.opacity : 1,
  });
  layer.on('tileunload', (e) => {
    if (e.tile._ppUrl) { URL.revokeObjectURL(e.tile._ppUrl); e.tile._ppUrl = null; }
  });
  return layer;
}

// ── styling ───────────────────────────────────────────────────────────────
const STYLE = {
  none:  { color: '#7A6A5A', weight: 1.5, fillColor: '#9C8875', fillOpacity: 0.18 },
  ready: { color: '#2C221A', weight: 2.5, fillColor: '#6B4A2F', fillOpacity: 0.42 },
  stale: { color: '#EA580C', weight: 2.5, dashArray: '5,4', fillColor: '#FBBF24', fillOpacity: 0.28 },
};

// Centroid dots carry the same status colour as the perimeters. Below the
// polygon zoom threshold these dots ARE the fire as far as the user is
// concerned, so leaving them a fixed colour made downloaded packs look
// identical to undownloaded ones across most of the country.
const DOT_STYLE = {
  none:  { radius: 7, color: '#3A2E24', weight: 2, fillColor: '#B7A794', fillOpacity: 0.95 },
  ready: { radius: 8, color: '#1F1712', weight: 2.5, fillColor: '#2F7D45', fillOpacity: 1 },
  stale: { radius: 8, color: '#8A5A00', weight: 2.5, fillColor: '#FBBF24', fillOpacity: 1 },
};

const stateOf = (id) => packStates.get(id) || 'none';
const styleFor = (f) => STYLE[stateOf(f.properties.id)];

// ── init ──────────────────────────────────────────────────────────────────
export async function initMap(opts) {
  handlers = opts;

  map = L.map('map', {
    center: UK_CENTRE, zoom: 6, zoomControl: false,
    preferCanvas: true, tap: true,
    // ONE shared canvas renderer for every vector layer. Giving the fire
    // polygons their own L.canvas() put a second canvas in the overlay pane,
    // and stacked canvases do not pass clicks through to each other - the top
    // one swallowed every click aimed at a perimeter.
    renderer: L.canvas({ padding: 0.3 }),
    // Default attribution sits bottom-right, directly under the Record
    // button. Everything informational goes bottom-left instead.
    attributionControl: false,
  });
  L.control.zoom({ position: 'topleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  L.control.attribution({ position: 'bottomleft', prefix: '' }).addTo(map);

  const base = offlineTiles(BASEMAPS[BASEMAPS.active], 'base').addTo(map);
  const sat = offlineTiles(SATELLITE, 'sat');

  firePolys = L.geoJSON(null, {
    style: styleFor,
    onEachFeature: (f, layer) => {
      layer.on('click', () => openFirePopup(f));
      // Name on hover, so you can tell perimeters apart without opening each.
      layer.bindTooltip(() => fireName(f.properties), { sticky: true, direction: 'top' });
    },
  }).addTo(map);

  fireDots = L.markerClusterGroup({
    maxClusterRadius: 45, showCoverageOnHover: false, chunkedLoading: true,
  });

  pointsLayer = L.markerClusterGroup({
    maxClusterRadius: 40, showCoverageOnHover: false, chunkedLoading: true,
  }).addTo(map);

  dnbrGroup = L.layerGroup();

  const overlays = {
    'Fire perimeters': firePolys,
    'Measurements': pointsLayer,
    'Burn severity (dNBR)': dnbrGroup,
  };
  if (LAYERS.corineAvailable) {
    overlays['Land cover (CORINE)'] = corineLayer = offlineTiles({
      url: LAYERS.corineTiles,
      attribution: 'CORINE &copy; Copernicus/EEA',
      maxZoom: BASEMAPS[BASEMAPS.active].maxZoom,
      maxNativeZoom: LAYERS.corineMaxZoom,
      opacity: 0.6,   // it is context, not the thing you navigate by
    }, 'corine');
  }
  L.control.layers(
    { [BASEMAPS[BASEMAPS.active].label]: base, [SATELLITE.label]: sat },
    overlays,
    { position: 'topright', collapsed: true }
  ).addTo(map);

  map.on('zoomend', syncDotVisibility);
  map.on('moveend zoomend', syncDnbrOverlays);
  map.on('overlayadd overlayremove', (e) => {
    if (e.layer === dnbrGroup) syncDnbrOverlays();
    legend.refresh();
  });
  map.on('click', (e) => {
    if (placingMode) { handlers.onManualPlace && handlers.onManualPlace(e.latlng); }
  });

  legend.addTo(map);

  await loadFireIndex();
  return map;
}

// ── fire index ────────────────────────────────────────────────────────────
async function loadFireIndex() {
  const res = await fetch(LAYERS.fireIndex);
  if (!res.ok) throw new Error(`Could not load the fire index (${res.status})`);
  fireIndex = await res.json();

  // Precompute a representative point for each fire so the "near me" list and
  // the low-zoom dots do not have to walk the geometry every time.
  for (const f of fireIndex.features) {
    f._c = representativePoint(f.geometry);
  }

  firePolys.addData(fireIndex);

  const dots = fireIndex.features.map((f) => {
    const m = L.circleMarker([f._c.lat, f._c.lon], DOT_STYLE.none)
      .on('click', () => openFirePopup(f))
      .bindTooltip(`${fireName(f.properties)} · ${fireSubtitle(f.properties)}`,
                   { direction: 'top', offset: [0, -6] });
    dotById.set(f.properties.id, m);
    return m;
  });
  fireDots.addLayers(dots);
  syncDotVisibility();
  handlers.onIndexLoaded && handlers.onIndexLoaded(fireIndex);
}

function representativePoint(geom) {
  let sx = 0, sy = 0, n = 0;
  const visit = (c) => {
    if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; }
    else c.forEach(visit);
  };
  visit(geom.coordinates);
  return { lat: sy / n, lon: sx / n };
}

function syncDotVisibility() {
  // Below this, most perimeters are a pixel or two across and effectively
  // untappable, so the centroid dots stand in for them. At or above it the
  // real perimeters take over and are clicked directly.
  const showDots = map.getZoom() < DOT_ZOOM_MAX;
  if (showDots && !map.hasLayer(fireDots)) map.addLayer(fireDots);
  if (!showDots && map.hasLayer(fireDots)) map.removeLayer(fireDots);
}

// ── burn severity overlays ────────────────────────────────────────────────
// One ImageOverlay per fire, created lazily for whatever is in view. Only 162
// of the 1,599 fires have severity - the rest were too small or had no
// cloud-free Sentinel-2 pair - so a missing overlay is normal.
const DNBR_MIN_ZOOM = 9;
const DNBR_MAX_OVERLAYS = 60;

async function dnbrSrc(fireId) {
  const blob = await DB.getTile(dnbrKey(fireId));      // packed for offline
  return blob ? URL.createObjectURL(blob)
              : `data/dnbr/${encodeURIComponent(fireId)}.png`;
}

/**
 * Where a fire's severity bounds come from. index.json covers everything while
 * online; downloaded packs carry their own copy, so severity keeps working in
 * the field even if index.json was never cached.
 */
async function dnbrEntries() {
  const out = new Map();
  if (dnbrMeta === undefined) dnbrMeta = await dnbrIndex();
  if (dnbrMeta && dnbrMeta.fires) {
    for (const [id, e] of Object.entries(dnbrMeta.fires)) out.set(id, e);
  }
  for (const p of await DB.allPacks()) {
    if (p.dnbr && !out.has(p.fireId)) out.set(p.fireId, p.dnbr);
  }
  return out;
}

function dropOverlay(id, ov) {
  dnbrGroup.removeLayer(ov);
  if (ov._ppUrl) URL.revokeObjectURL(ov._ppUrl);
  dnbrOverlays.delete(id);
}

async function syncDnbrOverlays() {
  if (!dnbrGroup || !map.hasLayer(dnbrGroup)) return;
  if (map.getZoom() < DNBR_MIN_ZOOM) {
    for (const [id, ov] of [...dnbrOverlays]) dropOverlay(id, ov);
    return;
  }
  const entries = await dnbrEntries();
  if (!entries.size) return;

  const view = map.getBounds();
  const keep = view.pad(1);
  for (const [id, ov] of [...dnbrOverlays]) {
    if (!keep.intersects(ov.getBounds())) dropOverlay(id, ov);
  }

  let budget = DNBR_MAX_OVERLAYS - dnbrOverlays.size;
  for (const [id, e] of entries) {
    if (budget <= 0) break;
    if (dnbrOverlays.has(id)) continue;
    const b = L.latLngBounds(e.bounds);
    if (!view.intersects(b)) continue;
    const src = await dnbrSrc(id);
    const ov = L.imageOverlay(src, b, { opacity: 0.75, interactive: false });
    if (src.startsWith('blob:')) ov._ppUrl = src;
    dnbrOverlays.set(id, ov);
    dnbrGroup.addLayer(ov);
    budget--;
  }
}

// ── legend ────────────────────────────────────────────────────────────────
// CORINE has 44 classes, which is unreadable on a phone. These are the ones
// that matter for peat fire work; everything else falls under "other".
const LEGEND = {
  corine: {
    title: 'Land cover',
    items: [
      ['#4D4DFF', 'Peat bogs'], ['#A6A6FF', 'Inland marshes'],
      ['#A6FF80', 'Moors &amp; heathland'], ['#CCF24D', 'Natural grassland'],
      ['#A6F200', 'Transitional scrub'], ['#00A600', 'Coniferous forest'],
      ['#80FF00', 'Broadleaved forest'], ['#CCFFCC', 'Sparsely vegetated'],
      ['#E6E64D', 'Pasture'], ['#FFFFA8', 'Arable'],
      ['#FF0000', 'Built-up'], ['#80F2E6', 'Water'],
    ],
    note: 'CORINE 2018, 100 m, 25 ha minimum mapping unit.',
  },
  dnbr: {
    title: 'Burn severity',
    items: [
      ['#7F0000', 'High'], ['#E34A33', 'Moderate-high'],
      ['#FC8D59', 'Moderate-low'], ['#FEE08B', 'Low'],
      ['#D9D9D9', 'Unburned'], ['#91CF60', 'Regrowth'],
    ],
    note: 'dNBR, Key &amp; Benson thresholds. Calibrated on forest, not bog - relative severity, not peat depth.',
  },
};

const legend = L.control({ position: 'bottomleft' });

legend.onAdd = function () {
  const el = L.DomUtil.create('div', 'map-legend');
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  this._el = el;
  this.refresh();
  return el;
};

legend.refresh = function () {
  const el = this._el;
  if (!el) return;
  const active = [];
  if (corineLayer && map.hasLayer(corineLayer)) active.push('corine');
  if (dnbrGroup && map.hasLayer(dnbrGroup)) active.push('dnbr');

  if (!active.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;

  const wasOpen = el.classList.contains('is-open');
  el.innerHTML =
    '<button class="map-legend__toggle" type="button">Legend</button>' +
    '<div class="map-legend__body">' +
    active.map((k) => {
      const s = LEGEND[k];
      return `<div class="map-legend__section"><h4>${s.title}</h4>` +
        s.items.map(([c, l]) =>
          `<div class="map-legend__row"><i style="background:${c}"></i>${l}</div>`).join('') +
        `<p class="map-legend__note">${s.note}</p></div>`;
    }).join('') +
    '</div>';
  if (wasOpen) el.classList.add('is-open');
  el.querySelector('.map-legend__toggle')
    .addEventListener('click', () => el.classList.toggle('is-open'));
};

// ── popups ────────────────────────────────────────────────────────────────
function openFirePopup(feature) {
  const p = feature.properties;
  const state = packStates.get(p.id) || 'none';
  const label = { none: 'Download field pack', ready: 'Downloaded', stale: 'Update pack' }[state];

  const el = document.createElement('div');
  el.className = 'fire-popup';
  el.innerHTML = `
    <h3>${escapeHtml(fireName(p))}</h3>
    <div class="muted small">${escapeHtml(fireSubtitle(p))}</div>
    <div class="muted small">ID ${escapeHtml(String(p.id))}</div>
    <button class="btn btn--sm ${state === 'ready' ? '' : 'btn--primary'}" data-act="pack" ${state === 'ready' ? 'disabled' : ''}>${label}</button>
    <button class="btn btn--sm" data-act="detail">Land cover &amp; severity</button>
  `;
  el.querySelector('[data-act="pack"]').addEventListener('click', () => {
    map.closePopup();
    handlers.onFireSelect && handlers.onFireSelect(feature);
  });
  el.querySelector('[data-act="detail"]').addEventListener('click', () => {
    map.closePopup();
    handlers.onFireDetails && handlers.onFireDetails(feature);
  });

  L.popup({ maxWidth: 260 })
    .setLatLng([feature._c.lat, feature._c.lon])
    .setContent(el)
    .openOn(map);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── public helpers ────────────────────────────────────────────────────────
export function setPackStates(states) {
  packStates = states;
  if (firePolys) firePolys.setStyle(styleFor);
  // Restyle the centroid dots too - these are what is visible and clickable
  // below the polygon threshold.
  for (const [id, marker] of dotById) marker.setStyle(DOT_STYLE[stateOf(id)]);
}

export function getFireIndex() { return fireIndex; }

export function findFireAt(lat, lon) {
  if (!fireIndex) return null;
  return fireIndex.features.find(f => pointInGeometry(lon, lat, f.geometry)) || null;
}

export function firesNear(lat, lon, limit = 25) {
  if (!fireIndex) return [];
  return fireIndex.features
    .map(f => ({ f, d: haversine(lat, lon, f._c.lat, f._c.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

export function zoomToFire(feature) {
  const layer = L.geoJSON(feature);
  map.fitBounds(layer.getBounds().pad(0.25));
}

export function flyTo(lat, lon, zoom = 15) { map.setView([lat, lon], zoom); }

export function renderPoints(points, photoUrls) {
  if (!pointsLayer) return; // map not up yet
  pointsLayer.clearLayers();
  const markers = points.map((p) => {
    const pending = p.status === 'pending';
    const icon = L.divIcon({
      className: '',
      html: `<div class="pt-marker ${pending ? 'pt-marker--pending' : ''}" style="width:16px;height:16px"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8],
    });
    const m = L.marker([p.lat, p.lon], { icon });
    const img = photoUrls && photoUrls.get(p.uuid);
    m.bindPopup(`
      <div class="fire-popup">
        <h3>${p.depthMean != null ? p.depthMean.toFixed(1) : '?'} cm</h3>
        <div class="muted small">${p.depths.filter(d => d != null).join(', ')} cm</div>
        <div class="muted small">${new Date(p.createdAt).toLocaleString('en-GB')}</div>
        ${p.comment ? `<p>${escapeHtml(p.comment)}</p>` : ''}
        ${img ? `<img src="${img}" style="width:100%;border-radius:8px;margin-top:6px" alt="">` : ''}
        <div class="muted small">${pending ? 'Not yet synced' : 'Synced'}</div>
      </div>`);
    return m;
  });
  pointsLayer.addLayers(markers);
}

// ── GPS ───────────────────────────────────────────────────────────────────
export function showGps(lat, lon, accuracy) {
  if (!gpsMarker) {
    gpsMarker = L.circleMarker([lat, lon], {
      radius: 7, color: '#fff', weight: 3, fillColor: '#1D6FE0', fillOpacity: 1,
    }).addTo(map);
    gpsCircle = L.circle([lat, lon], {
      radius: accuracy, color: '#1D6FE0', weight: 1, fillColor: '#1D6FE0', fillOpacity: 0.12,
    }).addTo(map);
  } else {
    gpsMarker.setLatLng([lat, lon]);
    gpsCircle.setLatLng([lat, lon]).setRadius(accuracy);
  }
}

export function centreOnGps(lat, lon) { map.setView([lat, lon], Math.max(map.getZoom(), 16)); }

export function setPlacingMode(on) {
  placingMode = on;
  const el = map.getContainer();
  el.style.cursor = on ? 'crosshair' : '';
}

export function getMap() { return map; }
