#!/usr/bin/env python3
"""Generate icons/logo.svg.

Deliberately simple: one flame over layered peat, inside the circular badge.
No plant, no annotations - the mark has to read at favicon size, and the two
elements that define the project are the fire and the peat profile.

Usage: python3 tools/make_logo.py
"""

import os

GROUND_Y = 82

SKY_TOP, SKY_BOT = '#EBE4D7', '#D6DEDD'


def build():
    out = []
    add = out.append
    add('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" '
        'role="img" aria-label="PeatProbe">')

    add('  <defs>')
    add('    <clipPath id="pp-clip"><circle cx="64" cy="64" r="58"/></clipPath>')
    # userSpaceOnUse so the vertical gradients are stated in badge coordinates.
    grads = [
        ('pp-sky',    6,  84, SKY_TOP,   SKY_BOT),
        ('pp-flame', 16,  88, '#F2B35C', '#D96A2B'),
        ('pp-inner', 42,  86, '#F9E0A2', '#F2B35C'),
        ('pp-p1',    82,  97, '#6E4C34', '#5C3F2B'),
        ('pp-p2',    97, 110, '#4C3421', '#3E2A1B'),
        ('pp-p3',   110, 126, '#332317', '#281B12'),
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

    # ── flame, centred, base sunk just below the surface line ──
    add('    <path d="M64,16 C72,36 86,46 86,62 C86,77 76,87 64,87 '
        'C52,87 42,77 42,62 C42,48 56,42 59,28 C62,42 62,32 64,16 Z" '
        'fill="url(#pp-flame)"/>')
    add('    <path d="M65,42 C70,54 77,60 77,69 C77,78 71,84 65,84 '
        'C58,84 52,78 52,69 C52,63 59,59 61,50 C63,59 64,52 65,42 Z" '
        'fill="url(#pp-inner)"/>')

    # ── peat profile: three strata under a gently uneven, charred surface ──
    add(f'    <path d="M-6,{GROUND_Y+2} L24,{GROUND_Y-2} L52,{GROUND_Y+1} '
        f'L80,{GROUND_Y-2} L106,{GROUND_Y+1} L134,{GROUND_Y-2} L134,97 L-6,97 Z" '
        'fill="url(#pp-p1)"/>')
    add('    <rect x="-6" y="97" width="140" height="13" fill="url(#pp-p2)"/>')
    add('    <rect x="-6" y="110" width="140" height="18" fill="url(#pp-p3)"/>')
    # charred skin along the surface
    add(f'    <path d="M-6,{GROUND_Y+2} L24,{GROUND_Y-2} L52,{GROUND_Y+1} '
        f'L80,{GROUND_Y-2} L106,{GROUND_Y+1} L134,{GROUND_Y-2} L134,{GROUND_Y+1} '
        f'L106,{GROUND_Y+4} L80,{GROUND_Y+1} L52,{GROUND_Y+4} L24,{GROUND_Y+1} L-6,{GROUND_Y+5} Z" '
        'fill="#2A211A" opacity=".8"/>')

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
