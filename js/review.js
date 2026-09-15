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

export function renderQueue(host, records, { onDecide, onShowOnMap }) {
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
      </div>
      <div class="review-card__body">
        <div class="point-card__depth">${r.depthMean != null ? r.depthMean.toFixed(1) : '?'} cm</div>
        <div class="muted small">${depths.join(', ')} cm · ${esc(COMBUSTION[r.combustion] || r.combustion || 'combustion not given')}</div>
        <div class="muted small">${esc(r.fireName || 'Unassigned fire')}</div>
        <div class="muted small">${esc(r.surveyor || r.userEmail || 'anonymous')} · ${fmtDate(r.createdAt)}
          ${r.accuracyM != null ? ` · ±${Math.round(r.accuracyM)} m` : ''}</div>
        ${r.gridId ? `<div class="muted small">Grid ${esc(r.gridId)} (${r.gridDistM ?? '?'} m)</div>`
                   : '<div class="muted small">Not at a grid node</div>'}
        <div class="review-card__actions">
          <button class="btn btn--sm" data-act="map">Map</button>
          <button class="btn btn--sm" data-act="reject">Reject</button>
          <button class="btn btn--sm btn--primary" data-act="verify">Approve</button>
        </div>
      </div>`;

    card.querySelector('[data-act="map"]').addEventListener('click',
      () => onShowOnMap(r));
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
    onDecide: async (r, status) => {
      await Sync.setStatus(r.uuid, status);
      helpers.onDecided && helpers.onDecided(r, status);
    },
  });
  return records.length;
}
