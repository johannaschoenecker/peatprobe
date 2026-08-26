// IndexedDB layer. Everything the app knows lives here first; the network is
// treated as an optional extra, never as a precondition for recording data.

const DB_NAME = 'peatprobe';
const DB_VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('points')) {
        const s = db.createObjectStore('points', { keyPath: 'uuid' });
        s.createIndex('fireId', 'fireId');
        s.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'uuid' });
      }
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'fireId' });
      }
      if (!db.objectStoreNames.contains('tiles')) {
        const t = db.createObjectStore('tiles', { keyPath: 'key' });
        t.createIndex('fireId', 'fireId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (err) { reject(err); return; }

    // Unwrap IDBRequest properly. Reading `.result` on a miss gives undefined,
    // which must stay undefined - returning the request object instead makes
    // every "does this exist?" check answer yes.
    let value;
    if (out instanceof IDBRequest) {
      out.onsuccess = () => { value = out.result; };
    } else {
      value = out;
    }

    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2promise = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

// ── points ────────────────────────────────────────────────────────────────
export const putPoint   = (p)  => tx('points', 'readwrite', s => s.put(p));
export const getPoint   = (id) => tx('points', 'readonly',  s => s.get(id)).then(r => r);
export const allPoints  = ()   => tx('points', 'readonly',  s => s.getAll());
export const deletePoint = (id) => tx('points', 'readwrite', s => s.delete(id));

export async function pointsByFire(fireId) {
  const db = await open();
  return req2promise(db.transaction('points').objectStore('points').index('fireId').getAll(fireId));
}

export async function pendingPoints() {
  const all = await allPoints();
  return all.filter(p => p.status === 'pending' || p.photoPending);
}

// ── photos ────────────────────────────────────────────────────────────────
export const putPhoto    = (uuid, blob) => tx('photos', 'readwrite', s => s.put({ uuid, blob }));
export const getPhoto    = (uuid) => tx('photos', 'readonly', s => s.get(uuid)).then(r => r && r.blob);
export const deletePhoto = (uuid) => tx('photos', 'readwrite', s => s.delete(uuid));

// ── packs ─────────────────────────────────────────────────────────────────
export const putPack    = (pack) => tx('packs', 'readwrite', s => s.put(pack));
export const getPack    = (id)   => tx('packs', 'readonly',  s => s.get(id));
export const allPacks   = ()     => tx('packs', 'readonly',  s => s.getAll());
export const deletePack = (id)   => tx('packs', 'readwrite', s => s.delete(id));

// ── tiles ─────────────────────────────────────────────────────────────────
export const putTile = (key, fireId, blob) =>
  tx('tiles', 'readwrite', s => s.put({ key, fireId, blob }));

export const getTile = (key) =>
  tx('tiles', 'readonly', s => s.get(key)).then(r => r && r.blob).catch(() => null);

export const hasTile = (key) =>
  tx('tiles', 'readonly', s => s.getKey(key)).then(Boolean).catch(() => false);

// Tiles are shared between packs (fires overlap, and low zooms cover the
// whole country), so only drop a tile if no other pack still claims it.
export async function deleteTilesForFire(fireId, keepKeys) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('tiles', 'readwrite');
    const idx = t.objectStore('tiles').index('fireId');
    const cur = idx.openCursor(IDBKeyRange.only(fireId));
    let removed = 0;
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (!keepKeys.has(c.value.key)) { c.delete(); removed++; }
      c.continue();
    };
    t.oncomplete = () => resolve(removed);
    t.onerror = () => reject(t.error);
  });
}

// ── meta / preferences ────────────────────────────────────────────────────
export const setMeta = (k, v) => tx('meta', 'readwrite', s => s.put({ k, v }));
export const getMeta = (k) => tx('meta', 'readonly', s => s.get(k)).then(r => r && r.v);

// ── storage ───────────────────────────────────────────────────────────────
export async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  let persisted = false;
  if (navigator.storage.persisted) {
    try { persisted = await navigator.storage.persisted(); } catch {}
  }
  return { usage, quota, persisted };
}

// Ask the browser not to evict us. On iOS this is the difference between data
// surviving a week of not opening the app and quietly disappearing.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}
