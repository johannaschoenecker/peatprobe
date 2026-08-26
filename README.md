# PeatProbe

Offline-first citizen science app for recording **peat burn depth** after UK wildfires.

Volunteers open a link, download a "field pack" for the fire they are visiting,
then work with no signal — map, fire perimeter, GPS, depth readings and photos
all keep functioning. Measurements upload when they get back to a connection.

No build step. No npm. It is plain ES modules, Leaflet, and a service worker.

---

## Quick start

```bash
python3 -m http.server 5173 --directory .
```

Open <http://localhost:5173>. That is the whole development setup.

It works immediately with **no Firebase account** — measurements stay on the
device and can be exported as CSV. Turn on cloud sync when you are ready.

---

## What is here

| Path | What it does |
| --- | --- |
| `index.html` | App shell: four tabs plus the record sheet |
| `js/config.js` | **Everything you are likely to change** |
| `js/app.js` | Controller: tabs, form, GPS, sync, CSV export |
| `js/map.js` | Leaflet, offline-first tile layer, fire index, points |
| `js/packs.js` | Field packs: estimate, download, delete |
| `js/db.js` | IndexedDB: points, photos, packs, tiles |
| `js/sync.js` | Optional Firebase (lazy-loaded, only when enabled) |
| `js/info.js` | Info tab content — **contains placeholders to fill in** |
| `js/geo.js` | Tile maths, point-in-polygon, formatting |
| `sw.js` | Service worker; caches the app shell only |
| `data/fires-index.geojson` | 1,599 EFFIS perimeters, simplified (1.0 MB) |
| `data/fires/<id>.geojson` | Per-fire detail, fetched when a pack is built |
| `firestore.rules`, `storage.rules` | Security rules for the open-link threat model |
| `tools/` | Rebuild scripts and the icon generator |

---

## Before you share the link — five things

### 1. ⚠️ Restrict the MapTiler key

The key sits in `js/config.js` and **ships inside client-side JavaScript**,
visible to anyone who opens the page. That is unavoidable for a web map — the
control is at MapTiler's end.

Go to **MapTiler → Account → Keys → allowed origins** and lock the key to the
domain you deploy to. Otherwise someone else can spend your tile quota.

Also check your plan's monthly allowance: building a pack spends one tile
request per tile in a burst — median fire ~260, largest ~8,100.

### 2. Fill in the placeholders in `js/info.js`

Search for `[[ ]]`. The measurement protocol in there is a **generic
placeholder** — replace it with yours. Also needed: your support email, data
controller and ethics reference, and any landowner guidance.

### 3. Sort out the privacy notice

Volunteer emails, precise locations, and photographs are personal data. Talk to
Cambridge's data protection office before launch — this is not optional and it
is the thing most likely to delay you.

### 4. Set a Firebase budget alert

An open link plus Blaze billing is a real cost exposure. Set a budget alert at
£5 and enable [App Check](https://firebase.google.com/docs/app-check) before
the link goes anywhere public.

### 5. Generate the PNG icons

Open `tools/make-icons.html` in a browser and click the button. Move the four
downloaded PNGs into `icons/`. Only needed once.

---

## Enabling cloud sync

1. Create a Firebase project. Enable **Authentication → Google**,
   **Firestore**, and **Storage** (Storage needs the Blaze plan).
2. Paste the web app config into `FIREBASE.config` in `js/config.js` and set
   `enabled: true`.
3. Deploy the rules:
   ```bash
   firebase deploy --only firestore:rules,storage
   ```
4. Make yourself an admin: in Firestore, create a document in `admins/` whose
   **ID is your user UID**. Nobody can grant themselves this.

### How sync behaves

- Firestore queues document writes offline by itself.
- **Cloud Storage does not queue uploads.** Photos therefore live in IndexedDB
  until a connection exists; a point can briefly exist with its photo pending.
- Document IDs are the client-generated UUID, so a retried upload can never
  create a duplicate row.
- Points arrive with `status: 'pending_review'`. Only an admin can move them to
  `verified`.

---

## Rebuilding the fire layers

When EFFIS publishes new perimeters:

```bash
export PATH="/c/Program Files/QGIS 3.32.3/bin:$PATH"
bash tools/build_fire_index.sh /path/to/EFFIS_UK_fires_25_26.shp
```

This regenerates the simplified index and the 1,599 per-fire detail files.

---

## Adding CORINE land cover

Not shipped — you need to download it yourself.

1. Get CORINE Land Cover from the
   [Copernicus Land Monitoring Service](https://land.copernicus.eu/) (free
   account required).
2. Clip to the UK, reproject to EPSG:3857, and tile it:
   ```bash
   gdalwarp -t_srs EPSG:3857 -te_srs EPSG:4326 -te -9 49 2.5 61 clc.tif clc_uk.tif
   gdal2tiles.py -z 6-14 -r near clc_uk.tif data/corine/
   ```
3. Set `LAYERS.corineAvailable = true` in `js/config.js`.

The app degrades gracefully when the tiles are absent, so this can wait.

**Note on resolution:** CORINE is 100 m, against UKCEH LCM's 10 m. It is
landscape context, not something to measure against. If you want open *and*
comparable to LCM, look at ESA WorldCover (10 m, CC-BY).

---

## Field pack sizing (measured, not guessed)

Against the real EFFIS 25/26 layer, zoom 10–16 with a 2 km buffer, using
MapTiler topo-v4 **webp**:

| | Tiles | Size |
| --- | --- | --- |
| Smallest fire | 174 | ~3 MB |
| Median fire (16 ha) | 259 | ~4.8 MB |
| 90th percentile (57 ha) | 354 | ~6.6 MB |
| Largest (West Moray, 9,809 ha) | 8,066 | ~150 MB |

Only one fire in the whole dataset exceeds 4,000 tiles, and it sits behind a
confirmation prompt.

**Tile format matters more than you would think.** Measured over Dava Moor, the
Peak District and the Flow Country:

| Format | Mean/tile | Largest fire |
| --- | --- | --- |
| webp | 18.5 kB | ~150 MB |
| png | 48.6 kB | ~383 MB |

Keep webp unless you hit a device that cannot decode it.

Tiles are **shared between packs** — deleting one pack never strands another.

---

## Development notes

**The service worker will serve you stale code.** It is cache-first, which is
right for the field and infuriating during development. When your changes do
not appear, either bump `VERSION` in `sw.js`, or in DevTools console:

```js
navigator.serviceWorker.getRegistrations().then(r => r.forEach(x => x.unregister()));
caches.keys().then(k => k.forEach(c => caches.delete(c)));
```

then hard-reload.

**Wipe local data** while testing:

```js
indexedDB.deleteDatabase('peatprobe');
```

---

## Deploying

It must be served over **HTTPS** — geolocation and service workers both refuse
to run otherwise, so `file://` and plain `http://` on a LAN address will not
work for phone testing. `localhost` is exempt, which is why desktop dev works.

**There is no Node.js on this machine**, so `npx netlify-cli` and
`firebase-tools` are not available without installing it first. Two routes that
need nothing installed:

### Netlify Drop — fastest, ~2 minutes

1. Zip the project folder (exclude `data/source/`, it is not needed at runtime).
2. Drag it onto <https://app.netlify.com/drop>.
3. You get an HTTPS URL immediately. Open it on your phone.

Good enough for field testing. Add a custom domain later.

### GitHub Pages — better once you want version history

Git is already installed and the repo is initialised:

```bash
git commit -m "PeatProbe pilot"
git remote add origin https://github.com/<you>/peatprobe.git
git push -u origin main
```

Then **Settings → Pages → deploy from `main`, root**.

Caveat: `.gitignore` excludes `data/fires/` and `data/corine/`, which the app
needs at runtime. For Pages, either commit them (add `-f`) or run the build
step in a GitHub Action.

### Firebase Hosting

Worth it once you enable cloud sync, since it keeps auth domains simple. Needs
Node.js installed for `firebase-tools`.

**Whichever you pick:** add the deployed origin to your MapTiler key's allowed
origins, or the map will go blank in production.

---

## Known gaps

- **Peat maps are not included** — deferred. The four national sources
  (439,700 Scottish + 249,743 English features, in three CRS) need
  harmonising into one classification and converting to vector tiles with
  `tippecanoe`; too big for GeoJSON.
- **No admin/moderation UI.** Review happens in the Firebase console for now.
- **No duplicate detection** — nothing stops two volunteers recording the same
  spot, which is arguably fine, but analysis will need to handle it.
- **Satellite imagery is online only.**
- Fires are labelled from the EFFIS `COMMUNE`/`PROVINCE` fields, which are
  occasionally blank; those show as "Unnamed fire".

---

## Credits

Fire perimeters: EFFIS, Copernicus Emergency Management Service.
Land cover: CORINE Land Cover, Copernicus.
Base map: © OpenStreetMap contributors.
