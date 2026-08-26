#!/usr/bin/env python3
"""Generate icons/logo.svg.

Heather (Calluna vulgaris) with its root system exposed by burnt-away peat,
and a measure from the root collar - which marks the pre-fire surface - down
to what is left.

Florets are placed along each shoot by walking the curve, because heather
carries its flowers ALONG the upper stem rather than in a ball at the tip.
That distinction is what stops it reading as lavender or as a small tree.

Usage: python3 tools/make_logo.py
"""

import math
import os

# ── composition ───────────────────────────────────────────────────────────
COLLAR = (78.0, 52.0)   # root collar = pre-fire peat surface
SURFACE_Y = 78.0        # burnt surface today
ARROW_X = 38.0

# Each shoot: (control point, tip). Heather is a DENSE clump of near-upright
# wiry shoots, not a wide radiating fan - splaying them too far reads as
# scattered speckle at icon size rather than as one plant.
SHOOTS = [
    ((71, 40), (66, 24)),
    ((74, 35), (71, 18)),
    ((77, 32), (76, 15)),
    ((80, 32), (82, 15)),
    ((83, 35), (88, 19)),
    ((86, 40), (93, 26)),
]

# Roots: (control, tip, width)
ROOTS = [
    ((68, 60), (56, 80), 4.2),
    ((74, 63), (70, 84), 3.6),
    ((82, 63), (86, 83), 3.6),
    ((88, 60), (99, 79), 3.2),
    ((72, 57), (62, 67), 2.2),
    ((85, 57), (94, 65), 2.2),
]

FLOWER = "#A85BA8"
FLOWER_HI = "#CE93CE"
FLOWER_LO = "#7E4189"
LEAF = "#4F6B3C"


def qbez(p0, p1, p2, t):
    """Point on a quadratic Bezier."""
    u = 1 - t
    return (u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1])


def perp(p0, p1, p2, t):
    """Unit normal, so florets and leaves sit either side of the stem."""
    u = 1 - t
    dx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0])
    dy = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1])
    n = math.hypot(dx, dy) or 1.0
    return (-dy / n, dx / n)


def build():
    out = []
    add = out.append

    add('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" '
        'role="img" aria-label="PeatProbe">')

    # ── defs ──
    add('  <defs>')
    add('    <clipPath id="pp-clip"><circle cx="64" cy="64" r="58"/></clipPath>')
    grads = [
        ('pp-sky', 0, 6, 0, 90, [('0', '#2E5FA3'), ('1', '#7FD4CD')]),
        ('pp-char', 0, 74, 0, 92, [('0', '#3A2154'), ('1', '#241B3D')]),
        ('pp-s1', 0, 92, 0, 104, [('0', '#E8478B'), ('1', '#F2663C')]),
        ('pp-s2', 0, 104, 0, 114, [('0', '#F79A3E'), ('1', '#FFB347')]),
        ('pp-s3', 0, 114, 0, 128, [('0', '#2E3192'), ('1', '#1B1B4D')]),
        # userSpaceOnUse throughout: several stems are near-vertical lines whose
        # object bounding box has zero width, and an objectBoundingBox gradient
        # silently fails to paint on those.
        ('pp-wood', 0, 14, 0, 94, [('0', '#9A6B4A'), ('.45', '#7A4A33'), ('1', '#5E3327')]),
    ]
    for gid, x1, y1, x2, y2, stops in grads:
        add(f'    <linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
            f'x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">')
        for off, col in stops:
            add(f'      <stop offset="{off}" stop-color="{col}"/>')
        add('    </linearGradient>')
    add('  </defs>')

    add('  <circle cx="64" cy="64" r="58" fill="url(#pp-sky)"/>')
    add('  <g clip-path="url(#pp-clip)">')

    # ── cloud ──
    # Pale cyan, not pink: a pink cloud sits in the same colour family as the
    # florets and the eye reads it as a second flowering clump.
    add('    <g fill="#CFEDE8" opacity=".62">')
    add('      <circle cx="22" cy="30" r="9"/><circle cx="34" cy="26" r="11"/>')
    add('      <rect x="22" y="28" width="12" height="9"/>')
    add('    </g>')

    # ── roots (drawn before the ground so their tips are buried) ──
    add('    <g stroke="url(#pp-wood)" stroke-linecap="round" fill="none">')
    for ctrl, tip, w in ROOTS:
        add(f'      <path d="M{COLLAR[0]},{COLLAR[1]} Q{ctrl[0]},{ctrl[1]} '
            f'{tip[0]},{tip[1]}" stroke-width="{w}"/>')
    add('    </g>')

    # ── woody base ──
    add(f'    <ellipse cx="{COLLAR[0]}" cy="{COLLAR[1]}" rx="7" ry="4" fill="#6E3E2C"/>')

    # ── shoots ──
    add('    <g stroke="url(#pp-wood)" stroke-linecap="round" fill="none">')
    for ctrl, tip in SHOOTS:
        add(f'      <path d="M{COLLAR[0]},{COLLAR[1]} Q{ctrl[0]},{ctrl[1]} '
            f'{tip[0]},{tip[1]}" stroke-width="2.6"/>')
    add('    </g>')

    # ── fine foliage low on the stems: the heather/lavender tell ──
    add(f'    <g stroke="{LEAF}" stroke-width="1.9" stroke-linecap="round">')
    for ctrl, tip in SHOOTS:
        t = 0.14
        while t < 0.40:
            px, py = qbez(COLLAR, ctrl, tip, t)
            nx, ny = perp(COLLAR, ctrl, tip, t)
            for s in (1, -1):
                add(f'      <line x1="{px:.1f}" y1="{py:.1f}" '
                    f'x2="{px + nx * 2.4 * s:.1f}" y2="{py + ny * 2.4 * s - 1.0:.1f}"/>')
            t += 0.13
    add('    </g>')

    # ── florets along the upper stem ──
    add('    <g>')
    for ctrl, tip in SHOOTS:
        t = 0.40
        side = 1
        # Tight spacing so the florets merge into a spike rather than reading
        # as loose dots once the icon is scaled down.
        while t <= 1.001:
            px, py = qbez(COLLAR, ctrl, tip, t)
            nx, ny = perp(COLLAR, ctrl, tip, t)
            off = 1.25 * side
            cx, cy = px + nx * off, py + ny * off
            r = 3.1 - 1.0 * t          # florets taper toward the tip
            add(f'      <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{FLOWER_LO}"/>')
            add(f'      <circle cx="{cx - 0.5:.1f}" cy="{cy - 0.5:.1f}" '
                f'r="{r - 0.7:.1f}" fill="{FLOWER}"/>')
            add(f'      <circle cx="{cx - 0.8:.1f}" cy="{cy - 0.9:.1f}" '
                f'r="{max(0.6, r - 1.7):.1f}" fill="{FLOWER_HI}"/>')
            side *= -1
            t += 0.072
    add('    </g>')

    # ── burnt surface and strata ──
    add(f'    <path d="M-6,80 L20,76 L46,82 L74,75 L100,81 L134,76 L134,92 L-6,92 Z" '
        f'fill="url(#pp-char)"/>')
    add('    <rect x="-6" y="92" width="140" height="12" fill="url(#pp-s1)"/>')
    add('    <rect x="-6" y="104" width="140" height="10" fill="url(#pp-s2)"/>')
    add('    <rect x="-6" y="114" width="140" height="16" fill="url(#pp-s3)"/>')

    # ── burn-depth measure ──
    a, top, bot = ARROW_X, COLLAR[1], SURFACE_Y
    add('    <g stroke="#FFF6E4" stroke-linecap="round" stroke-linejoin="round" fill="none">')
    add(f'      <line x1="{a - 10}" y1="{top}" x2="{a + 9}" y2="{top}" stroke-width="3" opacity=".92"/>')
    add(f'      <line x1="{a - 10}" y1="{bot}" x2="{a + 9}" y2="{bot}" stroke-width="3" opacity=".92"/>')
    add(f'      <line x1="{a}" y1="{top}" x2="{a}" y2="{bot}" stroke-width="4"/>')
    add(f'      <polyline points="{a - 6},{top + 6} {a},{top - 1} {a + 6},{top + 6}" stroke-width="4"/>')
    add(f'      <polyline points="{a - 6},{bot - 6} {a},{bot + 1} {a + 6},{bot - 6}" stroke-width="4"/>')
    add('    </g>')

    add('  </g>')
    add('  <circle cx="64" cy="64" r="58" fill="none" stroke="#1B1B4D" stroke-width="5"/>')
    add('</svg>')
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', 'icons', 'logo.svg')
    svg = build()
    with open(dest, 'w', encoding='utf-8') as fh:
        fh.write(svg)
    print(f'wrote {os.path.normpath(dest)} ({len(svg)} bytes)')
