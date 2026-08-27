// Land cover x burn severity chart for a single fire.
//
// Form: horizontal stacked bars, one row per land cover class, ordered by
// burned area. That answers both questions at once - which habitats burned
// (row length) and how severely (segment mix) - which a matrix/heatmap makes
// you work for.
//
// Land cover is the row label, so severity is the only colour dimension. It is
// ordinal, so it gets a single-hue sequential ramp rather than categorical
// hues. The ramp below was computed in OKLCH at a fixed hue and validated:
// monotone lightness, adjacent dL >= 0.06, single hue (6 deg spread), and the
// light end clears 2:1 against the card. The two "no burn signal" steps sit
// deliberately outside the ramp - they mean absence, not a lower magnitude.

import * as DB from './db.js';

const SEV = [
  { key: 'regrowth',      label: 'Regrowth',      color: '#9DB79A' },
  { key: 'unburned',      label: 'No change',     color: '#C9C6BF' },
  { key: 'low',           label: 'Low',           color: '#F8926A' },
  { key: 'moderate_low',  label: 'Moderate-low',  color: '#E36935' },
  { key: 'moderate_high', label: 'Moderate-high', color: '#BE4000' },
  { key: 'high',          label: 'High',          color: '#892100' },
];

const MAX_ROWS = 7;

let _stats;
export function loadStats() {
  if (_stats === undefined) {
    _stats = fetch('data/dnbr/stats.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _stats;
}

/** Stats for one fire: the shipped file online, the pack's own copy offline. */
export async function statsFor(fireId) {
  const all = await loadStats();
  if (all && all.fires && all.fires[fireId]) return all.fires[fireId];
  const pack = await DB.getPack(fireId);
  return (pack && pack.stats) || null;
}

const fmtHa = (v) =>
  v >= 1000 ? `${Math.round(v).toLocaleString()} ha`
  : v >= 10 ? `${Math.round(v)} ha`
  : `${v.toFixed(1)} ha`;

/** EFFIS dates arrive as "2025-05-07 11:28:00". */
const parseFireDate = (s) => {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtDate = (d) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** "Started 7 May 2025 · burned for 2 days" - the window the imagery hangs off. */
function whenLabel(firedate, finaldate) {
  const a = parseFireDate(firedate);
  if (!a) return '';
  let out = `Started ${fmtDate(a)}`;
  const b = parseFireDate(finaldate);
  if (b && b > a) {
    const hrs = (b - a) / 3600000;
    out += hrs < 24
      ? ` · contained within ${hrs < 1.5 ? 'the hour' : `${Math.round(hrs)} hours`}`
      : ` · burned for ${Math.round(hrs / 24)} day${Math.round(hrs / 24) === 1 ? '' : 's'}`;
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Render into `host`. Returns false if this fire has no severity data, so the
 * caller can avoid showing an empty panel.
 */
export function renderFireChart(host, stats, meta) {
  if (!stats || !stats.matrix) return false;
  meta = meta || {};

  let rows = Object.entries(stats.matrix)
    .map(([lc, vals]) => ({ lc, vals, total: vals.reduce((a, b) => a + b, 0) }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);
  if (!rows.length) return false;

  // Long tails of 0.1 ha slivers are noise; fold them into one row.
  if (rows.length > MAX_ROWS) {
    const keep = rows.slice(0, MAX_ROWS - 1);
    const rest = rows.slice(MAX_ROWS - 1);
    const vals = SEV.map((_, i) => rest.reduce((a, r) => a + r.vals[i], 0));
    keep.push({ lc: `Other (${rest.length} classes)`, vals, total: vals.reduce((a, b) => a + b, 0) });
    rows = keep;
  }

  const maxTotal = Math.max(...rows.map(r => r.total));
  const grand = rows.reduce((a, r) => a + r.total, 0);
  const burned = rows.reduce((a, r) => a + r.vals[2] + r.vals[3] + r.vals[4] + r.vals[5], 0);

  host.innerHTML = `
    <div class="chart">
      <div class="chart__head">
        <h3>${esc(meta.name || 'Fire')}</h3>
        ${meta.firedate ? `<p class="chart__when">${esc(whenLabel(meta.firedate, meta.finaldate))}</p>` : ''}
        <p class="chart__sub">${fmtHa(grand)} mapped ·
          <strong>${Math.round(burned / grand * 100)}%</strong> shows a burn signal</p>
      </div>
      <div class="chart__rows">
        ${rows.map(r => `
          <div class="chart__row">
            <div class="chart__label" title="${esc(r.lc)}">${esc(r.lc)}</div>
            <div class="chart__track">
              <div class="chart__bar" style="width:${(r.total / maxTotal * 100).toFixed(2)}%">
                ${r.vals.map((v, i) => v <= 0 ? '' : `
                  <span class="chart__seg" style="flex:${v};background:${SEV[i].color}"
                        tabindex="0"
                        data-tip="${esc(r.lc)} · ${esc(SEV[i].label)}: ${fmtHa(v)} (${Math.round(v / r.total * 100)}%)"></span>`).join('')}
              </div>
            </div>
            <div class="chart__value">${fmtHa(r.total)}</div>
          </div>`).join('')}
      </div>
      <div class="chart__legend">
        ${SEV.map(s => `<span class="chart__key"><i style="background:${s.color}"></i>${s.label}</span>`).join('')}
      </div>
      <p class="chart__note">Burn severity from Sentinel-2 dNBR; land cover from CORINE 2018
        (100 m, 25 ha minimum patch). Severity measures surface change, not peat depth, and
        negative values — shown as regrowth — can also reflect seasonal difference between
        the before and after images.</p>
      <details class="chart__table">
        <summary>Show as table</summary>
        <div class="chart__tablewrap"><table>
          <thead><tr><th>Land cover</th>${SEV.map(s => `<th>${s.label}</th>`).join('')}<th>Total</th></tr></thead>
          <tbody>${rows.map(r => `<tr><th>${esc(r.lc)}</th>${r.vals.map(v => `<td>${v ? v.toFixed(1) : '—'}</td>`).join('')}<td>${r.total.toFixed(1)}</td></tr>`).join('')}</tbody>
        </table></div>
      </details>
    </div>`;

  attachTips(host);
  return true;
}

/** Hover/focus tooltip. Segments are thin, so the tip is anchored to the row. */
function attachTips(host) {
  let tip = host.querySelector('.chart__tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart__tip';
    tip.hidden = true;
    host.appendChild(tip);
  }
  const show = (e) => {
    const seg = e.target.closest('[data-tip]');
    if (!seg) return;
    tip.textContent = seg.dataset.tip;
    tip.hidden = false;
    const hb = host.getBoundingClientRect();
    const sb = seg.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, sb.left - hb.left + sb.width / 2 - 90), hb.width - 188)}px`;
    tip.style.top = `${sb.top - hb.top - 34}px`;
  };
  const hide = () => { tip.hidden = true; };
  host.addEventListener('pointerover', show);
  host.addEventListener('pointerout', hide);
  host.addEventListener('focusin', show);
  host.addEventListener('focusout', hide);
}
