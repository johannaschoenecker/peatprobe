#!/usr/bin/env python3
"""Turn per-fire dNBR GeoTIFFs into PNG overlays the app can pack offline.

Input:  data/source/dnbr/dnbr_<fireid>.tif   (Int16, dNBR x1000, EPSG:3857)
Output: data/dnbr/<fireid>.png               (RGBA severity image)
        data/dnbr/index.json                 (bounds + stats per fire)

Why PNG overlays and not a tile pyramid: the burn scars total ~800 km^2
scattered across the whole UK. A global pyramid would be almost entirely empty
tiles. One small image per fire, dropped into that fire's field pack, is a far
better fit - and because the source is already EPSG:3857 and Leaflet's map is
EPSG:3857, an ImageOverlay stretched between the projected corners is exact
rather than approximate.

Severity classes are Key & Benson (2006). They are calibrated on North
American forest, NOT on blanket bog - treat the colours as relative severity
and a sampling stratifier, not as a measure of peat consumption.

Run:  python3 tools/build_dnbr_overlays.py
      (needs GDAL python bindings; build_corine_tiles.sh shows how to find
       QGIS's interpreter if your system python lacks them)
"""

import glob
import json
import os
import re
import sys

try:
    from osgeo import gdal, osr
except ImportError:
    sys.exit("GDAL python bindings not found. Try QGIS's interpreter:\n"
             "  PYTHONHOME='/c/Program Files/QGIS 3.32.3/apps/Python39' \\\n"
             "  '/c/Program Files/QGIS 3.32.3/bin/python3.exe' tools/build_dnbr_overlays.py")

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(ROOT, 'data', 'source', 'dnbr')
OUT_DIR = os.path.join(ROOT, 'data', 'dnbr')

# (upper bound exclusive, label, R, G, B, A). dNBR x1000.
# Unburned is deliberately faint: inside a perimeter it is common and should
# not paint over the basemap.
CLASSES = [
    (-250,   'regrowth_high',  26, 150,  65, 190),
    (-100,   'regrowth_low',  145, 207,  96, 170),
    ( 100,   'unburned',      217, 217, 217,  70),
    ( 270,   'low',           254, 224, 139, 210),
    ( 440,   'moderate_low',  252, 141,  89, 215),
    ( 660,   'moderate_high', 227,  74,  51, 225),
    ( 10**9, 'high',          127,   0,   0, 235),
]


def wgs84_bounds(ds):
    """Corner bounds as [[south, west], [north, east]] for L.imageOverlay."""
    gt = ds.GetGeoTransform()
    w, h = ds.RasterXSize, ds.RasterYSize
    x0, y0 = gt[0], gt[3]
    x1, y1 = gt[0] + w * gt[1], gt[3] + h * gt[5]

    src = osr.SpatialReference()
    src.ImportFromWkt(ds.GetProjection())
    dst = osr.SpatialReference()
    dst.ImportFromEPSG(4326)
    # Without this GDAL 3 returns lat,lon for EPSG:4326 and the overlay lands
    # in the Indian Ocean.
    dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(src, dst)

    lon0, lat0, _ = tr.TransformPoint(x0, y0)
    lon1, lat1, _ = tr.TransformPoint(x1, y1)
    south, north = sorted((lat0, lat1))
    west, east = sorted((lon0, lon1))
    return [[south, west], [north, east]]


def convert(path):
    fire_id = re.sub(r'^dnbr_', '', os.path.splitext(os.path.basename(path))[0])
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray()
    if arr is None:
        return None
    nodata = band.GetNoDataValue()

    h, w = arr.shape
    import numpy as np
    a = arr.astype('float32')
    valid = np.isfinite(a)
    if nodata is not None:
        valid &= (a != nodata)
    # GEE writes 0 where the median composite had no usable pixels; those are
    # indistinguishable from a genuine dNBR of exactly 0, but a whole-tile
    # block of them means "no imagery", not "no change".
    if not valid.any():
        return None

    rgba = np.zeros((4, h, w), dtype='uint8')
    lower = -10 ** 9
    for upper, _label, r, g, b, al in CLASSES:
        m = valid & (a >= lower) & (a < upper)
        rgba[0][m], rgba[1][m], rgba[2][m], rgba[3][m] = r, g, b, al
        lower = upper

    mem = gdal.GetDriverByName('MEM').Create('', w, h, 4, gdal.GDT_Byte)
    for i in range(4):
        mem.GetRasterBand(i + 1).WriteArray(rgba[i])
    out_png = os.path.join(OUT_DIR, f'{fire_id}.png')
    gdal.GetDriverByName('PNG').CreateCopy(out_png, mem, strict=0)
    mem = None

    vals = a[valid]
    total = int(valid.sum())
    # Fraction at moderate-high or above: the number worth stratifying on.
    severe = float((vals >= 440).sum()) / total if total else 0.0
    return {
        'id': fire_id,
        'bounds': wgs84_bounds(ds),
        'size': [w, h],
        'px': total,
        'dnbr_mean': round(float(vals.mean()), 1),
        'dnbr_p90': round(float(np.percentile(vals, 90)), 1),
        'severe_frac': round(severe, 3),
        'bytes': os.path.getsize(out_png),
    }


def main():
    if not os.path.isdir(SRC_DIR):
        sys.exit(f'no source directory: {SRC_DIR}')
    os.makedirs(OUT_DIR, exist_ok=True)
    for stale in glob.glob(os.path.join(OUT_DIR, '*.png')):
        os.remove(stale)

    tifs = sorted(glob.glob(os.path.join(SRC_DIR, '*.tif')))
    if not tifs:
        sys.exit(f'no .tif files in {SRC_DIR}')

    entries, skipped = {}, []
    for p in tifs:
        try:
            e = convert(p)
        except Exception as err:
            skipped.append((os.path.basename(p), str(err)[:70]))
            continue
        if e is None:
            skipped.append((os.path.basename(p), 'no valid pixels'))
        else:
            entries[e['id']] = e

    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'version': 1, 'classes': [c[1] for c in CLASSES],
                   'fires': entries}, fh, separators=(',', ':'))

    total_bytes = sum(e['bytes'] for e in entries.values())
    print(f'  converted {len(entries)} of {len(tifs)} rasters, '
          f'{total_bytes / 1048576:.1f} MB of PNGs')
    if entries:
        sev = sorted(entries.values(), key=lambda e: -e['severe_frac'])[:3]
        print('  most severe:', ', '.join(
            f"{e['id']} ({e['severe_frac'] * 100:.0f}%)" for e in sev))
    for name, why in skipped[:8]:
        print(f'  skipped {name}: {why}')
    if len(skipped) > 8:
        print(f'  ... and {len(skipped) - 8} more skipped')


if __name__ == '__main__':
    main()
