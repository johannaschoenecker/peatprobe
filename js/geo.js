// Geometry helpers. Pure functions, no DOM, no Leaflet - so they are easy to
// reason about and to test.

// bbox convention throughout: [west, south, east, north] in WGS84 degrees.

export const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);

export const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;

export const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** Grow a bbox by a distance in km (approximate, adequate at UK latitudes). */
export function bufferBbox([w, s, e, n], km) {
  const dLat = km / 111.32;
  const midLat = (s + n) / 2;
  const dLon = km / (111.32 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  return [
    Math.max(-180, w - dLon), Math.max(-85, s - dLat),
    Math.min(180, e + dLon), Math.min(85, n + dLat),
  ];
}

/** Enumerate every {z,x,y} tile covering a bbox across a zoom range. */
export function tilesForBbox(bbox, minZoom, maxZoom) {
  const [w, s, e, n] = bbox;
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = lon2tile(w, z), x1 = lon2tile(e, z);
    const y0 = lat2tile(n, z), y1 = lat2tile(s, z); // note: y inverted
    const max = 2 ** z - 1;
    for (let x = Math.max(0, x0); x <= Math.min(max, x1); x++) {
      for (let y = Math.max(0, y0); y <= Math.min(max, y1); y++) {
        out.push({ z, x, y });
      }
    }
  }
  return out;
}

/**
 * Cache key for one tile. The layer id is part of the key: without it a CORINE
 * tile and a basemap tile at the same z/x/y overwrite each other.
 */
export const tileKey = (z, x, y, layer = 'base') => `${layer}/${z}/${x}/${y}`;

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** bbox of any GeoJSON geometry. */
export function geometryBbox(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      if (c[1] < s) s = c[1];
      if (c[1] > n) n = c[1];
    } else c.forEach(visit);
  };
  visit(geom.coordinates);
  return [w, s, e, n];
}

export function bboxCentre([w, s, e, n]) {
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

/** Rough area of a bbox in km^2 - only used for display. */
export function bboxAreaKm2([w, s, e, n]) {
  const midLat = (s + n) / 2;
  return (n - s) * 111.32 * (e - w) * 111.32 * Math.cos((midLat * Math.PI) / 180);
}

// ── point in polygon ──────────────────────────────────────────────────────
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inPolygon(lon, lat, rings) {
  if (!rings.length || !inRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (inRing(lon, lat, rings[i])) return false; // in a hole
  }
  return true;
}

/** Works for Polygon and MultiPolygon. */
export function pointInGeometry(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return inPolygon(lon, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some(rings => inPolygon(lon, lat, rings));
  }
  return false;
}

// ── formatting ────────────────────────────────────────────────────────────
export const fmtBytes = (b) => {
  if (b == null) return '-';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} kB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtDistance = (m) =>
  m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
