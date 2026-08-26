#!/usr/bin/env bash
# Rebuild the fire layers from the EFFIS shapefile.
#
# Usage:  bash tools/build_fire_index.sh [/path/to/EFFIS_UK_fires_25_26.shp]
#
# Produces:
#   data/fires-index.geojson    ~1 MB  simplified, always cached, drives the picker
#   data/fires-detail.geojson   ~8 MB  full precision (intermediate)
#   data/fires/<id>.geojson     one small file per fire, fetched when a pack is built
#
# Needs GDAL. On Windows the QGIS install has it:
#   export PATH="/c/Program Files/QGIS 3.32.3/bin:$PATH"

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Defaults to the copy inside the project, so this is self-contained.
SRC="${1:-$HERE/data/source/effis/EFFIS_UK_fires_25_26.shp}"
OUT="$HERE/data"
LAYER="$(basename "$SRC" .shp)"

command -v ogr2ogr >/dev/null || { echo "ogr2ogr not on PATH. See the header of this script."; exit 1; }
[ -f "$SRC" ] || { echo "Source shapefile not found: $SRC"; exit 1; }

# Putting QGIS on PATH (needed for ogr2ogr) also shadows the system python
# with QGIS's bundled one, which cannot start outside its own environment.
# Pick the first interpreter that actually runs.
pick_python() {
  local c
  for c in $(type -aP python3 2>/dev/null) $(type -aP python 2>/dev/null); do
    if "$c" -c 'import json,sys' >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  return 1
}
PYTHON="${PYTHON:-$(pick_python)}" || true
[ -n "$PYTHON" ] || { echo "No working python found. Set PYTHON=/path/to/python and retry."; exit 1; }

FIELDS="id, COMMUNE, PROVINCE, COUNTRY, FIREDATE, CLASS, areaHA_geo"

mkdir -p "$OUT"
rm -f "$OUT/fires-index.geojson" "$OUT/fires-detail.geojson"

echo "Building simplified index…"
ogr2ogr -f GeoJSON "$OUT/fires-index.geojson" "$SRC" \
  -sql "SELECT $FIELDS FROM \"$LAYER\"" \
  -simplify 0.0004 \
  -lco COORDINATE_PRECISION=5 -lco RFC7946=YES

echo "Building full-detail layer…"
ogr2ogr -f GeoJSON "$OUT/fires-detail.geojson" "$SRC" \
  -sql "SELECT $FIELDS FROM \"$LAYER\"" \
  -lco COORDINATE_PRECISION=6 -lco RFC7946=YES

echo "Splitting into per-fire files… (using $PYTHON)"
"$PYTHON" "$HERE/tools/split_fires.py" "$OUT/fires-detail.geojson" "$OUT/fires"

echo
echo "Done."
du -h "$OUT/fires-index.geojson" | awk '{print "  index:  " $1}'
echo "  per-fire files: $(ls -1 "$OUT/fires" | wc -l)"
