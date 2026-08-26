// Map layer. Leaflet setup, offline-first tiles, the fire index, and the
// points layer.

import * as DB from './db.js';
import { BASEMAPS, SATELLITE, LAYERS, PACK } from './config.js';
import { tileKey, pointInGeometry, haversine } from './geo.js';
import { fireName, fireSubtitle } from './packs.js';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const UK_CENTRE = [54.6, -3.4];

let map, firePolys, fireDots, pointsLayer, gpsMarker, gpsCircle;
let fireIndex = null;          // GeoJSON FeatureCollection
let packStates = new Map();    // fireId -> 'none' | 'ready' | 'stale'
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

    DB.getTile(tileKey(coords.z, coords.x, coords.y)).then((blob) => {
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

function offlineTiles(cfg) {
  const layer = new OfflineTileLayer(cfg.url, {
    attribution: cfg.attribution,
    maxZoom: cfg.maxZoom,
    maxNativeZoom: cfg.maxZoom,
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

const styleFor = (f) => STYLE[packStates.get(f.properties.id) || 'none'];

// ── init ──────────────────────────────────────────────────────────────────
export async function initMap(opts) {
  handlers = opts;

  map = L.map('map', {
    center: UK_CENTRE, zoom: 6, zoomControl: false,
    preferCanvas: true, tap: true,
  });
  L.control.zoom({ position: 'topleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

  const base = offlineTiles(BASEMAPS[BASEMAPS.active]).addTo(map);
  const sat = offlineTiles(SATELLITE);

  firePolys = L.geoJSON(null, {
    style: styleFor,
    renderer: L.canvas({ padding: 0.3 }),
    onEachFeature: (f, layer) => layer.on('click', () => openFirePopup(f)),
  }).addTo(map);

  fireDots = L.markerClusterGroup({
    maxClusterRadius: 45, showCoverageOnHover: false, chunkedLoading: true,
  });

  pointsLayer = L.markerClusterGroup({
    maxClusterRadius: 40, showCoverageOnHover: false, chunkedLoading: true,
  }).addTo(map);

  const overlays = {
    'Fire perimeters': firePolys,
    'Measurements': pointsLayer,
  };
  if (LAYERS.corineAvailable) {
    overlays['Land cover (CORINE)'] = offlineTiles({
      url: LAYERS.corineTiles, attribution: 'CORINE Land Cover, Copernicus', maxZoom: 14,
    });
  }
  L.control.layers(
    { [BASEMAPS[BASEMAPS.active].label]: base, [SATELLITE.label]: sat },
    overlays,
    { position: 'topright', collapsed: true }
  ).addTo(map);

  map.on('zoomend', syncDotVisibility);
  map.on('click', (e) => {
    if (placingMode) { handlers.onManualPlace && handlers.onManualPlace(e.latlng); }
  });

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

  const dots = fireIndex.features.map((f) =>
    L.circleMarker([f._c.lat, f._c.lon], {
      radius: 6, color: '#2C221A', weight: 1.5, fillColor: '#EA580C', fillOpacity: 0.9,
    }).on('click', () => openFirePopup(f))
  );
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
  const showDots = map.getZoom() < 11;
  if (showDots && !map.hasLayer(fireDots)) map.addLayer(fireDots);
  if (!showDots && map.hasLayer(fireDots)) map.removeLayer(fireDots);
}

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
    <button class="btn btn--sm ${state === 'ready' ? '' : 'btn--primary'}" ${state === 'ready' ? 'disabled' : ''}>${label}</button>
  `;
  el.querySelector('button').addEventListener('click', () => {
    map.closePopup();
    handlers.onFireSelect && handlers.onFireSelect(feature);
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
