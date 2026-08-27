/**
 * PeatProbe - export CORINE Land Cover 2018 for the UK from Earth Engine.
 *
 * Paste into https://code.earthengine.google.com/ and run. Exports a single
 * categorical GeoTIFF of raw CLC class codes to your Drive; colouring and
 * tiling happen locally in tools/build_corine_tiles.sh.
 *
 * Why CORINE and not UKCEH Land Cover: the UKCEH/EDINA licence explicitly
 * forbids displaying or distributing the data on any electronic network, which
 * rules out serving it as tiles even to a small team. CORINE is Copernicus
 * open data - free to redistribute with attribution.
 *
 * Trade-off: CORINE is 100 m with a 25 ha minimum mapping unit, against
 * UKCEH's 10 m. Treat it as landscape context, not something to measure
 * against. Keep using UKCEH in QGIS for your own analysis - desktop use is
 * within the licence.
 *
 * Dataset: COPERNICUS/CORINE/V20/100m  (1990, 2000, 2006, 2012, 2018)
 * Band: 'landcover', 44 classes, codes 111-523.
 */

// UK bounding box, padded a little beyond the EFFIS extent
// (-7.54, 49.98) to (1.63, 60.30).
var UK = ee.Geometry.Rectangle([-8.8, 49.7, 2.2, 61.1], null, false);

var clc = ee.Image(
  ee.ImageCollection('COPERNICUS/CORINE/V20/100m')
    .filterDate('2018-01-01', '2018-12-31')
    .first()
).select('landcover').clip(UK);

// ── the classes that matter for peat fire work ────────────────────────────
//  412 Peat bogs                     <- the one you care about
//  411 Inland marshes
//  322 Moors and heathland
//  321 Natural grassland
//  324 Transitional woodland-shrub
//  231 Pastures
//  311/312/313 Forest
//  333 Sparsely vegetated areas
var PEAT_CLASSES = [412, 411, 322, 321, 324];

// Quick sanity check: how much of each burned area sits on which class?
// Uses the EFFIS perimeters if you have already uploaded them.
var FIRES = ee.FeatureCollection('projects/YOUR-PROJECT/assets/EFFIS_UK_fires_25_26');

var perFire = FIRES.map(function (f) {
  var hist = clc.reduceRegion({
    reducer: ee.Reducer.frequencyHistogram(),
    geometry: f.geometry(), scale: 100, maxPixels: 1e9, bestEffort: true
  }).get('landcover');
  return ee.Feature(null, {
    id: f.get('id'),
    commune: f.get('COMMUNE'),
    area_ha: f.get('areaHA_geo'),
    firedate: f.get('FIREDATE'),
    clc_histogram: ee.Dictionary(hist).toString()
  });
});

Export.table.toDrive({
  collection: perFire,
  description: 'peatprobe_corine_per_fire',
  folder: 'peatprobe',
  fileFormat: 'CSV'
});

// ── raster export ─────────────────────────────────────────────────────────
// EPSG:3857 so no reprojection is needed before tiling. scale 100 in web
// mercator metres is ~57 m on the ground at 55N, comfortably finer than the
// 100 m source - we are only tiling to z11, where a pixel is ~44 m.
//
// GEE may split this into several GeoTIFFs; build_corine_tiles.sh handles
// that with gdalbuildvrt.
Export.image.toDrive({
  image: clc.toUint16(),
  description: 'corine_2018_uk',
  folder: 'peatprobe',
  fileNamePrefix: 'corine_2018_uk',
  region: UK,
  scale: 100,
  crs: 'EPSG:3857',
  maxPixels: 1e10,
  fileFormat: 'GeoTIFF',
  formatOptions: { cloudOptimized: true }
});

// ── inspect ───────────────────────────────────────────────────────────────
Map.setCenter(-3.4, 55.5, 6);
Map.addLayer(clc, {}, 'CORINE 2018 (built-in palette)');

var peatMask = clc.remap(PEAT_CLASSES, ee.List.repeat(1, PEAT_CLASSES.length), 0);
Map.addLayer(peatMask.selfMask(), { palette: ['#6a3d9a'] }, 'bog / heath / marsh', false);

print('CLC image', clc);
print('Peat-relevant classes', PEAT_CLASSES);
