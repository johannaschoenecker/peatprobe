"""Shared dNBR helpers.

The important one is perimeter_mask(). GEE's Export.image.toDrive writes
masked-out pixels as 0 and sets no nodata value, so a clipped image arrives as
a full rectangle in which everything outside the fire reads as dNBR = 0. Taken
at face value that is ~78% of a typical export claiming to be "unburned", which
inflates every area figure and paints severity across the whole bounding box.

Cutting each raster to its own perimeter fixes it locally, with no re-export.
"""

import os

from osgeo import gdal

gdal.UseExceptions()

NODATA = -32768

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
FIRES_DIR = os.path.join(_ROOT, 'data', 'fires')


def perimeter_path(fire_id):
    return os.path.join(FIRES_DIR, f'{fire_id}.geojson')


def cut_to_perimeter(ds, fire_id):
    """Return a MEM dataset on the same grid, nodata outside the perimeter.

    Falls back to the original dataset if no perimeter file exists, so callers
    still work on a partial checkout - but they should treat that as suspect.
    """
    path = perimeter_path(fire_id)
    if not os.path.exists(path):
        return ds, False

    gt = ds.GetGeoTransform()
    bounds = (gt[0], gt[3] + ds.RasterYSize * gt[5],
              gt[0] + ds.RasterXSize * gt[1], gt[3])
    # Warp (rather than Rasterize) because it reprojects the cutline itself -
    # the perimeters are EPSG:4326 and the rasters EPSG:3857.
    out = gdal.Warp('', ds, format='MEM',
                    cutlineDSName=path, cropToCutline=False,
                    outputBounds=bounds,
                    width=ds.RasterXSize, height=ds.RasterYSize,
                    dstNodata=NODATA, resampleAlg='near')
    return out, True
