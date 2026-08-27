#!/usr/bin/env python3
"""Delete fully transparent tiles from an XYZ tile directory.

gdal2tiles writes a tile for every cell in the raster's bounding box, and the
UK bbox is mostly sea - about 43% of the CORINE tiles carry no pixels at all.
Removing them keeps the repository navigable and shrinks the GitHub Pages
deployment. The app treats a missing overlay tile as "no coverage here", which
is exactly what these tiles mean.

Only tiles under --max-bytes are decoded, since a tile with real content never
compresses that small; that keeps this fast over tens of thousands of files.

Usage: python3 prune_blank_tiles.py data/corine [--max-bytes 800] [--dry-run]
"""

import argparse
import os
import struct
import sys
import zlib


def alpha_is_all_zero(path):
    """True if every pixel in this PNG has alpha 0. None if not decodable."""
    try:
        d = open(path, 'rb').read()
        if d[:8] != b'\x89PNG\r\n\x1a\n':
            return None
        pos, idat, ihdr = 8, b'', None
        while pos + 8 <= len(d):
            ln = struct.unpack('>I', d[pos:pos + 4])[0]
            typ = d[pos + 4:pos + 8]
            if typ == b'IHDR':
                ihdr = struct.unpack('>IIBBBBB', d[pos + 8:pos + 21])
            elif typ == b'IDAT':
                idat += d[pos + 8:pos + 8 + ln]
            elif typ == b'IEND':
                break
            pos += 12 + ln
        if not ihdr:
            return None
        w, h, bitdepth, colourtype = ihdr[0], ihdr[1], ihdr[2], ihdr[3]
        # Only greyscale+alpha (4) and RGBA (6) carry an alpha channel; anything
        # else cannot be "fully transparent" and must be kept.
        if colourtype not in (4, 6) or bitdepth != 8:
            return False
        channels = 4 if colourtype == 6 else 2
        raw = zlib.decompress(idat)
        stride = w * channels
        for y in range(h):
            off = y * (stride + 1)
            filt = raw[off]
            row = raw[off + 1:off + 1 + stride]
            # A non-zero filter byte means the row is delta-encoded against its
            # neighbours; un-filtering is not worth it here, so be conservative
            # and keep the tile.
            if filt != 0:
                return False
            if any(row[x * channels + channels - 1] for x in range(w)):
                return False
        return True
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tiledir')
    ap.add_argument('--max-bytes', type=int, default=800,
                    help='only inspect tiles at or below this size (default 800)')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    if not os.path.isdir(a.tiledir):
        print(f'not a directory: {a.tiledir}')
        return 1

    checked = removed = freed = kept_small = 0
    for root, _dirs, files in os.walk(a.tiledir):
        for name in files:
            if not name.endswith('.png'):
                continue
            p = os.path.join(root, name)
            size = os.path.getsize(p)
            if size > a.max_bytes:
                continue
            checked += 1
            if alpha_is_all_zero(p):
                removed += 1
                freed += size
                if not a.dry_run:
                    os.remove(p)
            else:
                kept_small += 1

    # Tidy up directories the pruning emptied.
    if not a.dry_run:
        for root, dirs, files in os.walk(a.tiledir, topdown=False):
            if not os.listdir(root) and os.path.abspath(root) != os.path.abspath(a.tiledir):
                os.rmdir(root)

    verb = 'would remove' if a.dry_run else 'removed'
    print(f'  inspected {checked} small tiles, {verb} {removed} blank '
          f'({freed / 1048576:.1f} MB), kept {kept_small}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
