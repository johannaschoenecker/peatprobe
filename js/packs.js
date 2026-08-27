// Field packs: everything needed to work one fire with no signal.
//
// A pack = basemap tiles for the fire's bbox + buffer, the detailed perimeter,
// and a snapshot of points already recorded there. Tiles are shared between
// packs, so deleting one pack never strands another.

import * as DB from './db.js';
import { PACK, BASEMAPS, LAYERS, APP } from './config.js';
import { tilesForBbox, bufferBbox, geometryBbox, tileKey, bboxAreaKm2 } from './geo.js';

// Measured over Dava Moor, the Peak District and the Flow Country using
// MapTiler topo-v4 webp: mean 18.5 kB, median 14.1 kB. Using the mean so the
// estimate shown to a volunteer errs on the pessimistic side.
const BYTES_PER_TILE_GUESS = 19 * 1024;

// Categorical PNGs with a handful of flat colours; nothing like a topo tile.
const CORINE_BYTES_GUESS = 2.5 * 1024;

/** Cache key for a fire's severity overlay, kept clear of the tile namespaces. */
export const dnbrKey = (fireId) => `dnbr/${fireId}`;

let _dnbrIndex;
/** data/dnbr/index.json, fetched once. Null if severity was never generated. */
export function dnbrIndex() {
  if (_dnbrIndex === undefined) {
    _dnbrIndex = fetch('data/dnbr/index.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _dnbrIndex;
}

const expand = (tpl, z, x, y) =>
  tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'a');

/**
 * Which tile sets a pack contains. CORINE is only included when its tiles have
 * actually been generated, and only up to its own native zoom - it is 100 m
 * data, so tiling past z12 just stores blurrier copies of the same pixels.
 * Leaflet upscales the rest.
 */
function tileSets() {
  const sets = [{
    id: 'base',
    url: BASEMAPS[BASEMAPS.active].url,
    minZoom: PACK.minZoom,
    maxZoom: PACK.maxZoom,
  }];
  if (LAYERS.corineAvailable) {
    sets.push({
      id: 'corine',
      url: LAYERS.corineTiles,
      minZoom: PACK.minZoom,
      maxZoom: Math.min(PACK.maxZoom, LAYERS.corineMaxZoom),
      optional: true,   // a missing CORINE tile must not fail the pack
    });
  }
  return sets;
}

/** What would downloading this fire cost? Call before committing. */
export function estimatePack(feature) {
  const raw = geometryBbox(feature.geometry);
  const bbox = bufferBbox(raw, PACK.bufferKm);

  const jobs = [];
  for (const set of tileSets()) {
    for (const t of tilesForBbox(bbox, set.minZoom, set.maxZoom)) {
      jobs.push({ ...t, set });
    }
  }
  // CORINE tiles are flat categorical PNGs and compress far harder than a
  // topo basemap, so they should not be costed at the basemap rate.
  const estBytes = jobs.reduce(
    (a, j) => a + (j.set.id === 'base' ? BYTES_PER_TILE_GUESS : CORINE_BYTES_GUESS), 0);

  return {
    bbox,
    tiles: jobs,
    count: jobs.length,
    estBytes,
    areaKm2: bboxAreaKm2(bbox),
    tooBig: jobs.length > PACK.maxTiles,
    shouldWarn: jobs.length > PACK.warnTiles,
  };
}

/** Simple bounded-concurrency worker pool. */
async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * Download a pack.
 * @param {object} feature  GeoJSON feature from the fire index
 * @param {(p:{done:number,total:number,failed:number,bytes:number})=>void} onProgress
 * @param {AbortSignal} [signal]
 */
export async function downloadPack(feature, onProgress, signal) {
  const fireId = feature.properties.id;
  const est = estimatePack(feature);
  if (est.tooBig) {
    throw new Error(`That fire needs ${est.count} tiles, over the ${PACK.maxTiles} limit. Reduce maxZoom in config.js if you really need it.`);
  }

  await DB.requestPersistence();

  let done = 0, failed = 0, bytes = 0;
  const report = () => onProgress && onProgress({ done, total: est.count, failed, bytes });
  report();

  await pool(est.tiles, PACK.concurrency, async ({ z, x, y, set }) => {
    if (signal && signal.aborted) return;
    const key = tileKey(z, x, y, set.id);
    try {
      // Tiles are immutable enough that re-downloading a shared one is waste.
      // No done++ here: the finally block owns the counter.
      if (await DB.hasTile(key)) return;
      const res = await fetch(expand(set.url, z, x, y), { signal, cache: 'force-cache' });
      if (!res.ok) {
        // An overlay with no coverage here (sea, or outside the CORINE
        // footprint) is normal and must not be counted as a failure.
        if (set.optional && (res.status === 404 || res.status === 204)) return;
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      await DB.putTile(key, fireId, blob);
      bytes += blob.size;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (!set.optional) failed++;
    } finally {
      done++;
      if (done % 5 === 0 || done === est.count) report();
    }
  });

  if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Detailed perimeter, if the build script produced per-fire files.
  let detail = null;
  try {
    const r = await fetch(`data/fires/${encodeURIComponent(fireId)}.geojson`);
    if (r.ok) detail = await r.json();
  } catch { /* fall back to the simplified index geometry */ }

  // Burn severity overlay. Only 162 of the 1,599 fires have one (the rest are
  // too small, or had no usable cloud-free imagery), so absence is normal.
  let dnbr = null;
  try {
    const meta = await dnbrIndex();
    const entry = meta && meta.fires[fireId];
    if (entry) {
      const r = await fetch(`data/dnbr/${encodeURIComponent(fireId)}.png`);
      if (r.ok) {
        const blob = await r.blob();
        await DB.putTile(dnbrKey(fireId), fireId, blob);
        bytes += blob.size;
        // Bounds live on the pack, so the overlay works offline without
        // needing index.json to have been cached.
        dnbr = { bounds: entry.bounds, severeFrac: entry.severe_frac,
                 mean: entry.dnbr_mean, p90: entry.dnbr_p90 };
      }
    }
  } catch { /* severity is optional context; never fail a pack over it */ }

  const pack = {
    fireId,
    name: fireName(feature.properties),
    props: feature.properties,
    geometry: (detail && detail.geometry) || feature.geometry,
    bbox: est.bbox,
    tileCount: est.count,
    failed,
    bytes,
    dnbr,
    version: APP.packVersion,
    basemap: BASEMAPS.active,
    downloadedAt: Date.now(),
  };
  await DB.putPack(pack);
  return pack;
}

/** Remove a pack, keeping any tiles another pack still needs. */
export async function removePack(fireId) {
  const packs = await DB.allPacks();
  const keep = new Set();
  for (const p of packs) {
    if (p.fireId === fireId) continue;
    for (const set of tileSets()) {
      for (const t of tilesForBbox(p.bbox, set.minZoom, set.maxZoom)) {
        keep.add(tileKey(t.z, t.x, t.y, set.id));
      }
    }
  }
  await DB.deleteTilesForFire(fireId, keep);
  await DB.deletePack(fireId);
}

export function packState(pack) {
  if (!pack) return 'none';
  if (pack.version !== APP.packVersion || pack.basemap !== BASEMAPS.active) return 'stale';
  return 'ready';
}

/** Human label for a fire, built from the EFFIS COMMUNE/PROVINCE fields. */
export function fireName(props) {
  const parts = [props.COMMUNE, props.PROVINCE].filter(
    v => v && String(v).trim() && String(v).trim() !== '0'
  );
  const place = parts.length ? [...new Set(parts)].join(', ') : 'Unnamed fire';
  return place;
}

export function fireSubtitle(props) {
  const bits = [];
  if (props.FIREDATE) bits.push(String(props.FIREDATE).slice(0, 10));
  const ha = Number(props.areaHA_geo ?? props.AREA_HA);
  if (Number.isFinite(ha) && ha > 0) {
    bits.push(ha >= 100 ? `${Math.round(ha).toLocaleString()} ha` : `${ha.toFixed(1)} ha`);
  }
  if (props.COUNTRY) bits.push(props.COUNTRY);
  return bits.join(' · ');
}
