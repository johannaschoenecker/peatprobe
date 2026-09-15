#!/usr/bin/env bash
# Convert the QField "sampled points" shapefile into the app's temporary
# "August samples" overlay. Re-run whenever the shapefile gets new points;
# delete data/august-samples.geojson (and push) to retire the layer.
#
# Usage:
#   export PATH="/c/Program Files/QGIS 3.32.3/bin:$PATH"
#   bash tools/build_august_samples.sh ["/path/to/sampled points.shp"]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-/c/Users/jscho/OneDrive - University of Cambridge/Postdoc/UK Fires 2026/QFIELD/sampled points.shp}"
OUT="$HERE/data/august-samples.geojson"

command -v ogr2ogr >/dev/null || { echo "ogr2ogr not on PATH - see header."; exit 1; }
[ -f "$SRC" ] || { echo "Not found: $SRC"; exit 1; }

N=$(ogrinfo -so -al "$SRC" | grep -m1 "Feature Count" | grep -o "[0-9]*")
if [ "${N:-0}" -eq 0 ]; then
  echo "REFUSING: '$SRC' contains 0 features."
  echo "This is the empty desktop template - the collected points are still on"
  echo "the phone / QFieldCloud copy of the project. Sync or export them first."
  exit 1
fi

rm -f "$OUT"
ogr2ogr -f GeoJSON "$OUT" "$SRC" -t_srs EPSG:4326 \
  -lco COORDINATE_PRECISION=6 -lco RFC7946=YES

echo "wrote $OUT with $N point(s) - commit and push to publish the layer."
