// Field packs: everything needed to work one fire with no signal.
//
// A pack = basemap tiles for the fire's bbox + buffer, the detailed perimeter,
// and a snapshot of points already recorded there. Tiles are shared between
// packs, so deleting one pack never strands another.

import * as DB from './db.js';
import { PACK, BASEMAPS, APP } from './config.js';
import { tilesForBbox, bufferBbox, geometryBbox, tileKey, bboxAreaKm2 } from './geo.js';

// Measured over Dava Moor, the Peak District and the Flow Country using
// MapTiler topo-v4 webp: mean 18.5 kB, median 14.1 kB. Using the mean so the
// estimate shown to a volunteer errs on the pessimistic side.
const BYTES_PER_TILE_GUESS = 19 * 1024;

function baseUrl() {
  return BASEMAPS[BASEMAPS.active].url;
}

function tileUrl(z, x, y) {
  return baseUrl()
    .replace('{z}', z).replace('{x}', x).replace('{y}', y)
    .replace('{s}', 'a');
}

/** What would downloading this fire cost? Call before committing. */
export function estimatePack(feature) {
  const raw = geometryBbox(feature.geometry);
  const bbox = bufferBbox(raw, PACK.bufferKm);
  const tiles = tilesForBbox(bbox, PACK.minZoom, PACK.maxZoom);
  return {
    bbox,
    tiles,
    count: tiles.length,
    estBytes: tiles.length * BYTES_PER_TILE_GUESS,
    areaKm2: bboxAreaKm2(bbox),
    tooBig: tiles.length > PACK.maxTiles,
    shouldWarn: tiles.length > PACK.warnTiles,
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

  await pool(est.tiles, PACK.concurrency, async ({ z, x, y }) => {
    if (signal && signal.aborted) return;
    const key = tileKey(z, x, y);
    try {
      // Tiles are immutable enough that re-downloading a shared one is waste.
      // No done++ here: the finally block owns the counter.
      if (await DB.hasTile(key)) return;
      const res = await fetch(tileUrl(z, x, y), { signal, cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await DB.putTile(key, fireId, blob);
      bytes += blob.size;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      failed++;
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

  const pack = {
    fireId,
    name: fireName(feature.properties),
    props: feature.properties,
    geometry: (detail && detail.geometry) || feature.geometry,
    bbox: est.bbox,
    tileCount: est.count,
    failed,
    bytes,
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
    for (const t of tilesForBbox(p.bbox, PACK.minZoom, PACK.maxZoom)) {
      keep.add(tileKey(t.z, t.x, t.y));
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
