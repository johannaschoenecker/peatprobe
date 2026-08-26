# Source data

Original inputs. Everything in `data/` outside this folder is **generated**
from here and is gitignored — rebuild rather than edit.

| Folder | Contents | Used by |
| --- | --- | --- |
| `effis/` | EFFIS UK fire perimeters 2025/26 shapefile | `tools/build_fire_index.sh` |
| `corine/` | CORINE Land Cover raster (add when downloaded) | see README "Adding CORINE" |

## Not copied here

- **Peat maps** (~2.4 GB across four national datasets) — deferred. Copy them
  in when we build that layer; they need harmonising into one classification
  and converting to vector tiles, not shipping as-is.
- **UKCEH Land Cover** (~56 GB) — dropped in favour of CORINE for licensing
  reasons. Stays in the OneDrive analysis folder.

Both remain at:
`OneDrive - University of Cambridge/Postdoc/UK Fires 2026/Analysis/Data`
