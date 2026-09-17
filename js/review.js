// Admin review queue: the Firestore-console clicking, replaced by one card
// per pending measurement with everything needed for a verdict in view.
//
// Rendering is separated from data so it can be tested with mock records;
// all real reads/writes go through sync.js and are gated by the Firestore
// rules, not by this UI.

import * as Sync from './sync.js';

const COMBUSTION = {
  unburned: 'Unburned', light: 'Lightly burned',
  moderate: 'Moderately burned', near_complete: '(Near) complete',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (t) => t ? new Date(t).toLocaleString('en-GB',
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?';

/**
 * Coordinates written in free text. Two formats surveyors actually use:
 *   decimal  "57.12345, -3.54321"       (>= 3 decimals, so depth readings
 *                                        never match)
 *   DMS      53°29'43.3"N 1°59'19.1"W   (what Google Maps shows on long-press
 *                                        — the field norm when GPS fails)
 * Both must land in the UK bbox. Surveyors write these when their GPS fails
 * and they place the point by eye.
 */
export function coordsInText(text) {
  if (!text) return null;
  const t = String(text);
  let lat = null, lon = null;
  const dec = t.match(/(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,2}\.\d{3,})/);
  const dms = t.match(
    /(\d{1,2})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NS])[,;\s]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EW])/);
  if (dms) {
    lat = (+dms[1]) + (+dms[2]) / 60 + (+dms[3]) / 3600;
    if (dms[4] === 'S') lat = -lat;
    lon = (+dms[5]) + (+dms[6]) / 60 + (+dms[7]) / 3600;
    if (dms[8] === 'W') lon = -lon;
    lat = +lat.toFixed(6); lon = +lon.toFixed(6);
  } else if (dec) {
    lat = parseFloat(dec[1]); lon = parseFloat(dec[2]);
  } else return null;
  if (lat > 49 && lat < 61 && lon > -9 && lon < 2.5) return { lat, lon };
  return null;
}

const distM = (aLat, aLon, bLat, bLon) => {
  const mLat = 111320, mLon = 111320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot((bLat - aLat) * mLat, (bLon - aLon) * mLon);
};

export function renderQueue(host, records, { onDecide, onShowOnMap, onRelocate }) {
  if (!records.length) {
    host.innerHTML = '<p class="muted">Nothing waiting for review. ✓</p>';
    return;
  }
  host.innerHTML = `<p class="muted small">${records.length} measurement(s) waiting.
    Check the photo against the readings, then decide.</p>`;

  for (const r of records) {
    const card = document.createElement('div');
    card.className = 'review-card';
    const depths = (r.depths || []).filter(d => d != null);
    card.innerHTML = `
      <div class="review-card__photo">
        ${r.photoUrl
          ? `<a href="${esc(r.photoUrl)}" target="_blank" rel="noopener">
               <img src="${esc(r.photoUrl)}" alt="Submitted photo" loading="lazy"></a>`
          : '<div class="review-card__nophoto">photo still uploading from the phone</div>'}
        ${(r.photoUrls || []).length > 1 ? `<div class="more">${
            r.photoUrls.slice(1).map(u =>
              `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="More" loading="lazy"></a>`
            ).join('')}</div>` : ''}
      </div>
      <div class="review-card__body">
        <div class="point-card__depth">${r.depthMean != null ? r.depthMean.toFixed(1) : '?'} cm</div>
        <div class="muted small">${depths.join(', ')} cm · ${esc(COMBUSTION[r.combustion] || r.combustion || 'combustion not given')}</div>
        <div class="muted small">${esc(r.fireName || 'Unassigned fire')}</div>
        <div class="muted small">${esc(r.surveyor || r.userEmail || 'anonymous')} · ${fmtDate(r.createdAt)}
          ${r.accuracyM != null ? ` · ±${Math.round(r.accuracyM)} m` : ''}</div>
        ${r.gridId ? `<div class="muted small">Grid ${esc(r.gridId)} (${r.gridDistM ?? '?'} m)</div>`
                   : '<div class="muted small">Not at a grid node</div>'}
        ${r.comment ? `<div class="review-card__comment">“${esc(r.comment)}”</div>` : ''}
        <div class="review-card__fixloc"></div>
        <div class="review-card__actions">
          <button class="btn btn--sm" data-act="map">Map</button>
          <button class="btn btn--sm" data-act="reject">Reject</button>
          <button class="btn btn--sm btn--primary" data-act="verify">Approve</button>
        </div>
      </div>`;

    card.querySelector('[data-act="map"]').addEventListener('click',
      () => onShowOnMap(r));

    // GPS-failure rescue: if the comment carries coordinates meaningfully far
    // from the recorded position, offer to move the point there.
    const cc = coordsInText(r.comment);
    if (cc && onRelocate) {
      const d = distM(r.lat, r.lon, cc.lat, cc.lon);
      if (d > 15) {
        const box = card.querySelector('.review-card__fixloc');
        box.innerHTML = `<button class="btn btn--sm" data-act="fixloc">📍 Move to
          ${cc.lat.toFixed(5)}, ${cc.lon.toFixed(5)} from comment
          (${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} away)</button>`;
        box.querySelector('[data-act="fixloc"]').addEventListener('click', async (e) => {
          e.target.disabled = true;
          try {
            await onRelocate(r, cc);
            r.lat = cc.lat; r.lon = cc.lon;   // so the Map button flies right
            box.innerHTML = '<div class="muted small">✓ Moved to the coordinates from the comment.</div>';
          } catch (err) {
            e.target.disabled = false;
            box.insertAdjacentHTML('beforeend',
              `<div class="form-error small">${esc(err.message)}</div>`);
          }
        });
      }
    }
    for (const [act, status] of [['verify', 'verified'], ['reject', 'rejected']]) {
      card.querySelector(`[data-act="${act}"]`).addEventListener('click', async (e) => {
        const btns = card.querySelectorAll('button');
        btns.forEach(b => { b.disabled = true; });
        try {
          await onDecide(r, status);
          card.classList.add(status === 'verified' ? 'is-approved' : 'is-rejected');
          setTimeout(() => card.remove(), 350);
        } catch (err) {
          btns.forEach(b => { b.disabled = false; });
          throw err;
        }
      });
    }
    host.appendChild(card);
  }
}

/** Load the queue and wire it up. Throws if not signed in / not admin. */
export async function open(host, helpers) {
  host.innerHTML = '<p class="muted">Loading review queue…</p>';
  const records = await Sync.fetchPending(50);
  renderQueue(host, records, {
    onShowOnMap: helpers.onShowOnMap,
    onRelocate: helpers.onRelocate,
    onDecide: async (r, status) => {
      await Sync.setStatus(r.uuid, status);
      helpers.onDecided && helpers.onDecided(r, status);
    },
  });
  return records.length;
}
