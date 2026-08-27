/**
 * PeatProbe - burn severity (dNBR) from Sentinel-2, in Google Earth Engine.
 *
 * Paste into https://code.earthengine.google.com/ after uploading
 * data/source/effis/EFFIS_UK_fires_25_26.shp as a GEE table asset.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THE OUTPUT
 *
 * dNBR measures change in surface/canopy moisture and structure. It does NOT
 * measure how deep the peat burned. The standard severity thresholds below are
 * from Key & Benson (2006), calibrated on North American forest - they are not
 * validated for UK blanket bog or heather moorland, where a shallow surface
 * burn and a deep smouldering burn can look similar from orbit.
 *
 * So treat this layer as CONTEXT and as a SAMPLING STRATIFIER, not as a depth
 * proxy. The interesting science is the other direction: PeatProbe's ground
 * measurements are exactly what you would need to test how well dNBR predicts
 * peat consumption in these systems.
 * ---------------------------------------------------------------------------
 *
 * Measured against the real EFFIS 25/26 layer:
 *   1,599 fires, 79,828 ha total, median burn duration 0.03 days (~45 min),
 *   only 16 fires burn longer than a week. 162 fires are >= 50 ha.
 */

// ═══════════════════════════════════════════════════════════ config
var FIRES = ee.FeatureCollection('projects/YOUR-PROJECT/assets/EFFIS_UK_fires_25_26');

var PRE_DAYS   = 120;   // UK cloud cover forces a wide pre-fire window
var POST_DAYS  = 120;
var GAP_DAYS   = 3;     // most of these fires are out within a day
var SCALE      = 20;    // B8A/B12 native resolution
var MIN_AREA_HA = 50;   // per-fire raster export subset (162 fires qualify)
var CLOUD_PCT  = 70;    // scene-level prefilter; SCL does the per-pixel work

var S2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED');

// ═══════════════════════════════════════════════════════════ helpers

/** Mask cloud, shadow, cirrus, snow and saturated pixels using the SCL band. */
function maskS2(img) {
  var scl = img.select('SCL');
  var bad = scl.eq(1)                        // saturated / defective
    .or(scl.eq(3))                           // cloud shadow
    .or(scl.gte(7).and(scl.lte(10)))         // cloud low/med/high prob, cirrus
    .or(scl.eq(11));                         // snow / ice
  return img.updateMask(bad.not())
            .divide(10000)
            .copyProperties(img, ['system:time_start']);
}

/** NBR = (NIR - SWIR2) / (NIR + SWIR2). B8A rather than B8: it is native 20 m,
 *  matching B12, so no resampling artefacts creep into the ratio. */
function addNBR(img) {
  return img.addBands(img.normalizedDifference(['B8A', 'B12']).rename('NBR'));
}

function composite(geom, start, end) {
  return S2.filterBounds(geom)
           .filterDate(start, end)
           .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', CLOUD_PCT))
           .map(maskS2)
           .map(addNBR)
           .select('NBR');
}

/** dNBR for one fire, carrying QA counts so unusable fires can be dropped. */
function dnbrFor(feature) {
  var f = ee.Feature(feature);
  var geom = f.geometry();
  // "2025-05-07 11:28:00" -> "2025-05-07"
  var fire  = ee.Date(ee.String(f.get('FIREDATE')).slice(0, 10));
  var final = ee.Date(ee.String(f.get('FINALDATE')).slice(0, 10));

  var preCol  = composite(geom, fire.advance(-PRE_DAYS, 'day'), fire.advance(-GAP_DAYS, 'day'));
  var postCol = composite(geom, final.advance(GAP_DAYS, 'day'), final.advance(POST_DAYS, 'day'));

  var pre  = preCol.median();
  var post = postCol.median();

  // x1000 is the conventional scaling, and keeps the export as Int16.
  var dnbr = pre.subtract(post).multiply(1000).rename('dNBR');

  // RdNBR (Miller & Thode 2007) reduces the bias where pre-fire vegetation was
  // already sparse - relevant on bare or heavily grazed moorland.
  var rdnbr = dnbr.divide(pre.abs().sqrt().max(0.001)).rename('RdNBR');

  return dnbr.addBands(rdnbr)
    .clip(geom)
    .set({
      fireId:   f.get('id'),
      firedate: f.get('FIREDATE'),
      areaHa:   f.get('areaHA_geo'),
      nPre:     preCol.size(),
      nPost:    postCol.size()
    });
}

// Key & Benson (2006) severity breaks, dNBR x1000.
var BREAKS = [-250, -100, 100, 270, 440, 660];
var CLASS_NAMES = ['regrowth_high', 'regrowth_low', 'unburned',
                   'low', 'moderate_low', 'moderate_high', 'high'];
var PALETTE = ['#1a9850', '#91cf60', '#d9d9d9',
               '#fee08b', '#fc8d59', '#e34a33', '#7f0000'];

function classify(dnbr) {
  var c = ee.Image(0);
  for (var i = 0; i < BREAKS.length; i++) {
    c = c.add(dnbr.gt(BREAKS[i]));
  }
  return c.rename('severity');
}

// ═══════════════════════════════════════════════════════════ 1. summary table
// One cheap task covering ALL fires. Run this first - the QA columns tell you
// which fires have usable imagery before you spend effort on rasters.
var summary = FIRES.map(function (f) {
  var img = dnbrFor(f);
  var geom = ee.Feature(f).geometry();
  var stats = img.select('dNBR').reduceRegion({
    reducer: ee.Reducer.mean()
      .combine(ee.Reducer.median(), '', true)
      .combine(ee.Reducer.percentile([90]), '', true)
      .combine(ee.Reducer.count(), '', true),
    geometry: geom, scale: SCALE, maxPixels: 1e9, bestEffort: true
  });
  return ee.Feature(null, {
    id:        f.get('id'),
    commune:   f.get('COMMUNE'),
    province:  f.get('PROVINCE'),
    firedate:  f.get('FIREDATE'),
    finaldate: f.get('FINALDATE'),
    area_ha:   f.get('areaHA_geo'),
    n_pre:     img.get('nPre'),
    n_post:    img.get('nPost'),
    dnbr_mean:   stats.get('dNBR_mean'),
    dnbr_median: stats.get('dNBR_median'),
    dnbr_p90:    stats.get('dNBR_p90'),
    px_valid:    stats.get('dNBR_count')
  });
});

Export.table.toDrive({
  collection: summary,
  description: 'peatprobe_dnbr_summary',
  folder: 'peatprobe',
  fileFormat: 'CSV'
});

// ═══════════════════════════════════════════════════════════ 2. per-fire raster
// Only the larger fires, to keep the task count sane. GEE runs ~20-30 exports
// concurrently; 162 tasks is fine, 1,599 is not.
var big = FIRES.filter(ee.Filter.gte('areaHA_geo', MIN_AREA_HA));
print('fires queued for raster export:', big.size());

// GEE cannot start Exports from inside a server-side map(), so pull the ids
// client-side and loop. evaluate() keeps the Code Editor responsive.
big.aggregate_array('id').evaluate(function (ids) {
  ids.forEach(function (id) {
    var f = ee.Feature(FIRES.filter(ee.Filter.eq('id', id)).first());
    var img = dnbrFor(f);
    Export.image.toDrive({
      image: img.select('dNBR').toInt16(),
      description: 'dnbr_' + id,
      folder: 'peatprobe_dnbr',
      fileNamePrefix: 'dnbr_' + id,
      region: f.geometry().bounds(),
      scale: SCALE,
      crs: 'EPSG:3857',          // web-mercator now = no reprojection later
      maxPixels: 1e9,
      fileFormat: 'GeoTIFF',
      formatOptions: { cloudOptimized: true }
    });
  });
});

// ═══════════════════════════════════════════════════════════ 3. inspect
var demo = ee.Feature(FIRES.sort('areaHA_geo', false).first());
var demoImg = dnbrFor(demo);
Map.centerObject(demo, 12);
Map.addLayer(demoImg.select('dNBR'), { min: -200, max: 900,
  palette: ['#2b83ba', '#ffffbf', '#fdae61', '#d7191c'] }, 'dNBR');
Map.addLayer(classify(demoImg.select('dNBR')),
  { min: 0, max: 6, palette: PALETTE }, 'severity', false);
Map.addLayer(demo, { color: 'black' }, 'perimeter');
print('demo fire', demo.get('COMMUNE'), 'pre imgs', demoImg.get('nPre'),
      'post imgs', demoImg.get('nPost'));
