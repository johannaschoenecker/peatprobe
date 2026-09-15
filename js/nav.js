// Walk-to-node navigation: a full-screen arrow that points at the selected
// sampling node and counts down the distance as you walk.
//
// The arrow needs to know which way the phone is facing. Three sources, in
// order of preference:
//   1. iOS compass (webkitCompassHeading, behind a permission prompt that MUST
//      be triggered by a user gesture - which is why start() is only ever
//      called from the Navigate button).
//   2. Android absolute orientation (deviceorientationabsolute, 360 - alpha).
//   3. Walking direction derived from successive GPS fixes - works everywhere
//      but only once you have moved a few metres.
// With no source at all the arrow points bearing-from-North and says so.

import * as Grid from './grid.js';

let el = null;            // overlay root, built once
let target = null;        // { lat, lon, label }
let watchId = null;
let heading = null;       // degrees clockwise from North, or null
let headingSource = null; // 'compass' | 'movement' | null
let lastFix = null;       // previous GPS fix, for the movement fallback
let gps = null;           // current { lat, lon, accuracy }
let rotation = 0;         // cumulative arrow rotation, so 359->1 never spins the long way
let wakeLock = null;
let orientationHandler = null;
let orientationEvent = null;

export const isActive = () => !!target;

export function start(t, initialGps) {
  target = t;
  lastFix = null;
  gps = initialGps || null;
  build();
  // Reset leftovers from any previous navigation.
  rotation = 0;
  el.classList.remove('nav--arrived');
  el.querySelector('.nav-arrow').style.transform = 'rotate(0deg)';
  el.hidden = false;
  document.body.classList.add('nav-open');

  watchId = navigator.geolocation.watchPosition(onFix, () => {}, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
  startCompass();
  acquireWakeLock();
  render();
}

export function stop() {
  target = null;
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (orientationHandler) {
    window.removeEventListener(orientationEvent, orientationHandler);
    orientationHandler = null;
  }
  heading = null; headingSource = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (el) el.hidden = true;
  document.body.classList.remove('nav-open');
}

// ── heading ───────────────────────────────────────────────────────────────
async function startCompass() {
  const attach = (event, getHeading) => {
    orientationEvent = event;
    orientationHandler = (e) => {
      const h = getHeading(e);
      if (h == null || Number.isNaN(h)) return;
      heading = h; headingSource = 'compass';
      render();
    };
    window.addEventListener(event, orientationHandler);
  };

  if (typeof DeviceOrientationEvent !== 'undefined'
      && typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS: permission prompt, valid only inside the button tap's call stack.
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res === 'granted') attach('deviceorientation', (e) => e.webkitCompassHeading);
    } catch { /* denied or unavailable - the movement fallback takes over */ }
  } else if ('ondeviceorientationabsolute' in window) {
    attach('deviceorientationabsolute', (e) => e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
  } else {
    attach('deviceorientation', (e) => e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null);
  }
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  gps = { lat, lon, accuracy };
  // Movement fallback: the direction you are walking, once you have walked.
  if (headingSource !== 'compass' && lastFix) {
    const step = Grid.towards(lastFix.lat, lastFix.lon, lat, lon);
    if (step.distM > 4) {
      heading = step.bearingDeg; headingSource = 'movement';
      lastFix = { lat, lon };
    }
  } else if (!lastFix) {
    lastFix = { lat, lon };
  }
  if (headingSource === 'compass') lastFix = { lat, lon };
  render();
}

// ── wake lock: keep the screen on while navigating ────────────────────────
async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (target && document.visibilityState === 'visible' && wakeLock !== null) {
        wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
      }
    });
  } catch { /* not supported - the phone will just dim as usual */ }
}

// ── rendering ─────────────────────────────────────────────────────────────
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function render() {
  if (!target || !el) return;
  const label = el.querySelector('.nav-label');
  const dist = el.querySelector('.nav-dist');
  const sub = el.querySelector('.nav-sub');
  const arrowWrap = el.querySelector('.nav-arrow');
  const hint = el.querySelector('.nav-hint');
  label.textContent = target.label;

  if (!gps) {
    dist.textContent = '…';
    sub.textContent = 'Waiting for GPS';
    hint.textContent = '';
    return;
  }
  const t = Grid.towards(gps.lat, gps.lon, target.lat, target.lon);
  const arrived = t.distM <= 5;
  el.classList.toggle('nav--arrived', arrived);

  if (arrived) {
    dist.textContent = 'You are here';
    sub.textContent = `Within ${Math.max(5, Math.round(gps.accuracy || 5))} m of the node — record your measurement.`;
    hint.textContent = '';
    return;
  }

  dist.textContent = fmtDist(t.distM);
  sub.textContent = `${t.compass} of you · GPS ±${Math.round(gps.accuracy || 0)} m`;

  // Arrow angle: where the node is, relative to where the phone points.
  const wanted = heading != null ? (t.bearingDeg - heading + 360) % 360 : t.bearingDeg;
  let delta = wanted - (rotation % 360);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  rotation += delta;
  arrowWrap.style.transform = `rotate(${rotation}deg)`;

  hint.textContent = heading == null
    ? 'No compass yet — the arrow shows the direction from North. Walk a few steps and it will follow you.'
    : headingSource === 'movement'
      ? 'Arrow follows your walking direction.'
      : '';
}

function build() {
  if (el) return;
  el = document.createElement('div');
  el.className = 'nav-overlay';
  el.innerHTML = `
    <div class="nav-card">
      <p class="nav-label"></p>
      <div class="nav-arrow" aria-hidden="true">
        <svg viewBox="0 0 100 100" width="140" height="140">
          <path d="M50 6 L78 74 L50 58 L22 74 Z" fill="currentColor"/>
        </svg>
      </div>
      <p class="nav-dist"></p>
      <p class="nav-sub muted"></p>
      <p class="nav-hint muted small"></p>
      <button type="button" class="btn nav-stop">Stop navigating</button>
    </div>`;
  el.querySelector('.nav-stop').addEventListener('click', stop);
  document.body.appendChild(el);
}
