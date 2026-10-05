# Edinburgh Cheap Parking

A static, touch-first map of Edinburgh on-street parking by price. £1/hr bays stand out, free
parking outside the controlled zones is shaded, tapping a bay copies `Street, Edinburgh`, and an
address search ranks the nearest cheap and free options. See
[the spec](./Edinburgh%20Cheap%20Parking%20Map%20Spec.md).

No backend, no API keys. A weekly GitHub Action rebuilds the data and deploys to GitHub Pages.

## Develop

```sh
npm install
npm run data        # fetch council layers -> public/data (add --cache to reuse .cache/raw)
npm run dev         # http://localhost:5173
npm test            # unit tests (pipeline runs against tests/fixtures, no network)
npm run build && npm run e2e   # Playwright, Pixel 7 + iPhone 14 emulation
```

Node ≥ 22.15. `npm run data:fixtures` re-freezes the test fixture slice from `.cache/raw`;
`npx tsx scripts/icons.mts` re-renders the PNG icons from `public/icon.svg`.

## Layout

| Path | What |
| --- | --- |
| `pipeline/` | Build-time data: fetch (`arcgis.ts`), tariff join (`join.ts`), street naming (`streets.ts`), segments, free zone + entry points, validation, `run.ts` |
| `src/lib/` | Shared by pipeline and client: geometry, hours parser, tariffs, ranking, data contract (`types.ts`) |
| `src/app/` | Client: Leaflet map, bottom sheet, search/geocoding, clipboard, views |
| `tests/unit`, `tests/e2e`, `tests/fixtures` | Vitest, Playwright, frozen council data slice |

## Data notes (differences from the spec, found while building)

- **Free zone comes straight from the council.** MapServer layer 24 has an "Outside the
  Controlled Parking Zone" polygon, and layer 4 has the CPZ and priority-area polygons, so nothing
  is derived from tariff buffers.
- **Street names come from the council, not OSM.** Layer 18 (Street Types) has named
  centrelines. Each bay takes the nearest one within 30 m (60 m second pass). A bay lying across a
  street is penalised, which fixes most junction mix-ups. Overpass and Nominatim aren't needed at
  build time.
- **£1/hr tariffs are small strips drawn on top of the zone tariff.** The E/G/H polygons sit
  inside the large Charge D zones. The join picks the *smallest* containing polygon. Without that
  rule only 1 cheap bay is found; with it there are 125. One £1 strip has no bay polygons inside, so
  the strip itself is shown as the bay (`kind: "area"`).
- **The layers are stored in British National Grid (OSGB36).** Asking the server for WGS84 without
  `datumTransformation` puts everything about 90 m east of the basemap. The fetch requests transform
  1314 (OSGB36→WGS84, ~2 m), and each live run first compares one server-reprojected vertex with an
  independent Helmert conversion (`pipeline/datum.ts`), failing if they differ by more than 15 m.
- One council "bay" polygon can be a 100 m strip, so the app shows kerb length and an approximate
  car count instead of a bay count.
- Free entry points: where adopted residential or local roads cross out of the CPZ, stepped 25 m
  into the free zone, at most one per street every 300 m.
- `meta.json` records counts and drops (e.g. bays with no tariff match) for each run. Validation
  fails the refresh when a key count moves more than 20%. The last good snapshot stays live and an
  issue is opened.

## Deploying

1. Push to a public GitHub repo with Pages enabled, source **GitHub Actions**.
2. The workflow runs on push, weekly, and on demand. Use the `skip_drift` input to accept a
   legitimate big change in counts.

## Licensing

**Code:** MIT (see `LICENSE`). The licence does not cover the data.

**Data** (checked 5 Oct 2026):

| Source | Used for | Terms | Status |
| --- | --- | --- | --- |
| Council *Parking Bays* (Transport layers 13/15; same dataset as open INSPIRE layer 11) | Bay geometry, zone, type | [OGL v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/), attribution required | OK |
| Council *Controlled Parking Zones* (Transport 4; open INSPIRE layer 12) | Free-zone edges | OGL v3.0, attribution required | OK |
| Council *Parking Tariff Area* (Transport 16) | Prices and hours | No licence published. The web map says only "© Crown copyright and database rights Ordnance Survey 0100023420" plus a disclaimer | **Needs council permission** |
| Council *Street Types* (Transport 18) | Street names | No licence published | **Needs permission**, or switch to OS Open Roads (OGL) |
| Council *CPZ with Uncontrolled Zones* (Transport 24) | Free-zone polygon | No licence published | **Needs permission**, or derive from city boundary (OGL) minus CPZ |
| OpenStreetMap tiles | Basemap | ODbL attribution, [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) | OK at low volume. Move to a commercial tile host if traffic grows |
| Nominatim | Address search | [Usage policy](https://operations.osmfoundation.org/policies/nominatim/): ≤1 req/s, no autocomplete, identifying Referer | OK (submit only, no autocomplete) |
| postcodes.io | Postcode search | ONS/OS/Royal Mail data under OGL, attribution | OK |

Required attribution for the council data: "Copyright City of Edinburgh Council, contains Ordnance
Survey data © Crown copyright and database right (year)". It appears in the legend and on the map.
