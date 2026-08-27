// PeatProbe - main controller.

import * as DB from './db.js';
import * as MapView from './map.js';
import * as Packs from './packs.js';
import * as Sync from './sync.js';
import { QUALITY, PACK, FIREBASE, BASEMAPS } from './config.js';
import { fmtBytes, fmtDistance } from './geo.js';
import { INFO_HTML } from './info.js';
import * as Chart from './chart.js';

// Ordered from least to most consumed; the value is what gets stored, the
// label is what the surveyor sees and what lands in the CSV.
const COMBUSTION = {
  unburned: 'Unburned',
  light: 'Lightly burned',
  moderate: 'Moderately burned',
  near_complete: '(Near) complete',
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  points: [],
  packs: new Map(),      // fireId -> pack
  gps: null,             // { lat, lon, accuracy, ts }
  draft: null,           // { lat, lon, accuracy, manual }
  photoBlob: null,
  photoUrl: null,
  listFilter: { text: '', downloadedOnly: false, near: null },
  photoUrls: new Map(),
  downloading: new Set(),
  dlProgress: new Map(),   // fireId -> { name, done, total } for the map pill
};

// Closing or reloading mid-download silently loses the pack - the browser
// kills the fetches and nothing is saved. Ask first.
window.addEventListener('beforeunload', (e) => {
  if (state.downloading.size) { e.preventDefault(); e.returnValue = ''; }
});

// ══════════════════════════════════════════════════════════ boot
async function boot() {
  $('#info-pane').innerHTML = INFO_HTML;
  wireTabs();
  wireForm();
  wireButtons();
  wireFireDetail();
  wireNetwork();

  await refreshPacks();

  try {
    await MapView.initMap({
      onFireSelect: handleFireSelect,
      onManualPlace: handleManualPlace,
      onFireDetails: openFireDetail,
      onIndexLoaded: () => renderFireList(),
    });
  } catch (err) {
    toast(err.message, 6000);
  }

  // After the map exists, so the points layer has somewhere to draw.
  await refreshPoints();
  MapView.setPackStates(packStateMap());
  startGps();
  updateStorageDisplay();
  updateSyncPill();

  // The service worker is cache-first, which is right in the field and
  // maddening in development - it serves yesterday's JavaScript and every
  // change looks like it did nothing. Skip it on localhost unless you are
  // deliberately testing offline behaviour (add ?sw=1 for that).
  const isLocal = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  const wantSW = !isLocal || new URLSearchParams(location.search).has('sw');
  if ('serviceWorker' in navigator && wantSW) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  } else if ('serviceWorker' in navigator) {
    // Clear one left behind by an earlier session, or the stale cache wins.
    navigator.serviceWorker.getRegistrations()
      .then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  }

  // A device that has never persisted is a device that can silently lose a
  // day's fieldwork. Ask early, while the user is still on wifi.
  if (await DB.getMeta('askedPersist') !== true) {
    const ok = await DB.requestPersistence();
    await DB.setMeta('askedPersist', true);
    if (!ok) toast('Tip: add PeatProbe to your home screen so your data is not cleared.', 6000);
  }

  const surveyor = await DB.getMeta('surveyor');
  if (surveyor) $('#surveyor-input').value = surveyor;
}

// ══════════════════════════════════════════════════════════ tabs
function wireTabs() {
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.toggle('is-active', b === btn));
      const v = btn.dataset.view;
      $$('.view').forEach(s => s.classList.toggle('is-active', s.id === `view-${v}`));
      if (v === 'map') setTimeout(() => MapView.getMap().invalidateSize(), 60);
      if (v === 'fires') { renderFireList(); updateStorageDisplay(); }
      if (v === 'data') renderPointList();
    });
  });
}

const showTab = (v) => $(`.tab[data-view="${v}"]`).click();

// ══════════════════════════════════════════════════════════ packs
async function refreshPacks() {
  const list = await DB.allPacks();
  state.packs = new Map(list.map(p => [p.fireId, p]));
}

function packStateMap() {
  const m = new Map();
  for (const [id, p] of state.packs) m.set(id, Packs.packState(p));
  return m;
}

async function handleFireSelect(feature) {
  const id = feature.properties.id;
  // Every early exit says why. A silent return after a tap is
  // indistinguishable from a broken button.
  if (state.downloading.has(id)) {
    toast('That pack is already downloading — progress is on the map.', 3500);
    return;
  }

  const existing = state.packs.get(id);
  if (existing && Packs.packState(existing) === 'ready') {
    toast('Pack already downloaded — this fire works offline.', 3000);
    MapView.zoomToFire(feature);
    return;
  }

  const est = Packs.estimatePack(feature);
  if (est.tooBig) { toast(`Too large: ${est.count} tiles.`, 5000); return; }
  if (est.shouldWarn) {
    const ok = confirm(
      `${Packs.fireName(feature.properties)}\n\n` +
      `${est.count} map tiles, roughly ${fmtBytes(est.estBytes)}.\n\n` +
      `Download now? Best done on wifi.`
    );
    if (!ok) return;
  }

  await downloadFire(feature);
}

async function downloadFire(feature) {
  const id = feature.properties.id;
  const name = Packs.fireName(feature.properties);
  state.downloading.add(id);
  state.dlProgress.set(id, { name, done: 0, total: 1 });
  renderFireList();
  updateDlPill();

  const bar = document.querySelector(`[data-progress="${cssEscape(id)}"] > div`);
  try {
    const pack = await Packs.downloadPack(feature, ({ done, total }) => {
      const el = document.querySelector(`[data-progress="${cssEscape(id)}"] > div`) || bar;
      if (el) el.style.width = `${Math.round((done / total) * 100)}%`;
      state.dlProgress.set(id, { name, done, total });
      updateDlPill();
    });
    state.packs.set(id, pack);
    MapView.setPackStates(packStateMap());
    toast(
      pack.failed
        ? `Pack ready, but ${pack.failed} tiles failed. Re-download on a better connection.`
        : `${pack.name} ready for offline use (${fmtBytes(pack.bytes)}).`,
      5000
    );
    if (Sync.isEnabled() && navigator.onLine) {
      try { await Sync.pullForFires([id]); await refreshPoints(); } catch {}
    }
  } catch (err) {
    toast(err.name === 'AbortError' ? 'Download cancelled' : `Download failed: ${err.message}`, 5000);
  } finally {
    state.downloading.delete(id);
    state.dlProgress.delete(id);
    updateDlPill();
    await updateStorageDisplay();
    renderFireList();
  }
}

/** One pill covers all running downloads; hidden when there are none. */
function updateDlPill() {
  const pill = $('#dl-pill');
  const jobs = [...state.dlProgress.values()];
  if (!jobs.length) { pill.hidden = true; return; }
  pill.hidden = false;
  const done = jobs.reduce((a, j) => a + j.done, 0);
  const total = jobs.reduce((a, j) => a + j.total, 0) || 1;
  $('#dl-pill-fill').style.width = `${Math.round((done / total) * 100)}%`;
  $('#dl-pill-text').textContent = jobs.length === 1
    ? `Downloading ${jobs[0].name} · ${Math.round((done / total) * 100)}%`
    : `Downloading ${jobs.length} packs · ${Math.round((done / total) * 100)}%`;
}

async function deleteFirePack(fireId) {
  const local = state.points.filter(p => p.fireId === fireId && p.status === 'pending');
  if (local.length && !confirm(
    `${local.length} measurement(s) from this fire have not been synced yet.\n\n` +
    `Deleting the pack keeps your measurements, but you will lose the offline map. Continue?`
  )) return;

  await Packs.removePack(fireId);
  state.packs.delete(fireId);
  MapView.setPackStates(packStateMap());
  await updateStorageDisplay();
  renderFireList();
  toast('Pack deleted.');
}

// ══════════════════════════════════════════════════════════ fire list
function renderFireList() {
  const idx = MapView.getFireIndex();
  const ul = $('#fire-list');
  if (!idx) { ul.innerHTML = '<li class="muted">Loading fire index…</li>'; return; }

  let items;
  if (state.listFilter.near && state.gps) {
    items = MapView.firesNear(state.gps.lat, state.gps.lon, 40);
  } else {
    items = idx.features.map(f => ({ f, d: null }));
  }

  const q = state.listFilter.text.trim().toLowerCase();
  if (q) {
    items = items.filter(({ f }) => {
      const p = f.properties;
      return `${Packs.fireName(p)} ${p.id} ${p.COUNTRY || ''}`.toLowerCase().includes(q);
    });
  }
  if (state.listFilter.downloadedOnly) items = items.filter(({ f }) => state.packs.has(f.properties.id));
  if (!state.listFilter.near && !q) items = items.slice(0, 60);

  if (!items.length) { ul.innerHTML = '<li class="muted">No fires match.</li>'; return; }

  ul.innerHTML = '';
  for (const { f, d } of items) {
    const p = f.properties;
    const pack = state.packs.get(p.id);
    const st = state.downloading.has(p.id) ? 'downloading' : Packs.packState(pack);
    const badge = {
      none: '<span class="badge badge--none">Not downloaded</span>',
      ready: '<span class="badge badge--ready">Offline ready</span>',
      stale: '<span class="badge badge--stale">Update available</span>',
      downloading: '<span class="badge badge--pending">Downloading…</span>',
    }[st];

    const li = document.createElement('li');
    li.className = 'fire-card';
    li.dataset.state = st === 'downloading' ? 'none' : st;
    li.innerHTML = `
      <div class="fire-card__top">
        <div>
          <p class="fire-card__name">${esc(Packs.fireName(p))}</p>
          <div class="fire-card__meta">${esc(Packs.fireSubtitle(p))}${d != null ? ` · ${fmtDistance(d)} away` : ''}</div>
          ${pack ? `<div class="fire-card__meta">${fmtBytes(pack.bytes)} · ${new Date(pack.downloadedAt).toLocaleDateString('en-GB')}</div>` : ''}
        </div>
        ${badge}
      </div>
      <div class="fire-card__actions"></div>
      ${st === 'downloading' ? `<div class="progress" data-progress="${esc(p.id)}"><div></div></div>` : ''}
    `;

    const actions = li.querySelector('.fire-card__actions');
    actions.append(mkBtn('Show on map', 'btn--sm', () => { showTab('map'); MapView.zoomToFire(f); }));
    if (st === 'none') actions.append(mkBtn('Download', 'btn--sm btn--primary', () => handleFireSelect(f)));
    if (st === 'stale') actions.append(mkBtn('Update', 'btn--sm btn--primary', () => downloadFire(f)));
    if (pack) actions.append(mkBtn('Delete pack', 'btn--sm', () => deleteFirePack(p.id)));
    ul.append(li);
  }
}

// ══════════════════════════════════════════════════════════ GPS
function startGps() {
  if (!navigator.geolocation) { toast('This device has no location support.'); return; }
  navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      state.gps = { lat: latitude, lon: longitude, accuracy, ts: pos.timestamp };
      MapView.showGps(latitude, longitude, accuracy);
      if ($('#point-dialog').open && state.draft && !state.draft.manual) {
        state.draft = { lat: latitude, lon: longitude, accuracy, manual: false };
        renderDraftLocation();
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        toast('Location permission denied. You can still place points by tapping the map.', 6000);
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

// ══════════════════════════════════════════════════════════ record form
function wireButtons() {
  $('#btn-add').addEventListener('click', openForm);
  $('#btn-locate').addEventListener('click', () => {
    if (state.gps) MapView.centreOnGps(state.gps.lat, state.gps.lon);
    else toast('Still waiting for a GPS fix…');
  });
  $('#fire-search').addEventListener('input', (e) => {
    state.listFilter.text = e.target.value; renderFireList();
  });
  $('#btn-near-me').addEventListener('click', (e) => {
    if (!state.gps) { toast('Waiting for a GPS fix…'); return; }
    state.listFilter.near = !state.listFilter.near;
    e.target.classList.toggle('is-on', state.listFilter.near);
    renderFireList();
  });
  $('#btn-show-downloaded').addEventListener('click', (e) => {
    state.listFilter.downloadedOnly = !state.listFilter.downloadedOnly;
    e.target.classList.toggle('is-on', state.listFilter.downloadedOnly);
    renderFireList();
  });
  $('#btn-export').addEventListener('click', exportCsv);
  $('#btn-sync').addEventListener('click', doSync);
  $('#sync-pill').addEventListener('click', () => showTab('data'));
}

// ══════════════════════════════════════════════════════════ fire detail
async function openFireDetail(feature) {
  const dlg = $('#fire-dialog');
  const host = $('#fire-detail');
  state.detailFire = feature;
  const id = feature.properties.id;

  host.innerHTML = '<p class="muted">Loading…</p>';
  dlg.showModal();

  const stats = await Chart.statsFor(id);
  const pr = feature.properties;
  const ok = Chart.renderFireChart(host, stats, {
    name: Packs.fireName(pr),
    firedate: pr.FIREDATE,
    finaldate: pr.FINALDATE,
    id: pr.id,
  });
  if (!ok) {
    host.innerHTML =
      `<h3>${esc(Packs.fireName(feature.properties))}</h3>
       <p class="muted small">${esc(Packs.fireSubtitle(feature.properties))}</p>
       <p class="chart__empty">No burn severity for this fire. Severity was only
       computed for fires of 50 ha or more that had a usable cloud-free
       Sentinel-2 pair before and after the burn.</p>`;
  }

  const st = Packs.packState(state.packs.get(id));
  const dl = $('#fire-download');
  dl.textContent = { none: 'Download pack', ready: 'Pack downloaded', stale: 'Update pack' }[st];
  dl.disabled = st === 'ready';
}

function wireFireDetail() {
  $('#fire-close').addEventListener('click', () => $('#fire-dialog').close());
  $('#fire-zoom').addEventListener('click', () => {
    $('#fire-dialog').close();
    if (state.detailFire) { showTab('map'); MapView.zoomToFire(state.detailFire); }
  });
  $('#fire-download').addEventListener('click', () => {
    const f = state.detailFire;
    $('#fire-dialog').close();
    if (f) handleFireSelect(f);
  });
}

function openForm() {
  if (!state.gps) {
    toast('No GPS fix yet — tap the map to place the point manually.', 5000);
    beginManualPlacement();
    return;
  }
  state.draft = { ...state.gps, manual: false };
  resetForm();
  renderDraftLocation();
  $('#point-dialog').showModal();
}

function beginManualPlacement() {
  showTab('map');
  MapView.setPlacingMode(true);
  const hint = $('#map-hint');
  hint.textContent = 'Tap the map where you took the measurement';
  hint.hidden = false;
}

function handleManualPlace(latlng) {
  MapView.setPlacingMode(false);
  $('#map-hint').hidden = true;
  state.draft = { lat: latlng.lat, lon: latlng.lng, accuracy: null, manual: true };
  resetForm();
  renderDraftLocation();
  $('#point-dialog').showModal();
}

function renderDraftLocation() {
  const d = state.draft;
  if (!d) return;
  $('#loc-coords').textContent = `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}`;

  const acc = $('#loc-acc');
  if (d.manual) {
    acc.textContent = 'Placed manually on the map';
    acc.className = 'muted small';
  } else if (d.accuracy != null) {
    const poor = d.accuracy > QUALITY.maxAccuracyM;
    acc.textContent = `GPS accuracy ±${Math.round(d.accuracy)} m` +
      (poor ? ' — poor. Wait a moment or move to open sky if you can.' : '');
    acc.className = poor ? 'small accuracy-warn' : 'muted small';
  }

  const fire = MapView.findFireAt(d.lat, d.lon);
  state.draft.fire = fire;
  $('#loc-fire').textContent = fire
    ? `Inside: ${Packs.fireName(fire.properties)}`
    : 'Not inside a mapped fire perimeter — that is fine, it will be recorded as unassigned.';
}

function wireForm() {
  const dlg = $('#point-dialog');
  $('#form-close').addEventListener('click', () => dlg.close());
  $('#form-cancel').addEventListener('click', () => dlg.close());
  $('#form-save').addEventListener('click', savePoint);
  $('#btn-pick-on-map').addEventListener('click', () => { dlg.close(); beginManualPlacement(); });

  $$('[data-depth]').forEach(i => i.addEventListener('input', updateMean));

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const blob = await resizePhoto(file);
      state.photoBlob = blob;
      if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
      state.photoUrl = URL.createObjectURL(blob);
      const pv = $('#photo-preview');
      pv.querySelector('img').src = state.photoUrl;
      pv.hidden = false;
    } catch {
      toast('Could not read that image. Try taking the photo again.', 5000);
    }
  });

  $('#photo-clear').addEventListener('click', () => {
    state.photoBlob = null;
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
    $('#photo-input').value = '';
    $('#photo-preview').hidden = true;
  });
}

function readDepths() {
  return $$('[data-depth]').map((i) => {
    const v = parseFloat(i.value);
    return Number.isFinite(v) ? v : null;
  });
}

function updateMean() {
  const vals = readDepths().filter(v => v != null);
  if (!vals.length) { $('#depth-mean').textContent = '—'; $('#depth-spread').textContent = ''; return; }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  $('#depth-mean').textContent = `${mean.toFixed(1)} cm`;
  $('#depth-spread').textContent = vals.length > 1
    ? `(${vals.length} readings, range ${Math.min(...vals)}–${Math.max(...vals)} cm)`
    : '(1 reading)';
}

function resetForm() {
  $$('[data-depth]').forEach(i => { i.value = ''; });
  $('#combustion-input').value = '';
  $('#comment-input').value = '';
  $('#form-error').hidden = true;
  $('#photo-clear').click();
  updateMean();
}

async function resizePhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, QUALITY.photoMaxEdgePx / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', QUALITY.photoQuality)
  );
}

async function savePoint() {
  const err = $('#form-error');
  err.hidden = true; // never leave a stale message from a previous attempt
  const depths = readDepths();
  const vals = depths.filter(v => v != null);

  if (!vals.length) return showErr(err, 'Enter at least one burn depth reading.');
  if (vals.some(v => v < 0 || v > QUALITY.maxDepthCm)) {
    return showErr(err, `Readings must be between 0 and ${QUALITY.maxDepthCm} cm.`);
  }
  const combustion = $('#combustion-input').value;
  // Required like the photo: it is one tap, and without it a depth reading
  // cannot be interpreted against how much fuel actually burned. Delete these
  // two lines to make it optional.
  if (!combustion) return showErr(err, 'Choose how completely the vegetation burned.');
  if (!state.photoBlob) return showErr(err, 'A photo is required. It is how we check readings later.');
  if (!state.draft) return showErr(err, 'No location set.');

  const uuid = crypto.randomUUID();
  const surveyor = $('#surveyor-input').value.trim();
  const fire = state.draft.fire;

  const point = {
    uuid,
    fireId: fire ? fire.properties.id : null,
    fireName: fire ? Packs.fireName(fire.properties) : null,
    lat: state.draft.lat,
    lon: state.draft.lon,
    accuracyM: state.draft.accuracy,
    manualPlacement: !!state.draft.manual,
    depths,
    depthMean: vals.reduce((a, b) => a + b, 0) / vals.length,
    combustion,
    comment: $('#comment-input').value.trim(),
    surveyor,
    hasPhoto: true,
    photoUrl: null,
    status: 'pending',
    createdAt: Date.now(),
  };

  await DB.putPhoto(uuid, state.photoBlob);
  await DB.putPoint(point);
  if (surveyor) await DB.setMeta('surveyor', surveyor);

  $('#point-dialog').close();
  await refreshPoints();
  updateSyncPill();
  toast('Measurement saved to this device.');

  if (Sync.isEnabled() && navigator.onLine) doSync({ quiet: true });
}

const showErr = (el, msg) => { el.textContent = msg; el.hidden = false; el.scrollIntoView({ block: 'nearest' }); };

// ══════════════════════════════════════════════════════════ points
async function refreshPoints() {
  state.points = await DB.allPoints();
  state.points.sort((a, b) => b.createdAt - a.createdAt);

  for (const url of state.photoUrls.values()) URL.revokeObjectURL(url);
  state.photoUrls.clear();
  for (const p of state.points) {
    if (p.remote && p.photoUrl) { state.photoUrls.set(p.uuid, p.photoUrl); continue; }
    const blob = await DB.getPhoto(p.uuid);
    if (blob) state.photoUrls.set(p.uuid, URL.createObjectURL(blob));
  }
  MapView.renderPoints(state.points, state.photoUrls);
  renderPointList();
}

function renderPointList() {
  const ul = $('#point-list');
  if (!state.points.length) {
    ul.innerHTML = '<li class="muted">No measurements yet. Open the map and tap <strong>+ Record</strong>.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const p of state.points) {
    const li = document.createElement('li');
    li.className = 'point-card';
    const img = state.photoUrls.get(p.uuid);
    li.innerHTML = `
      ${img ? `<img src="${img}" alt="">` : '<div style="width:56px;height:56px;border-radius:8px;background:var(--line)"></div>'}
      <div class="point-card__main">
        <div class="point-card__depth">${p.depthMean != null ? p.depthMean.toFixed(1) : '?'} cm</div>
        <div class="muted small">${esc(p.fireName || 'Unassigned')} · ${new Date(p.createdAt).toLocaleDateString('en-GB')}</div>
        <div class="muted small">${p.depths.filter(d => d != null).length} reading(s)${p.accuracyM != null ? ` · ±${Math.round(p.accuracyM)} m` : ''}</div>
        ${p.combustion ? `<div class="muted small">${esc(COMBUSTION[p.combustion] || p.combustion)}</div>` : ''}
      </div>
      <span class="badge badge--${p.status === 'pending' ? 'pending' : 'ready'}">${p.status === 'pending' ? 'Unsynced' : 'Synced'}</span>
    `;
    li.addEventListener('click', () => { showTab('map'); MapView.flyTo(p.lat, p.lon, 17); });
    ul.append(li);
  }
}

// ══════════════════════════════════════════════════════════ sync + export
function updateSyncPill() {
  const n = state.points.filter(p => p.status === 'pending').length;
  const pill = $('#sync-pill');
  pill.hidden = n === 0;
  pill.textContent = `${n} unsynced`;
  const note = $('#sync-note');
  if (!Sync.isEnabled()) {
    note.innerHTML = n
      ? `<strong>${n} measurement(s) held on this device.</strong> Cloud sync is off, so export a CSV before uninstalling or clearing your browser.`
      : 'Cloud sync is off. Measurements stay on this device — export a CSV to get them out.';
  } else {
    note.textContent = n ? `${n} measurement(s) waiting to upload.` : 'Everything is synced.';
  }
}

async function doSync(opts = {}) {
  if (!Sync.isEnabled()) {
    if (!opts.quiet) toast('Cloud sync is not configured yet. Use Export CSV instead.', 5000);
    return;
  }
  if (!navigator.onLine) { if (!opts.quiet) toast('No connection. Your data is safe — try again later.', 4000); return; }

  const btn = $('#btn-sync');
  btn.disabled = true;
  const original = btn.textContent;
  try {
    let user = await Sync.currentUser();
    if (!user) { btn.textContent = 'Signing in…'; user = await Sync.signIn(); }

    btn.textContent = 'Uploading…';
    const { pushed, failed } = await Sync.pushPending(({ done, total }) => {
      btn.textContent = `Uploading ${done}/${total}…`;
    });

    const fireIds = [...state.packs.keys()];
    if (fireIds.length) { btn.textContent = 'Fetching…'; await Sync.pullForFires(fireIds); }

    await refreshPoints();
    updateSyncPill();
    if (!opts.quiet || pushed) {
      toast(failed ? `Uploaded ${pushed}, ${failed} failed — will retry.` : `Synced ${pushed} measurement(s).`);
    }
  } catch (e) {
    if (!opts.quiet) toast(`Sync failed: ${e.message}`, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function exportCsv() {
  if (!state.points.length) { toast('Nothing to export yet.'); return; }
  const cols = ['uuid', 'created_iso', 'surveyor', 'fire_id', 'fire_name', 'lat', 'lon',
    'gps_accuracy_m', 'manual_placement', 'depth_1', 'depth_2', 'depth_3', 'depth_4', 'depth_5',
    'depth_mean_cm', 'depth_n', 'combustion', 'comment', 'photo_url', 'status'];
  const q = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = state.points.map(p => [
    p.uuid, new Date(p.createdAt).toISOString(), p.surveyor, p.fireId, p.fireName,
    p.lat.toFixed(6), p.lon.toFixed(6), p.accuracyM != null ? Math.round(p.accuracyM) : '',
    p.manualPlacement ? 'yes' : 'no',
    ...[0, 1, 2, 3, 4].map(i => p.depths[i] ?? ''),
    p.depthMean != null ? p.depthMean.toFixed(2) : '',
    p.depths.filter(d => d != null).length,
    p.combustion || '',
    p.comment, p.photoUrl, p.status,
  ].map(q).join(','));

  const blob = new Blob(['\uFEFF' + cols.join(',') + '\n' + rows.join('\n')],
    { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `peatprobe-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('CSV exported. Photos are not included — sync for those.', 5000);
}

// ══════════════════════════════════════════════════════════ misc
function wireNetwork() {
  const pill = $('#net-pill');
  const set = () => {
    const on = navigator.onLine;
    pill.dataset.state = on ? 'online' : 'offline';
    pill.textContent = on ? 'online' : 'offline';
  };
  window.addEventListener('online', () => { set(); if (Sync.isEnabled()) doSync({ quiet: true }); });
  window.addEventListener('offline', set);
  set();
}

async function updateStorageDisplay() {
  const info = await DB.storageInfo();
  const packs = [...state.packs.values()];
  const packBytes = packs.reduce((a, p) => a + (p.bytes || 0), 0);
  if (!info) {
    $('#storage-text').textContent = `${packs.length} pack(s), ${fmtBytes(packBytes)}.`;
    return;
  }
  const pct = info.quota ? Math.min(100, (info.usage / info.quota) * 100) : 0;
  $('#storage-fill').style.width = `${pct}%`;
  $('#storage-text').innerHTML =
    `${packs.length} pack(s) · ${fmtBytes(info.usage)} used of ${fmtBytes(info.quota)} available` +
    (info.persisted
      ? ' · <span style="color:var(--ok)">storage protected</span>'
      : ' · <span style="color:var(--ember)">not protected — add to home screen</span>');
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

boot();
