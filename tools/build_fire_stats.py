#!/usr/bin/env python3
"""Cross-tabulate land cover against burn severity, per fire.

Answers "which habitats burned here, and how severely" - the question the map
alone cannot. Output feeds the chart in the fire popup.

Input:  data/source/dnbr/dnbr_<id>.tif     (Int16, dNBR x1000, EPSG:3857)
        data/source/corine/corine_*.tif    (UInt16 CLC codes, EPSG:3857)
Output: data/dnbr/stats.json

Both rasters are EPSG:3857, so CORINE is warped onto each dNBR grid with
nearest-neighbour - never averaged, because averaging class codes invents
classes that do not exist.

Areas are true ground hectares: web-mercator metres are inflated by 1/cos(lat),
so a raw pixel count would overstate area by ~3x at Scottish latitudes.

Run with QGIS's interpreter (it has the GDAL bindings):
  PYTHONHOME='/c/Program Files/QGIS 3.32.3/apps/Python39' \
  '/c/Program Files/QGIS 3.32.3/bin/python3.exe' tools/build_fire_stats.py
"""

import glob
import json
import math
import os
import re
import sys

try:
    from osgeo import gdal, osr
    from dnbr_common import cut_to_perimeter, NODATA
    import numpy as np
except ImportError:
    sys.exit('Needs GDAL python bindings + numpy - use QGIS\'s interpreter (see docstring).')

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DNBR_DIR = os.path.join(ROOT, 'data', 'source', 'dnbr')
CORINE_GLOB = os.path.join(ROOT, 'data', 'source', 'corine', '*.tif')
OUT = os.path.join(ROOT, 'data', 'dnbr', 'stats.json')

# dNBR x1000 upper bounds -> severity slot. Matches build_dnbr_overlays.py.
SEV_BOUNDS = [(-100, 0), (100, 1), (270, 2), (440, 3), (660, 4), (10 ** 9, 5)]
SEV_LABELS = ['regrowth', 'unburned', 'low', 'moderate_low', 'moderate_high', 'high']

# CLC code -> the grouping used in the map legend. 44 classes is unreadable on
# a phone; these are the ones that matter for peat fire work.
LC_GROUPS = [
    ('Peat bogs',           {412}),
    ('Inland marshes',      {411}),
    ('Moors & heathland',   {322}),
    ('Natural grassland',   {321}),
    ('Transitional scrub',  {324}),
    ('Coniferous forest',   {312}),
    ('Broadleaved forest',  {311, 313}),
    ('Sparsely vegetated',  {331, 332, 333, 334, 335}),
    ('Pasture & arable',    {211, 212, 213, 221, 222, 223, 231, 241, 242, 243, 244}),
    ('Built-up',            {111, 112, 121, 122, 123, 124, 131, 132, 133, 141, 142}),
    ('Water & coastal',     {421, 422, 423, 511, 512, 521, 522, 523}),
]
LC_LABELS = [g[0] for g in LC_GROUPS] + ['Other']
CODE_TO_GROUP = {}
for i, (_lbl, codes) in enumerate(LC_GROUPS):
    for c in codes:
        CODE_TO_GROUP[c] = i
OTHER = len(LC_GROUPS)


def build_lut():
    """Lookup table over the CLC code range, so grouping is one array index."""
    lut = np.full(600, OTHER, dtype='uint8')
    for code, grp in CODE_TO_GROUP.items():
        lut[code] = grp
    return lut


def centre_lat(ds):
    gt = ds.GetGeoTransform()
    y = gt[3] + (ds.RasterYSize / 2) * gt[5]
    src = osr.SpatialReference(); src.ImportFromWkt(ds.GetProjection())
    dst = osr.SpatialReference(); dst.ImportFromEPSG(4326)
    for s in (src, dst):
        s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    x = gt[0] + (ds.RasterXSize / 2) * gt[1]
    lon, lat, _ = osr.CoordinateTransformation(src, dst).TransformPoint(x, y)
    return lat


def main():
    corine_files = sorted(glob.glob(CORINE_GLOB))
    if not corine_files:
        sys.exit(f'no CORINE raster in {os.path.dirname(CORINE_GLOB)}')
    corine_vrt = gdal.BuildVRT('', corine_files) if len(corine_files) > 1 \
        else gdal.Open(corine_files[0])

    lut = build_lut()
    tifs = sorted(glob.glob(os.path.join(DNBR_DIR, '*.tif')))
    if not tifs:
        sys.exit(f'no dNBR rasters in {DNBR_DIR}')

    fires, skipped = {}, 0
    for path in tifs:
        fid = re.sub(r'^dnbr_', '', os.path.splitext(os.path.basename(path))[0])
        src = gdal.Open(path)
        ds, cut = cut_to_perimeter(src, fid)
        band = ds.GetRasterBand(1)
        a = band.ReadAsArray()
        if a is None:
            skipped += 1
            continue
        a = a.astype('float32')
        valid = np.isfinite(a)
        nd = NODATA if cut else band.GetNoDataValue()
        if nd is not None:
            valid &= (a != nd)
        if not valid.any():
            skipped += 1
            continue

        gt = ds.GetGeoTransform()
        # Warp CORINE onto exactly this fire's grid.
        clc_ds = gdal.Warp('', corine_vrt, format='MEM',
                           outputBounds=(gt[0], gt[3] + ds.RasterYSize * gt[5],
                                         gt[0] + ds.RasterXSize * gt[1], gt[3]),
                           width=ds.RasterXSize, height=ds.RasterYSize,
                           dstSRS=ds.GetProjection(), resampleAlg='near')
        clc = clc_ds.GetRasterBand(1).ReadAsArray()
        clc = np.clip(np.nan_to_num(clc, nan=0).astype('int32'), 0, 599)
        groups = lut[clc]

        sev = np.full(a.shape, 255, dtype='uint8')
        lower = -10 ** 9
        for upper, slot in SEV_BOUNDS:
            sev[valid & (a >= lower) & (a < upper)] = slot
            lower = upper

        lat = centre_lat(ds)
        px_ha = (abs(gt[1]) * math.cos(math.radians(lat))) * \
                (abs(gt[5]) * math.cos(math.radians(lat))) / 10000.0

        matrix = {}
        for gi in range(OTHER + 1):
            gm = valid & (groups == gi)
            if not gm.any():
                continue
            row = [round(float((gm & (sev == s)).sum()) * px_ha, 2)
                   for s in range(len(SEV_LABELS))]
            if sum(row) > 0.005:
                matrix[LC_LABELS[gi]] = row

        if matrix:
            fires[fid] = {
                'total_ha': round(sum(sum(r) for r in matrix.values()), 2),
                'matrix': matrix,
            }
        else:
            skipped += 1

    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'version': 1, 'severity': SEV_LABELS, 'fires': fires},
                  fh, separators=(',', ':'))

    size = os.path.getsize(OUT) / 1024
    print(f'  {len(fires)} fires cross-tabulated, {skipped} skipped, stats.json {size:.0f} kB')
    if fires:
        top = sorted(fires.items(), key=lambda kv: -kv[1]['total_ha'])[:3]
        for fid, e in top:
            bog = e['matrix'].get('Peat bogs')
            frac = (sum(bog) / e['total_ha'] * 100) if bog else 0
            print(f"    {fid}: {e['total_ha']:.0f} ha, {frac:.0f}% on peat bog, "
                  f"classes {len(e['matrix'])}")


if __name__ == '__main__':
    main()
