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

// Keep in step with the version the Firebase console currently recommends.
const SDK = 'https://www.gstatic.com/firebasejs/12.18.0';

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
/**
 * Popup first; full-page redirect where popups cannot work. Installed
 * home-screen apps (which our own instructions recommend!) routinely block
 * or break auth popups - the tap on Sync then dies before any sign-in UI
 * appears, which reads as "I never had to sign in".
 * Returns null when redirecting: the page is about to navigate away.
 */
export async function signIn() {
  const { auth, authMod } = await init();
  const provider = new authMod.GoogleAuthProvider();
  try {
    const cred = await authMod.signInWithPopup(auth, provider);
    return cred.user;
  } catch (err) {
    const c = (err && err.code) || '';
    const popupBroken = [
      'auth/popup-blocked',
      'auth/cancelled-popup-request',
      'auth/operation-not-supported-in-this-environment',
    ].includes(c);
    if (!popupBroken) throw err;   // e.g. user closed it on purpose
    await authMod.signInWithRedirect(auth, provider);
    return null;
  }
}

/**
 * Complete a redirect sign-in when the app comes back from Google.
 * Cheap no-op on every normal launch.
 */
export async function completeRedirect() {
  if (!isEnabled()) return null;
  const { auth, authMod } = await init();
  try {
    const res = await authMod.getRedirectResult(auth);
    return (res && res.user) || null;
  } catch {
    return null;
  }
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

// ── admin / review ────────────────────────────────────────────────────────
// The UI hides the Review tab from non-admins, but that is convenience only:
// the Firestore rules are what actually refuse status changes from anyone
// whose UID is not a document in the admins collection.

export async function isAdminUser() {
  const user = await currentUser();
  if (!user) return false;
  try {
    const { db, fsMod } = await init();
    const snap = await fsMod.getDoc(fsMod.doc(db, 'admins', user.uid));
    return snap.exists();
  } catch {
    return false;
  }
}

/** Oldest-first queue of measurements awaiting review. */
export async function fetchPending(max = 50) {
  const user = await currentUser();
  if (!user) throw new Error('Not signed in - use My data → Sync now, then reopen Review');
  // Force-refresh the ID token: a stale token is the classic cause of a
  // permission denial moments after another read succeeded.
  await user.getIdToken(true).catch(() => {});
  const { db, fsMod } = await init();
  const q = fsMod.query(
    fsMod.collection(db, 'measurements'),
    fsMod.where('status', '==', 'pending_review'),
    fsMod.limit(max)
  );
  const snap = await fsMod.getDocs(q);
  return snap.docs.map(d => d.data())
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function setStatus(uuid, status) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in first');
  await user.getIdToken(true).catch(() => {});
  const { db, fsMod } = await init();
  await fsMod.updateDoc(fsMod.doc(db, 'measurements', uuid), {
    status,
    reviewedAt: Date.now(),
    reviewedBy: user.uid,
  });
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
  let pushed = 0, failed = 0, firstError = null;

  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    onProgress && onProgress({ done: i, total: pending.length });
    try {
      // Upload every photo of the point that has not reached Storage yet.
      // Filenames use '-' (not '_') so the storage.rules name pattern that is
      // already deployed keeps matching without a rules re-publish.
      const count = p.photoCount ?? (p.hasPhoto ? 1 : 0);
      let photoUrls = Array.isArray(p.photoUrls) ? p.photoUrls.slice() : [];
      if (photoUrls.length < count) {
        photoUrls = [];
        for (let k = 0; k < count; k++) {
          const key = p.photoCount != null ? `${p.uuid}:${k}` : p.uuid;
          const blob = await DB.getPhoto(key);
          if (!blob) continue;
          const name = count > 1 || p.photoCount != null ? `${p.uuid}-${k}.jpg` : `${p.uuid}.jpg`;
          const ref = stMod.ref(storage, `photos/${p.fireId || 'unassigned'}/${name}`);
          await stMod.uploadBytes(ref, blob, { contentType: 'image/jpeg' });
          photoUrls.push(await stMod.getDownloadURL(ref));
        }
      }
      const photoUrl = photoUrls[0] || p.photoUrl || null;

      const doc = {
        uuid: p.uuid,
        fireId: p.fireId || null,
        fireName: p.fireName || null,
        lat: p.lat, lon: p.lon,
        accuracyM: p.accuracyM ?? null,
        depths: p.depths,
        depthMean: p.depthMean,
        depthCount: p.depths.filter(d => d != null).length,
        combustion: p.combustion || null,
        gridId: p.gridId || null,
        gridDistM: p.gridDistM ?? null,
        comment: p.comment || '',
        surveyor: p.surveyor || '',
        photoUrl,
        photoUrls,
        photoCount: count,
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
      p.photoUrls = photoUrls;
      p.photoPending = false;
      p.syncedAt = Date.now();
      await DB.putPoint(p);
      pushed++;
    } catch (err) {
      console.warn('sync failed for', p.uuid, err);
      if (!firstError) firstError = `${err.code || ''} ${err.message || err}`.trim().slice(0, 140);
      failed++;
    }
  }
  onProgress && onProgress({ done: pending.length, total: pending.length });
  return { pushed, failed, firstError };
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
        combustion: r.combustion || null,
        gridId: r.gridId || null, gridDistM: r.gridDistM ?? null,
        comment: r.comment, surveyor: r.surveyor,
        photoUrl: r.photoUrl, photoUrls: r.photoUrls || [],
        photoCount: r.photoCount ?? (r.photoUrl ? 1 : 0), hasPhoto: !!r.photoUrl,
        userId: r.userId,
        status: 'synced', remote: true,
        createdAt: r.createdAt, syncedAt: r.syncedAt,
      });
      n++;
    }
  }
  return n;
}
