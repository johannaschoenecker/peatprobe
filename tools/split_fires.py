#!/usr/bin/env python3
"""Split a GeoJSON FeatureCollection into one file per fire.

The app fetches data/fires/<id>.geojson when building a field pack, so a
volunteer downloads the detailed perimeter for their fire only, rather than an
8 MB file covering the whole country.

Usage: python3 split_fires.py fires-detail.geojson out_dir/
"""

import json
import os
import re
import sys

SAFE = re.compile(r"[^A-Za-z0-9._-]")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    src, out_dir = sys.argv[1], sys.argv[2]

    with open(src, "r", encoding="utf-8") as fh:
        fc = json.load(fh)

    os.makedirs(out_dir, exist_ok=True)

    # Clear stale files so a rebuild after fires are removed upstream does not
    # leave orphans that the app would happily still download.
    for name in os.listdir(out_dir):
        if name.endswith(".geojson"):
            os.remove(os.path.join(out_dir, name))

    written, skipped = 0, 0
    for feat in fc.get("features", []):
        fire_id = (feat.get("properties") or {}).get("id")
        if fire_id is None:
            skipped += 1
            continue

        # ids come from EFFIS and are used directly in a URL path
        safe_id = SAFE.sub("_", str(fire_id))
        path = os.path.join(out_dir, f"{safe_id}.geojson")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(feat, fh, separators=(",", ":"))
        written += 1

    print(f"  wrote {written} files to {out_dir}" + (f", skipped {skipped} without an id" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
