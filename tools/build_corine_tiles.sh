#!/usr/bin/env bash
# Turn the CORINE GeoTIFF exported by tools/gee_corine.js into XYZ PNG tiles
# the app can serve and pack for offline use.
#
# Usage:
#   bash tools/build_corine_tiles.sh ~/Downloads/corine_2018_uk*.tif
#
# Runs from plain Git Bash - it finds QGIS's GDAL and Python itself. If your
# QGIS lives somewhere unusual, pass QGIS_ROOT=/path/to/QGIS.
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
[ -f "$COLORS" ] || { echo "Missing $COLORS"; exit 1; }

# ── locate gdal2tiles ──────────────────────────────────────────────────────
# gdal2tiles is a Python script, and QGIS's bundled interpreter cannot boot
# when QGIS/bin is merely prepended to PATH: it looks for its standard library
# next to the exe and dies with "No module named 'encodings'". Pointing
# PYTHONHOME at apps/Python39 fixes it, which is what the OSGeo4W Shell does.
# Doing it here means this script runs from plain Git Bash.
QGIS_ROOT="${QGIS_ROOT:-}"
if [ -z "$QGIS_ROOT" ]; then
  for c in /c/Program\ Files/QGIS*/ /c/OSGeo4W*/; do
    [ -d "$c/apps/Python39" ] && QGIS_ROOT="${c%/}" && break
  done
fi

if [ -n "$QGIS_ROOT" ] && [ -d "$QGIS_ROOT/apps/Python39" ]; then
  export PYTHONHOME="$QGIS_ROOT/apps/Python39"
  export PATH="$QGIS_ROOT/bin:$QGIS_ROOT/apps/Python39:$QGIS_ROOT/apps/Python39/Scripts:$QGIS_ROOT/apps/gdal/bin:$PATH"
  export GDAL_DATA="${GDAL_DATA:-$QGIS_ROOT/apps/gdal/share/gdal}"
  export PROJ_LIB="${PROJ_LIB:-$QGIS_ROOT/share/proj}"
  PY="$QGIS_ROOT/bin/python3.exe"
else
  PY="$(command -v python3 || command -v python || true)"
fi

if [ -n "$PY" ] && "$PY" -c "import osgeo_utils.gdal2tiles" 2>/dev/null; then
  G2T() { "$PY" -m osgeo_utils.gdal2tiles "$@"; }
elif command -v gdal2tiles.py >/dev/null; then
  G2T() { gdal2tiles.py "$@"; }
else
  echo "gdal2tiles not found."
  echo "Set QGIS_ROOT to your QGIS install, e.g.:"
  echo "  QGIS_ROOT='/c/Program Files/QGIS 3.32.3' bash tools/build_corine_tiles.sh <tif>"
  exit 1
fi

# Checked after the bootstrap above has put QGIS's GDAL on PATH.
command -v gdaldem >/dev/null || { echo "gdaldem not found. Set QGIS_ROOT and retry."; exit 1; }

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

echo "4/4  Pruning blank sea tiles…"
# gdal2tiles writes a tile for every cell of the bounding box, and the UK bbox
# is mostly sea. The app reads a missing overlay tile as "no coverage", which
# is what these are.
"$PY" "$HERE/tools/prune_blank_tiles.py" "$OUT"

echo
echo "Done. $(find "$OUT" -name '*.png' | wc -l) tiles, $(du -sh "$OUT" | cut -f1)"
echo "Now set LAYERS.corineAvailable = true in js/config.js"
