// Map layer. Leaflet setup, offline-first tiles, the fire index, and the
// points layer.

import * as DB from './db.js';
import { BASEMAPS, SATELLITE, LAYERS, PACK } from './config.js';
import { tileKey, pointInGeometry, haversine } from './geo.js';
import { fireName, fireSubtitle, dnbrIndex, dnbrKey } from './packs.js';
import * as Grid from './grid.js';
import * as Nav from './nav.js';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const UK_CENTRE = [54.6, -3.4];
const DOT_ZOOM_MAX = 10;   // dots below this zoom, real perimeters at/above

let map, firePolys, fireDots, pointsLayer, gpsMarker, gpsCircle;
let fireIndex = null;          // GeoJSON FeatureCollection
let packStates = new Map();    // fireId -> 'none' | 'ready' | 'stale'
let minAreaHa = 0;             // size filter; 0 = show everything
let dotById = new Map();       // fireId -> centroid marker, so it can restyle
let dnbrGroup;                 // burn severity image overlays
let dnbrOverlays = new Map();  // fireId -> L.ImageOverlay
let dnbrMeta;                  // data/dnbr/index.json, or null
let corineLayer;               // kept so the legend can tell if it is showing
let gridGroup;                 // sampling-grid overlay
let gridLayers = new Map();    // fireId -> layerGroup of node markers
let lastGps = null;            // for distance/bearing in grid popups
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

  // Measurements cluster late: transect points sit ~100 m apart, and a 40 px
  // radius was folding them into count bubbles a couple of zooms too early.
  // From zoom 14 in they are always individual dots; further out a tight
  // radius only merges points that genuinely overlap on screen.
  pointsLayer = L.markerClusterGroup({
    maxClusterRadius: 22, disableClusteringAtZoom: 14,
    spiderfyOnMaxZoom: false, showCoverageOnHover: false, chunkedLoading: true,
  }).addTo(map);

  dnbrGroup = L.layerGroup();
  gridGroup = L.layerGroup().addTo(map);  // on by default: it is the fieldwork

  const overlays = {
    'Fire perimeters': firePolys,
    'Measurements': pointsLayer,
    'Sampling grid (100 m)': gridGroup,
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
  const layersCtl = L.control.layers(
    { [BASEMAPS[BASEMAPS.active].label]: base, [SATELLITE.label]: sat },
    overlays,
    { position: 'topright', collapsed: true }
  ).addTo(map);

  map.on('zoomend', syncDotVisibility);
  map.on('moveend zoomend', syncDnbrOverlays);
  map.on('moveend zoomend', syncGridOverlays);
  map.on('zoomend', () => legend.refresh());
  map.on('overlayadd overlayremove', (e) => {
    if (e.layer === dnbrGroup) syncDnbrOverlays();
    if (e.layer === gridGroup) syncGridOverlays();
    legend.refresh();
  });
  map.on('click', (e) => {
    if (placingMode) { handlers.onManualPlace && handlers.onManualPlace(e.latlng); }
  });

  legend.addTo(map);
  areaFilterCtl.addTo(map);

  await loadFireIndex();
  loadAugustSamples(layersCtl);   // fire-and-forget: layer appears only if data exists
  return map;
}

// ── temporary "August samples" overlay ────────────────────────────────────
// Shows where the team already sampled, for colleagues. Purely additive: the
// file data/august-samples.geojson may simply not exist, in which case
// nothing happens. Retire the layer by deleting that file and pushing.
async function loadAugustSamples(layersCtl) {
  let fc;
  try {
    const r = await fetch('data/august-samples.geojson');
    if (!r.ok) return;
    fc = await r.json();
  } catch { return; }
  if (!fc || !fc.features || !fc.features.length) return;

  const lyr = L.geoJSON(fc, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      // Vivid cyan: deliberately alien to every palette in the app, so it
      // reads as "temporary annotation", and clashes with nothing.
      radius: 8, color: '#003049', weight: 2.5,
      fillColor: '#00C2FF', fillOpacity: 0.95,
    }),
    onEachFeature: (f, layer) => {
      const p = f.properties || {};
      const rows = Object.entries(p)
        .filter(([, v]) => v !== null && v !== '' && v !== undefined)
        .map(([k, v]) => `<div class="muted small">${escapeHtml(k)}: <strong>${escapeHtml(String(v))}</strong></div>`)
        .join('');
      layer.bindPopup(`<div class="fire-popup"><h3>August sample</h3>${rows ||
        '<div class="muted small">(no attributes)</div>'}</div>`);
    },
  }).addTo(map);

  layersCtl.addOverlay(lyr, `August samples (${fc.features.length})`);
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

  minAreaHa = (await DB.getMeta('minAreaHa')) || 0;
  areaFilterCtl.refresh(); // control was built before the saved value loaded
  rebuildFireLayers();
  syncDotVisibility();
  handlers.onIndexLoaded && handlers.onIndexLoaded(fireIndex);
}

/** A downloaded fire is never hidden by the size filter - your own work
 *  disappearing from the map would read as data loss. */
function fireVisible(f) {
  if ((packStates.get(f.properties.id) || 'none') !== 'none') return true;
  return (Number(f.properties.areaHA_geo) || 0) >= minAreaHa;
}

function rebuildFireLayers() {
  if (!fireIndex || !firePolys) return;
  const feats = fireIndex.features.filter(fireVisible);

  firePolys.clearLayers();
  firePolys.addData({ type: 'FeatureCollection', features: feats });

  fireDots.clearLayers();
  dotById.clear();
  const dots = feats.map((f) => {
    const m = L.circleMarker([f._c.lat, f._c.lon],
        DOT_STYLE[stateOf(f.properties.id)])
      .on('click', () => openFirePopup(f))
      .bindTooltip(`${fireName(f.properties)} · ${fireSubtitle(f.properties)}`,
                   { direction: 'top', offset: [0, -6] });
    dotById.set(f.properties.id, m);
    return m;
  });
  fireDots.addLayers(dots);
}

export function setAreaFilter(v) {
  minAreaHa = v;
  DB.setMeta('minAreaHa', v).catch(() => {});
  rebuildFireLayers();
}

export function getAreaFilter() { return minAreaHa; }

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

// ── size filter ───────────────────────────────────────────────────────────
// Median EFFIS fire is 16 ha; the steps below cut 1,599 fires to 550/162/83.
const AREA_STEPS = [[0, 'All'], [10, '10+ ha'], [50, '50+ ha'], [100, '100+ ha']];

const areaFilterCtl = L.control({ position: 'topright' });

// Collapsed to a single chip showing the current choice; the four options
// only appear while choosing, then it folds away again - map space is scarce
// on a phone.
areaFilterCtl.onAdd = function () {
  const el = L.DomUtil.create('div', 'area-filter');
  L.DomEvent.disableClickPropagation(el);
  el.innerHTML =
    '<button type="button" class="area-filter__chip"></button>' +
    '<span class="area-filter__opts">' +
    AREA_STEPS.map(([v, label]) =>
      `<button type="button" data-v="${v}">${label}</button>`).join('') +
    '</span>';
  el.querySelector('.area-filter__chip').addEventListener('click', () => {
    el.classList.toggle('is-open');
  });
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    setAreaFilter(Number(btn.dataset.v));
    el.classList.remove('is-open');
    this.refresh();
  });
  // Tapping the map closes the options, like every other transient control.
  map.on('click movestart', () => el.classList.remove('is-open'));
  this._el = el;
  this.refresh();
  return el;
};

areaFilterCtl.refresh = function () {
  if (!this._el) return;
  const current = AREA_STEPS.find(([v]) => v === minAreaHa) || AREA_STEPS[0];
  const chip = this._el.querySelector('.area-filter__chip');
  chip.textContent = current[0] === 0 ? 'Size ▾' : `≥ ${current[0]} ha ▾`;
  chip.classList.toggle('is-filtering', current[0] !== 0);
  this._el.querySelectorAll('button[data-v]').forEach((b) =>
    b.classList.toggle('is-on', Number(b.dataset.v) === minAreaHa));
};

// ── sampling grid overlay ─────────────────────────────────────────────────
// Rendered lazily per fire in view, like the severity overlays. Below
// GRID_MIN_ZOOM the nodes are only a few pixels apart and would read as
// noise, so nothing is drawn - the layer switch stays on, the dots appear as
// you zoom into a fire.
const GRID_MIN_ZOOM = 13;
const GRID_MAX_FIRES = 4;

// Node fill = the node's dNBR severity class, same colours as the severity
// overlay and the legend. The white ring keeps even the pale classes legible
// on the topo basemap. Fires without severity keep the neutral dark fill.
const GRID_SEV_COLORS = ['#91CF60', '#D9D9D9', '#FEE08B', '#FC8D59', '#E34A33', '#7F0000'];
const GRID_SEV_LABELS = ['Regrowth', 'No change', 'Low', 'Moderate-low', 'Moderate-high', 'High'];

const gridNodeStyle = (sev) => ({
  radius: 3.5, color: '#FFFFFF', weight: 1.5,
  fillColor: GRID_SEV_COLORS[sev] || '#2C221A', fillOpacity: 0.95,
});

function dropGridLayer(id) {
  const lg = gridLayers.get(id);
  if (lg) gridGroup.removeLayer(lg);
  gridLayers.delete(id);
}

async function syncGridOverlays() {
  if (!gridGroup || !map.hasLayer(gridGroup) || !fireIndex) return;
  if (map.getZoom() < GRID_MIN_ZOOM) {
    for (const id of [...gridLayers.keys()]) dropGridLayer(id);
    return;
  }

  const view = map.getBounds();
  const keep = view.pad(0.5);
  for (const [id, lg] of [...gridLayers]) {
    if (lg && !keep.intersects(lg._ppBounds)) dropGridLayer(id);
  }

  const candidates = fireIndex.features.filter((f) => {
    const [w, s, e, n] = f._bbox || (f._bbox = geometryBboxOf(f));
    return view.intersects(L.latLngBounds([s, w], [n, e]));
  }).slice(0, GRID_MAX_FIRES);

  for (const f of candidates) {
    const id = f.properties.id;
    if (gridLayers.has(id)) continue;
    // Reserve the slot BEFORE awaiting: moveend and zoomend fire together,
    // and two concurrent runs both passing the has() check would render every
    // node twice.
    gridLayers.set(id, null);
    const g = await Grid.loadGrid(id);
    if (!g || !g.points) { gridLayers.delete(id); continue; }
    const lg = L.layerGroup();
    for (const [e, n, lat, lon, sev] of g.points) {
      L.circleMarker([lat, lon], gridNodeStyle(sev))
        .on('click', () => openGridPopup(e, n, lat, lon, f, sev))
        .addTo(lg);
    }
    const [w, s, e2, n2] = f._bbox;
    lg._ppBounds = L.latLngBounds([s, w], [n2, e2]);
    gridLayers.set(id, lg);
    gridGroup.addLayer(lg);
  }
}

function geometryBboxOf(f) {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1];
    } else c.forEach(visit);
  };
  visit(f.geometry.coordinates);
  return [w, s, e, n];
}

function openGridPopup(e, n, lat, lon, feature, sev) {
  const id = Grid.nodeId(e, n);
  const sevLine = GRID_SEV_LABELS[sev]
    ? `<div class="muted small">Burn severity here: <strong>${GRID_SEV_LABELS[sev]}</strong> (satellite estimate)</div>`
    : '';
  let nav = '';
  if (lastGps) {
    const t = Grid.towards(lastGps.lat, lastGps.lon, lat, lon);
    nav = t.distM < 5
      ? '<div class="muted small">You are here (±5 m)</div>'
      : `<div class="muted small">${t.distM < 1000
            ? `${Math.round(t.distM)} m`
            : `${(t.distM / 1000).toFixed(1)} km`} ${t.compass} of you (${t.bearingDeg}°)</div>`;
  }
  // A DOM node rather than an HTML string, so the Navigate button can carry a
  // real click handler (and iOS compass permission needs that user gesture).
  const content = document.createElement('div');
  content.className = 'fire-popup';
  content.innerHTML = `
      <h3>${id}</h3>
      <div class="muted small">${escapeHtml(fireName(feature.properties))}</div>
      <div class="muted small">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
      ${sevLine}
      ${nav}
      <div class="muted small">Sample within a few metres of this node and
      it will be recorded against it automatically.</div>
      <button type="button" class="btn btn--sm btn--primary popup-navigate">Navigate here</button>`;
  content.querySelector('.popup-navigate').addEventListener('click', () => {
    map.closePopup();
    Nav.start({ lat, lon, label: id }, lastGps);
  });
  L.popup({ maxWidth: 240 }).setLatLng([lat, lon]).setContent(content).openOn(map);
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
  if ((dnbrGroup && map.hasLayer(dnbrGroup)) ||
      (gridGroup && map.hasLayer(gridGroup) && map.getZoom() >= GRID_MIN_ZOOM)) {
    active.push('dnbr');   // grid nodes wear the same severity colours
  }

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
  if (minAreaHa > 0) {
    // A newly downloaded fire may have been hidden by the size filter and
    // must reappear, so rebuild rather than restyle.
    rebuildFireLayers();
    return;
  }
  if (firePolys) firePolys.setStyle(styleFor);
  // Restyle the centroid dots too - these are what is visible and clickable
  // below the polygon threshold.
  for (const [id, marker] of dotById) marker.setStyle(DOT_STYLE[stateOf(id)]);
}

export function getFireIndex() { return fireIndex; }

/** Metres from a point to the nearest edge of a Polygon/MultiPolygon. */
function distToGeometryM(lat, lon, geom, mLat, mLon) {
  let best = Infinity;
  const px = lon * mLon, py = lat * mLat;
  const walkRing = (ring) => {
    for (let i = 1; i < ring.length; i++) {
      const ax = ring[i - 1][0] * mLon, ay = ring[i - 1][1] * mLat;
      const bx = ring[i][0] * mLon,     by = ring[i][1] * mLat;
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < best) best = d;
    }
  };
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const rings of polys) for (const ring of rings) walkRing(ring);
  return best;
}

/**
 * The fire this point belongs to, allowing a buffer around each perimeter.
 * The buffer absorbs GPS error, the index's ~40 m simplification tolerance,
 * and sampling right at the fire's edge - all of which otherwise strand a
 * measurement as "outside mapped fires".
 */
export function findFireNear(lat, lon, maxM = 100) {
  const exact = findFireAt(lat, lon);
  if (exact) return { feature: exact, distM: 0 };
  if (!fireIndex) return null;
  const mLat = 111320, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const padLat = (maxM * 1.5) / mLat, padLon = (maxM * 1.5) / mLon;
  let best = null, bestD = Infinity;
  for (const f of fireIndex.features) {
    const [w, s, e, n] = f._bbox || (f._bbox = geometryBboxOf(f));
    if (lat < s - padLat || lat > n + padLat || lon < w - padLon || lon > e + padLon) continue;
    const d = distToGeometryM(lat, lon, f.geometry, mLat, mLon);
    if (d < bestD) { bestD = d; best = f; }
  }
  return best && bestD <= maxM ? { feature: best, distM: bestD } : null;
}

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
  lastGps = { lat, lon, accuracy };
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
