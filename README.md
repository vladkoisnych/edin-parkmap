# Edinburgh Cheap Parking

A static, touch-first map of Edinburgh on-street parking by price. £1/hr bays stand out, free
parking outside the controlled zones is shaded, tapping a bay copies `Street, Edinburgh`, and an
address search ranks the nearest cheap and free options. See
[the spec](./Edinburgh%20Cheap%20Parking%20Map%20Spec.md).

No backend, no API keys. A weekly GitHub Action rebuilds the data and deploys to GitHub Pages.

## Develop

```sh
npm install
npm run data        # open-licensed sources -> public/data (add --cache to reuse .cache/raw)
npm run dev         # http://localhost:5173
npm test            # unit tests (pipeline runs against tests/fixtures, no network)
npm run build && npm run e2e   # Playwright, Pixel 7 + iPhone 14 emulation
```

Node ≥ 22.15. The first open build downloads OS Open Roads (~600 MB, cached in `.cache/raw/osroads`).

| Command | What |
| --- | --- |
| `npm run data:council` | Build from the council's parking-map layers instead (no published reuse licence; see Licensing) |
| `npm run data:compare` | Compare open and council builds bay by bay (needs both caches) |
| `npm run data:seed-tariffs` | Re-seed `pipeline/tariff-rules.json` from the council tariff layer (one-off; normally edit by hand) |
| `npm run data:fixtures` | Re-freeze the test fixture slices from `.cache/raw` |
| `npx tsx scripts/icons.mts` | Re-render the PNG icons from `public/icon.svg` |

## Data sources

`npm run data` uses **open sources by default** (`--source open`). `--source council` keeps the
original behaviour. Both feed the same pipeline and produce the same files.

| | Open (default) | Council (`--source council`) |
| --- | --- | --- |
| Bays, zone, type | Council *Parking Bays* (INSPIRE 11, OGL) | Transport 13 + 15 (same dataset) |
| Controlled zones | Council *Controlled Parking Zones* (INSPIRE 12, OGL) | Transport 4 |
| Street names, entry points | **OS Open Roads** centrelines (OGL) | Council *Street Types* (Transport 18) |
| Free zone | **Ward Boundaries** (INSPIRE 24, OGL) minus controlled zones | *CPZ with Uncontrolled Zones* (Transport 24) |
| Prices and hours | **`pipeline/tariff-rules.json`** (in this repo) | *Parking Tariff Area* (Transport 16) |

`tariff-rules.json` holds the prices and hours for each charge (these match the council's
[published price page](https://www.edinburgh.gov.uk/parking-spaces/parking-prices-times)), a
default charge per zone, street exceptions, and the £1/hr long-stay locations as lists of bay
centres. It was seeded once from the council tariff layer (the £1/hr streets aren't published
anywhere else) and is maintained by hand from now on.

Open vs council on 5 Oct 2026 (`npm run data:compare`), over 2,151 bays:

- Tariffs agree for 99.9%.
- £1/hr: 124 match, 1 extra, 0 missed.
- Street names agree for 96.7%. On a sample of the remaining disagreements checked against
  OpenStreetMap, OS Open Roads was right 10 times and the council 8.
- Free entry points: 86 (open) vs 84 (council).

## Layout

| Path | What |
| --- | --- |
| `pipeline/` | Build-time data: sources (`sources.ts`, `arcgis.ts`, `osroads.ts`), tariffs (`tariff-rules.ts` + `.json`, `join.ts`), street naming (`streets.ts`), segments, free zone + entry points, validation, `run.ts` |
| `src/lib/` | Shared by pipeline and client: geometry, hours parser, tariffs, ranking, data contract (`types.ts`) |
| `src/app/` | Client: Leaflet map, bottom sheet, search/geocoding, clipboard, views |
| `tests/unit`, `tests/e2e`, `tests/fixtures` | Vitest, Playwright, frozen data slices for both source modes |

## Data notes (differences from the spec, found while building)

- **Street names:** each bay takes the nearest named centreline within 30 m (60 m second pass).
  A bay lying across a street is penalised, which fixes most junction mix-ups. (The council's OGL
  *Adopted Roads* carriageway polygons were tried first, but only reached 92% agreement because
  junction areas carry the cross street's name.)
- **£1/hr tariffs are small strips drawn on top of the zone tariff.** The E/G/H polygons sit
  inside the large Charge D zones. In council mode the join picks the *smallest* containing
  polygon (without that rule only 1 cheap bay is found; with it there are 125). One £1 strip has
  no bay polygons inside; council mode shows the strip itself (`kind: "area"`), and open mode
  can't, since that strip exists only in the tariff layer.
- **The layers are stored in British National Grid (OSGB36).** Asking the server for WGS84 without
  `datumTransformation` puts everything about 90 m east of the basemap. The fetch requests transform
  1314 (OSGB36→WGS84, ~2 m), and each live run first compares one server-reprojected vertex with an
  independent Helmert conversion (`pipeline/datum.ts`), failing if they differ by more than 15 m.
- One council "bay" polygon can be a 100 m strip, so the app shows kerb length and an approximate
  car count instead of a bay count.
- Free entry points: where local roads (no A/B/trunk/private roads) cross out of the CPZ, stepped
  25 m into the free zone, at most one per street every 300 m.
- `meta.json` records counts and drops (e.g. bays with no tariff match) for each run. Validation
  fails the refresh when a key count moves more than 20%. The last good snapshot stays live and an
  issue is opened.

## Deploying

1. Push to a public GitHub repo with Pages enabled, source **GitHub Actions**.
2. The workflow runs on push, weekly, and on demand. Use the `skip_drift` input to accept a
   legitimate big change in counts.

## Licensing

**Code:** MIT (see `LICENSE`). The licence does not cover the data.

**Data** (checked 5 Oct 2026). The default open build uses only the rows marked OK.

| Source | Used for | Terms | Status |
| --- | --- | --- | --- |
| Council *Parking Bays* (INSPIRE 11) | Bay geometry, zone, type | [OGL v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/), attribution required | OK |
| Council *Controlled Parking Zones* (INSPIRE 12) | Zone edges, free zone | OGL v3.0, attribution required | OK |
| Council *Ward Boundaries* (INSPIRE 24) | City edge for the free zone | OGL v3.0, attribution required | OK |
| OS Open Roads | Street names, entry points | [OS OpenData licence](https://www.ordnancesurvey.co.uk/legal/open-data) (OGL v3.0) | OK |
| `pipeline/tariff-rules.json` | Prices and hours | Prices are published facts. The £1/hr locations were seeded once from the council tariff layer (see below) | OK, with the caveat below |
| OpenStreetMap tiles | Basemap | ODbL attribution, [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) | OK at low volume. Move to a commercial tile host if traffic grows |
| Nominatim | Address search | [Usage policy](https://operations.osmfoundation.org/policies/nominatim/): ≤1 req/s, no autocomplete, identifying Referer | OK (submit only, no autocomplete) |
| postcodes.io | Postcode search | ONS/OS/Royal Mail data under OGL, attribution | OK |
| Council *Parking Tariff Area*, *Street Types*, *CPZ with Uncontrolled Zones* (Transport 16, 18, 24) | `--source council` only | No licence published | Needs council permission |

Caveat: the £1/hr locations in `tariff-rules.json` (47 short lists of bay centres) were copied
from the unlicensed tariff layer because no open source lists them. That's a small extraction,
but it isn't strictly covered until the council confirms. Ask the council GIS team, or re-verify
the list from street signage and replace it.

Required attribution: "Copyright City of Edinburgh Council, contains Ordnance Survey data © Crown
copyright and database right (year)", plus OS Open Roads' "Contains OS data © Crown copyright and
database right (year)". `meta.json` carries the right text for the active source mode, and the
legend shows it.
