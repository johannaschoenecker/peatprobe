// AR quadrat: project a true-scale 1 x 1 m sampling square onto the ground
// through the phone camera. A bonus aid for cover estimation, not part of the
// recording flow - the button simply does not appear on phones that cannot
// do it, and a physical quadrat remains the exact reference.
//
// Two platforms, two mechanisms:
//   iPhone  - Safari has no WebXR AR, but AR Quick Look will place a USDZ
//             model at true scale: a link with rel="ar" opens Apple's viewer
//             on assets/quadrat.usdz.
//   Android - WebXR immersive-ar with hit-test: tap the detected ground to
//             anchor the square, tap again to move it. three.js is loaded
//             lazily so the ~650 kB library never touches normal startup.
//
// Scale honesty: AR tracking is typically within a few percent over a metre.
// Fine for estimating cover; not a replacement where the protocol treats the
// quadrat boundary as exact.

let mode = null;   // 'quicklook' | 'webxr' | null

export async function detect() {
  if (mode !== null) return mode;
  const a = document.createElement('a');
  if (a.relList && a.relList.supports && a.relList.supports('ar')) {
    mode = 'quicklook';
  } else if (navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)) {
    mode = 'webxr';
  } else {
    mode = false;
  }
  return mode;
}

/** iOS: a rel="ar" anchor MUST contain an <img> child to trigger Quick Look. */
export function quickLookOpen() {
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = 'assets/quadrat.usdz';
  a.appendChild(document.createElement('img'));
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Android WebXR session ─────────────────────────────────────────────────

function buildQuadrat(THREE) {
  const g = new THREE.Group();
  const frame = new THREE.MeshBasicMaterial({ color: 0xEA580C });
  const tick = new THREE.MeshBasicMaterial({ color: 0xF6F1E8 });
  const bar = (w, d, x, z, m) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), m);
    mesh.position.set(x, 0.005, z);
    g.add(mesh);
  };
  const S = 1.0, T = 0.04;
  bar(S + T, T, 0, -S / 2, frame); bar(S + T, T, 0, S / 2, frame);
  bar(T, S - T, -S / 2, 0, frame); bar(T, S - T, S / 2, 0, frame);
  for (let i = 1; i < 10; i++) {
    const p = -S / 2 + i * 0.1;
    bar(0.012, 0.07, p, -S / 2 + 0.055, tick);
    bar(0.012, 0.07, p, S / 2 - 0.055, tick);
    bar(0.07, 0.012, -S / 2 + 0.055, p, tick);
    bar(0.07, 0.012, S / 2 - 0.055, p, tick);
  }
  bar(S - T, 0.012, 0, 0, tick); bar(0.012, S - T, 0, 0, tick);
  return g;
}

export async function webxrStart(onEnd) {
  const THREE = await import('../vendor/three/three.module.min.js');

  const overlay = document.createElement('div');
  overlay.className = 'ar-overlay';
  overlay.innerHTML = `
    <p class="ar-overlay__hint">Move the phone slowly over the ground, then
    tap where the square should lie. Tap again to move it.</p>
    <button type="button" class="ar-overlay__close">Done</button>`;
  document.body.appendChild(overlay);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();

  const quadrat = buildQuadrat(THREE);
  quadrat.visible = false;
  scene.add(quadrat);

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xEA580C })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  let session;
  const cleanup = () => {
    try { renderer.setAnimationLoop(null); } catch {}
    renderer.domElement.remove();
    overlay.remove();
    renderer.dispose();
    onEnd && onEnd();
  };

  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  overlay.querySelector('.ar-overlay__close').addEventListener('click', () => session.end());
  session.addEventListener('end', cleanup);
  await renderer.xr.setSession(session);

  const viewerSpace = await session.requestReferenceSpace('viewer');
  const localSpace = await session.requestReferenceSpace('local');
  const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  session.addEventListener('select', () => {
    if (!reticle.visible) return;
    quadrat.position.setFromMatrixPosition(reticle.matrix);
    quadrat.visible = true;
  });

  renderer.setAnimationLoop((_t, frame) => {
    if (frame) {
      const hits = frame.getHitTestResults(hitTestSource);
      if (hits.length) {
        const pose = hits[0].getPose(localSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      } else {
        reticle.visible = false;
      }
    }
    renderer.render(scene, camera);
  });
}
