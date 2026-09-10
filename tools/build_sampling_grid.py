#!/usr/bin/env python3
"""Generate a 100 m sampling grid for every fire perimeter.

For each fire, a lattice of points 100 m apart, aligned to the Ordnance
Survey National Grid (EPSG:27700) - so a point's ID *is* its OS easting and
northing, it stays identical across rebuilds, and neighbouring fires share
one consistent lattice. Volunteers navigate to a point, sample there, and the
measurement records which grid node it belongs to.

Method: rasterise each perimeter onto the global 100 m OS lattice and keep
the centres of burned cells. GDAL burns a cell when its centre is inside the
polygon, which is exactly the membership rule we want - no per-point
point-in-polygon loop. A fire too small to catch any cell centre gets its
PointOnSurface as a single fallback node, so every burn scar has at least one
sampling point.

Each node also carries its dNBR burn-severity class (0 regrowth .. 5 high,
-1 where no severity raster exists), sampled from data/source/dnbr - so the
app can colour the grid by severity with no raster work on the phone.

Input:  data/fires/<id>.geojson         (detail perimeters, EPSG:4326)
        data/source/dnbr/dnbr_<id>.tif  (optional, Int16 dNBR x1000, EPSG:3857)
Output: data/grid/<id>.json             {spacing, points: [[e, n, lat, lon, sev], ...]}
        (id of a point = "E<e> N<n>", derived, not stored)

Run with QGIS's interpreter:
  PYTHONHOME='/c/Program Files/QGIS 3.32.3/apps/Python39' \
  '/c/Program Files/QGIS 3.32.3/bin/python3.exe' tools/build_sampling_grid.py
"""

import glob
import json
import os
import sys

try:
    from osgeo import gdal, ogr, osr
    import numpy as np
except ImportError:
    sys.exit("Needs GDAL python bindings - use QGIS's interpreter (see docstring).")

gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIRES_DIR = os.path.join(ROOT, 'data', 'fires')
DNBR_DIR = os.path.join(ROOT, 'data', 'source', 'dnbr')

# dNBR x1000 upper bounds -> severity slot; matches build_dnbr_overlays.py.
SEV_BOUNDS = [(-100, 0), (100, 1), (270, 2), (440, 3), (660, 4), (10 ** 9, 5)]
OUT_DIR = os.path.join(ROOT, 'data', 'grid')

SPACING = 100  # metres, on the OSGB lattice

wgs = osr.SpatialReference(); wgs.ImportFromEPSG(4326)
bng = osr.SpatialReference(); bng.ImportFromEPSG(27700)
merc = osr.SpatialReference(); merc.ImportFromEPSG(3857)
for s in (wgs, bng, merc):
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
TO_BNG = osr.CoordinateTransformation(wgs, bng)
TO_WGS = osr.CoordinateTransformation(bng, wgs)
TO_MERC = osr.CoordinateTransformation(wgs, merc)


class SeveritySampler:
    """Classify nodes against a fire's dNBR raster; -1 when there is none.

    Nodes are inside the perimeter by construction, so GEE's uncut zeros
    outside the perimeter are never sampled and no cutline is needed."""

    def __init__(self, fid):
        path = os.path.join(DNBR_DIR, f'dnbr_{fid}.tif')
        self.arr = None
        if os.path.exists(path):
            ds = gdal.Open(path)
            self.arr = ds.GetRasterBand(1).ReadAsArray()
            self.gt = ds.GetGeoTransform()
            self.w, self.h = ds.RasterXSize, ds.RasterYSize

    def classify(self, lat, lon):
        if self.arr is None:
            return -1
        x, y, _ = TO_MERC.TransformPoint(lon, lat)
        col = int((x - self.gt[0]) / self.gt[1])
        row = int((y - self.gt[3]) / self.gt[5])
        if not (0 <= col < self.w and 0 <= row < self.h):
            return -1
        v = float(self.arr[row, col])
        for upper, slot in SEV_BOUNDS:
            if v < upper:
                return slot
        return -1


def grid_for(geom_bng):
    """Grid-node (e, n) pairs whose cell centre falls inside the geometry."""
    x0, x1, y0, y1 = geom_bng.GetEnvelope()
    e0 = int(x0 // SPACING) * SPACING
    n0 = int(y0 // SPACING) * SPACING
    e1 = int(x1 // SPACING + 1) * SPACING
    n1 = int(y1 // SPACING + 1) * SPACING
    w = (e1 - e0) // SPACING
    h = (n1 - n0) // SPACING
    if w <= 0 or h <= 0 or w * h > 4_000_000:
        return []

    drv = ogr.GetDriverByName('Memory').CreateDataSource('')
    lyr = drv.CreateLayer('f', srs=bng, geom_type=ogr.wkbMultiPolygon)
    feat = ogr.Feature(lyr.GetLayerDefn())
    feat.SetGeometry(geom_bng)
    lyr.CreateFeature(feat)

    mem = gdal.GetDriverByName('MEM').Create('', w, h, 1, gdal.GDT_Byte)
    mem.SetGeoTransform((e0, SPACING, 0, n1, 0, -SPACING))
    mem.SetProjection(bng.ExportToWkt())
    gdal.RasterizeLayer(mem, [1], lyr, burn_values=[1])
    a = mem.GetRasterBand(1).ReadAsArray()

    rows, cols = np.nonzero(a)
    # Cell [row, col] spans east e0+col*S .. +S; its centre is the node.
    es = e0 + cols * SPACING + SPACING // 2
    ns = n1 - rows * SPACING - SPACING // 2
    return list(zip(es.tolist(), ns.tolist()))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for stale in glob.glob(os.path.join(OUT_DIR, '*.json')):
        os.remove(stale)

    files = sorted(glob.glob(os.path.join(FIRES_DIR, '*.geojson')))
    if not files:
        sys.exit(f'no perimeters in {FIRES_DIR}')

    total_pts, fallbacks, biggest = 0, 0, (0, None)
    for path in files:
        fid = os.path.splitext(os.path.basename(path))[0]
        ds = ogr.Open(path)
        feat = ds.GetLayer(0).GetNextFeature()
        if feat is None:
            continue
        geom = feat.GetGeometryRef().Clone()
        geom.Transform(TO_BNG)

        nodes = grid_for(geom)
        if not nodes:
            # Too small for any cell centre: one representative point instead.
            p = geom.PointOnSurface()
            nodes = [(int(round(p.GetX())), int(round(p.GetY())))]
            fallbacks += 1

        sampler = SeveritySampler(fid)
        pts = []
        for e, n in nodes:
            lon, lat, _ = TO_WGS.TransformPoint(float(e), float(n))
            pts.append([e, n, round(lat, 6), round(lon, 6),
                        sampler.classify(lat, lon)])

        with open(os.path.join(OUT_DIR, f'{fid}.json'), 'w', encoding='utf-8') as fh:
            json.dump({'spacing': SPACING, 'crs': 'EPSG:27700', 'points': pts},
                      fh, separators=(',', ':'))
        total_pts += len(pts)
        if len(pts) > biggest[0]:
            biggest = (len(pts), fid)

    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(OUT_DIR, '*.json')))
    print(f'  {len(files)} fires -> {total_pts} grid points '
          f'({fallbacks} tiny fires got a single fallback point)')
    print(f'  largest: {biggest[1]} with {biggest[0]} points; '
          f'total {size / 1048576:.1f} MB of JSON')


if __name__ == '__main__':
    main()
