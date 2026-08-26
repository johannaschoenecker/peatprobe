// Optional Firebase sync.
//
// The app is fully usable with FIREBASE.enabled = false - measurements simply
// stay on the device and can be exported as CSV. Turning this on adds shared
// visibility of everyone's points and off-device backup.
//
// Note: Firestore queues document writes offline by itself, but Cloud Storage
// does NOT queue uploads. That is why photos live in IndexedDB until we have a
// connection, and why a point can briefly exist with its photo still pending.

import { FIREBASE } from './config.js';
import * as DB from './db.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let fb = null;          // { app, auth, db, storage, fns }
let initPromise = null;

export const isEnabled = () => FIREBASE.enabled && !!FIREBASE.config.projectId;

async function init() {
  if (!isEnabled()) throw new Error('Firebase is not configured');
  if (fb) return fb;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [appMod, authMod, fsMod, stMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-storage.js`),
    ]);

    const app = appMod.initializeApp(FIREBASE.config);

    // Persistent local cache = Firestore keeps working with no signal.
    let db;
    try {
      db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({
          tabManager: fsMod.persistentMultipleTabManager(),
        }),
      });
    } catch {
      db = fsMod.getFirestore(app); // already initialised, or unsupported browser
    }

    fb = {
      app,
      auth: authMod.getAuth(app),
      db,
      storage: stMod.getStorage(app),
      authMod, fsMod, stMod,
    };
    return fb;
  })();

  return initPromise;
}

// ── auth ──────────────────────────────────────────────────────────────────
export async function signIn() {
  const { auth, authMod } = await init();
  const provider = new authMod.GoogleAuthProvider();
  const cred = await authMod.signInWithPopup(auth, provider);
  return cred.user;
}

export async function signOut() {
  const { auth, authMod } = await init();
  return authMod.signOut(auth);
}

export async function currentUser() {
  if (!isEnabled()) return null;
  const { auth, authMod } = await init();
  if (auth.currentUser) return auth.currentUser;
  return new Promise((resolve) => {
    const un = authMod.onAuthStateChanged(auth, (u) => { un(); resolve(u); });
  });
}

export async function onUserChanged(cb) {
  if (!isEnabled()) return () => {};
  const { auth, authMod } = await init();
  return authMod.onAuthStateChanged(auth, cb);
}

// ── push ──────────────────────────────────────────────────────────────────
/**
 * Upload every pending point. Photos go to Cloud Storage first so the document
 * is never written referencing an object that does not exist.
 */
export async function pushPending(onProgress) {
  if (!isEnabled()) return { pushed: 0, skipped: 0 };
  const user = await currentUser();
  if (!user) throw new Error('Sign in to sync');

  const { db, storage, fsMod, stMod } = await init();
  const pending = await DB.pendingPoints();
  let pushed = 0, failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    onProgress && onProgress({ done: i, total: pending.length });
    try {
      let photoUrl = p.photoUrl || null;

      if (!photoUrl && p.hasPhoto) {
        const blob = await DB.getPhoto(p.uuid);
        if (blob) {
          const ref = stMod.ref(storage, `photos/${p.fireId || 'unassigned'}/${p.uuid}.jpg`);
          await stMod.uploadBytes(ref, blob, { contentType: 'image/jpeg' });
          photoUrl = await stMod.getDownloadURL(ref);
        }
      }

      const doc = {
        uuid: p.uuid,
        fireId: p.fireId || null,
        fireName: p.fireName || null,
        lat: p.lat, lon: p.lon,
        accuracyM: p.accuracyM ?? null,
        depths: p.depths,
        depthMean: p.depthMean,
        depthCount: p.depths.filter(d => d != null).length,
        comment: p.comment || '',
        surveyor: p.surveyor || '',
        photoUrl,
        userId: user.uid,
        userEmail: user.email || null,
        status: 'pending_review',
        createdAt: p.createdAt,
        clientVersion: 1,
        syncedAt: Date.now(),
      };

      // uuid as the document id makes retries idempotent - a flaky upload can
      // never produce a duplicate row.
      await fsMod.setDoc(fsMod.doc(db, 'measurements', p.uuid), doc, { merge: true });

      p.status = 'synced';
      p.photoUrl = photoUrl;
      p.photoPending = false;
      p.syncedAt = Date.now();
      await DB.putPoint(p);
      pushed++;
    } catch (err) {
      console.warn('sync failed for', p.uuid, err);
      failed++;
    }
  }
  onProgress && onProgress({ done: pending.length, total: pending.length });
  return { pushed, failed };
}

// ── pull ──────────────────────────────────────────────────────────────────
/** Fetch everyone's points for the fires this device has packs for. */
export async function pullForFires(fireIds) {
  if (!isEnabled() || !fireIds.length) return 0;
  const { db, fsMod } = await init();
  let n = 0;

  // Firestore `in` queries cap at 30 values, so chunk.
  for (let i = 0; i < fireIds.length; i += 30) {
    const chunk = fireIds.slice(i, i + 30);
    const q = fsMod.query(
      fsMod.collection(db, 'measurements'),
      fsMod.where('fireId', 'in', chunk)
    );
    const snap = await fsMod.getDocs(q);
    for (const d of snap.docs) {
      const r = d.data();
      const existing = await DB.getPoint(r.uuid);
      if (existing && existing.status === 'pending') continue; // never clobber unsynced local edits
      await DB.putPoint({
        uuid: r.uuid,
        fireId: r.fireId, fireName: r.fireName,
        lat: r.lat, lon: r.lon, accuracyM: r.accuracyM,
        depths: r.depths || [], depthMean: r.depthMean,
        comment: r.comment, surveyor: r.surveyor,
        photoUrl: r.photoUrl, hasPhoto: !!r.photoUrl,
        userId: r.userId,
        status: 'synced', remote: true,
        createdAt: r.createdAt, syncedAt: r.syncedAt,
      });
      n++;
    }
  }
  return n;
}
