# Source data

Original inputs. Everything in `data/` outside this folder is **generated**
from here — rebuild rather than edit.

| Folder | What goes here | Produced by | Feeds |
| --- | --- | --- | --- |
| `effis/` | EFFIS UK fire perimeters shapefile | supplied | `tools/build_fire_index.sh` |
| `corine/` | `corine_2018_uk*.tif` from Earth Engine | `tools/gee_corine.js` | `tools/build_corine_tiles.sh` |
| `dnbr/` | `dnbr_<fireid>.tif` per fire, from Earth Engine | `tools/gee_dnbr.js` | not yet wired into the app |

`corine/` and `dnbr/` are **gitignored** — they are large and can be
re-exported from Earth Engine at any time. `effis/` is committed because it is
small and is the one input that is not reproducible from a script.

## Not copied into this project

- **Peat maps** (~2.4 GB, four national datasets) — deferred. They need
  harmonising into one classification and converting to vector tiles.
- **UKCEH Land Cover** (~56 GB) — cannot be served. The EDINA licence forbids
  displaying or distributing the data on any electronic network. Use it in
  QGIS for analysis only; CORINE is the layer that ships.

Both remain at:
`OneDrive - University of Cambridge/Postdoc/UK Fires 2026/Analysis/Data`
