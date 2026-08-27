#!/usr/bin/env bash
# Turn the CORINE GeoTIFF exported by tools/gee_corine.js into XYZ PNG tiles
# the app can serve and pack for offline use.
#
# Usage:
#   bash tools/build_corine_tiles.sh ~/Downloads/corine_2018_uk*.tif
#
# WINDOWS: run this from the OSGeo4W Shell (Start menu > QGIS > OSGeo4W Shell),
# then "bash tools/build_corine_tiles.sh ...". gdal2tiles needs GDAL's own
# Python, which does not work when QGIS/bin is merely prepended to PATH in
# Git Bash - it fails with "No module named 'encodings'".
#
# Output: data/corine/{z}/{x}/{y}.png  (roughly 2,600 tiles, ~5 MB)
# Then set LAYERS.corineAvailable = true in js/config.js.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HERE/data/corine"
COLORS="$HERE/tools/corine_colors.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# CORINE is 100 m with a 25 ha minimum mapping unit. At z11 a pixel is ~44 m
# on the ground, already finer than the source; tiling further just stores
# blurrier copies. Leaflet upscales past this via maxNativeZoom.
MIN_Z=6
MAX_Z=11

[ $# -ge 1 ] || { echo "Usage: bash tools/build_corine_tiles.sh <corine tif(s)>"; exit 1; }
command -v gdaldem >/dev/null || { echo "gdaldem not found - run from the OSGeo4W Shell."; exit 1; }
[ -f "$COLORS" ] || { echo "Missing $COLORS"; exit 1; }

# Find gdal2tiles however it is packaged on this machine.
if command -v gdal2tiles.py >/dev/null; then
  G2T() { gdal2tiles.py "$@"; }
elif command -v gdal2tiles >/dev/null; then
  G2T() { gdal2tiles "$@"; }
elif python -c "import osgeo_utils.gdal2tiles" 2>/dev/null; then
  G2T() { python -m osgeo_utils.gdal2tiles "$@"; }
else
  echo "gdal2tiles not found. Run this from the OSGeo4W Shell."; exit 1
fi

echo "1/3  Assembling input…"
if [ $# -gt 1 ]; then
  # GEE splits large exports into several GeoTIFFs.
  gdalbuildvrt "$WORK/clc.vrt" "$@"
  SRC="$WORK/clc.vrt"
else
  SRC="$1"
fi

echo "2/3  Applying the CLC palette…"
# -nearest_color_entry is essential: without it gdaldem interpolates between
# class codes and invents colours for classes that do not exist.
gdaldem color-relief "$SRC" "$COLORS" "$WORK/clc_rgba.tif" \
  -alpha -nearest_color_entry -co COMPRESS=DEFLATE -co TILED=YES

echo "3/3  Tiling z$MIN_Z-$MAX_Z…"
rm -rf "$OUT"
mkdir -p "$OUT"
# --xyz gives slippy-map row order; without it gdal2tiles emits TMS and every
# tile appears vertically mirrored in Leaflet.
# -r near keeps class colours pure; averaging would blend adjacent classes
# into colours that mean nothing.
G2T --xyz -z "$MIN_Z-$MAX_Z" -r near --processes=4 \
    -w none "$WORK/clc_rgba.tif" "$OUT"

echo
echo "Done. $(find "$OUT" -name '*.png' | wc -l) tiles, $(du -sh "$OUT" | cut -f1)"
echo "Now set LAYERS.corineAvailable = true in js/config.js"
