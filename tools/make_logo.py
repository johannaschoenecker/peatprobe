#!/usr/bin/env python3
"""Generate icons/logo.svg.

A modern flat illustration: a heather plant growing on peat, its roots visible
in the peat profile beneath, and a flame set back in the background.

Palette is natural rather than graphic - peat browns, heather mauve, olive
foliage, a warm flame - so the mark reads as a field science tool.

Florets are placed by walking each shoot curve, because heather carries its
flowers ALONG the upper stem rather than in a ball at the tip. That, plus the
fine foliage low down, is what stops it reading as lavender.

Usage: python3 tools/make_logo.py
"""

import math
import os

# ── composition ───────────────────────────────────────────────────────────
GROUND_Y = 78.0          # top of the peat
COLLAR = (57.0, 77.0)    # where the plant meets the ground

# Each shoot: (control point, tip). A dense clump of near-upright wiry stems.
SHOOTS = [
    ((47, 63), (41, 45)),
    ((51, 58), (47, 36)),
    ((55, 54), (54, 30)),
    ((59, 54), (62, 29)),
    ((63, 57), (69, 34)),
    ((67, 62), (75, 43)),
]

# Roots: (control, tip, width). Drawn over the strata so they read as a cutaway.
ROOTS = [
    ((49, 86), (39, 104), 3.6),
    ((54, 90), (49, 110), 3.2),
    ((60, 90), (66, 109), 3.2),
    ((65, 86), (76, 101), 2.8),
    ((51, 83), (44, 92),  2.0),
    ((63, 83), (71, 90),  2.0),
]

SKY_TOP, SKY_BOT = '#E9E2D6', '#D3DCDC'
FLAME_OUT, FLAME_IN = '#F0A354', '#F6C877'
FLORET, FLORET_HI, FLORET_LO = '#9B5FA8', '#C08FC9', '#77448A'
LEAF = '#55703F'


def qbez(p0, p1, p2, t):
    u = 1 - t
    return (u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1])


def perp(p0, p1, p2, t):
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

    add('  <defs>')
    add('    <clipPath id="pp-clip"><circle cx="64" cy="64" r="58"/></clipPath>')
    # userSpaceOnUse throughout: several shoots are near-vertical lines whose
    # object bounding box has zero width, and an objectBoundingBox gradient
    # silently fails to paint on those.
    grads = [
        ('pp-sky',   6,  80,  SKY_TOP,   SKY_BOT),
        ('pp-flame', 20, 92,  FLAME_IN,  FLAME_OUT),
        ('pp-p1',    78, 94,  '#6E4C34', '#5C3F2B'),
        ('pp-p2',    94, 108, '#4C3421', '#3E2A1B'),
        ('pp-p3',   108, 126, '#332317', '#2B1D13'),
        ('pp-wood',  74, 112, '#8A5A3B', '#5A3726'),
    ]
    for gid, y1, y2, c0, c1 in grads:
        add(f'    <linearGradient id="{gid}" gradientUnits="userSpaceOnUse" '
            f'x1="0" y1="{y1}" x2="0" y2="{y2}">')
        add(f'      <stop offset="0" stop-color="{c0}"/>')
        add(f'      <stop offset="1" stop-color="{c1}"/>')
        add('    </linearGradient>')
    add('  </defs>')

    add('  <circle cx="64" cy="64" r="58" fill="url(#pp-sky)"/>')
    add('  <g clip-path="url(#pp-clip)">')

    # ── flame, set back behind the plant ──
    # Large, faint, and positioned so the heather crosses in front of it. A
    # solid flame beside the plant reads as a second subject competing for
    # attention rather than as background.
    add('    <path d="M70,13 C80,38 93,50 93,67 C93,81 83,91 70,91 '
        'C57,91 47,81 47,67 C47,52 62,45 65,29 C68,46 68,36 70,13 Z" '
        'fill="url(#pp-flame)" opacity=".42"/>')
    add('    <path d="M71,42 C77,57 84,64 84,72 C84,81 78,87 71,87 '
        'C64,87 58,81 58,72 C58,66 66,62 68,52 C70,63 70,56 71,42 Z" '
        f'fill="{FLAME_IN}" opacity=".34"/>')

    # ── peat profile ──
    add(f'    <path d="M-6,{GROUND_Y+2} L22,{GROUND_Y-3} L50,{GROUND_Y+1} '
        f'L78,{GROUND_Y-4} L104,{GROUND_Y+1} L134,{GROUND_Y-3} L134,94 L-6,94 Z" '
        'fill="url(#pp-p1)"/>')
    add('    <rect x="-6" y="94" width="140" height="14" fill="url(#pp-p2)"/>')
    add('    <rect x="-6" y="108" width="140" height="20" fill="url(#pp-p3)"/>')
    # charred skin at the surface
    add(f'    <path d="M-6,{GROUND_Y+2} L22,{GROUND_Y-3} L50,{GROUND_Y+1} '
        f'L78,{GROUND_Y-4} L104,{GROUND_Y+1} L134,{GROUND_Y-3} L134,{GROUND_Y-0.5} '
        f'L104,{GROUND_Y+3.5} L78,{GROUND_Y-1.5} L50,{GROUND_Y+3.5} L22,{GROUND_Y-0.5} L-6,{GROUND_Y+4.5} Z" '
        'fill="#2E241C" opacity=".75"/>')

    # ── roots, visible through the peat ──
    add('    <g stroke="url(#pp-wood)" stroke-linecap="round" fill="none" opacity=".92">')
    for ctrl, tip, w in ROOTS:
        add(f'      <path d="M{COLLAR[0]},{COLLAR[1]} Q{ctrl[0]},{ctrl[1]} '
            f'{tip[0]},{tip[1]}" stroke-width="{w}"/>')
    add('    </g>')

    # ── woody base ──
    add(f'    <ellipse cx="{COLLAR[0]}" cy="{COLLAR[1]}" rx="6.5" ry="3.4" fill="#6B4229"/>')

    # ── shoots ──
    add('    <g stroke="url(#pp-wood)" stroke-linecap="round" fill="none">')
    for ctrl, tip in SHOOTS:
        add(f'      <path d="M{COLLAR[0]},{COLLAR[1]} Q{ctrl[0]},{ctrl[1]} '
            f'{tip[0]},{tip[1]}" stroke-width="2.4"/>')
    add('    </g>')

    # ── fine foliage low on the stems ──
    add(f'    <g stroke="{LEAF}" stroke-width="1.8" stroke-linecap="round">')
    for ctrl, tip in SHOOTS:
        t = 0.16
        while t < 0.44:
            px, py = qbez(COLLAR, ctrl, tip, t)
            nx, ny = perp(COLLAR, ctrl, tip, t)
            for s in (1, -1):
                add(f'      <line x1="{px:.1f}" y1="{py:.1f}" '
                    f'x2="{px + nx * 2.3 * s:.1f}" y2="{py + ny * 2.3 * s - 0.9:.1f}"/>')
            t += 0.14
    add('    </g>')

    # ── florets along the upper stem ──
    add('    <g>')
    for ctrl, tip in SHOOTS:
        t, side = 0.44, 1
        while t <= 1.001:
            px, py = qbez(COLLAR, ctrl, tip, t)
            nx, ny = perp(COLLAR, ctrl, tip, t)
            cx, cy = px + nx * 1.2 * side, py + ny * 1.2 * side
            r = 3.0 - 1.0 * t
            add(f'      <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{FLORET_LO}"/>')
            add(f'      <circle cx="{cx - 0.5:.1f}" cy="{cy - 0.5:.1f}" '
                f'r="{r - 0.7:.1f}" fill="{FLORET}"/>')
            add(f'      <circle cx="{cx - 0.8:.1f}" cy="{cy - 0.9:.1f}" '
                f'r="{max(0.55, r - 1.7):.1f}" fill="{FLORET_HI}"/>')
            side *= -1
            t += 0.075
    add('    </g>')

    add('  </g>')
    add('  <circle cx="64" cy="64" r="58" fill="none" stroke="#3A2A1E" stroke-width="4.5"/>')
    add('</svg>')
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, '..', 'icons', 'logo.svg')
    svg = build()
    with open(dest, 'w', encoding='utf-8') as fh:
        fh.write(svg)
    print(f'wrote {os.path.normpath(dest)} ({len(svg)} bytes)')
