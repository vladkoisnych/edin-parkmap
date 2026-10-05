// Freeze a small slice of the raw council layers into tests/fixtures, so
// tests never hit the council server. Run after `npm run data` has filled
// .cache/raw:  npm run data:fixtures
//
// The slice covers Stockbridge/Inverleith/Fettes: £1/hr strips (E, G, H),
// zone tariffs, shared-use bays and the CPZ edge with free streets beyond.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { bboxOf, ringsOf, type BBox, type LngLat } from '../src/lib/geo';
import { LAYERS } from './arcgis';

export const FIXTURE_BBOX: BBox = [-3.232, 55.955, -3.196, 55.972];

function coordsOf(g: any): LngLat[] {
  if (!g) return [];
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return ringsOf(g).flat();
  if (g.type === 'LineString') return g.coordinates;
  if (g.type === 'MultiLineString') return g.coordinates.flat();
  return [];
}

function intersects(a: BBox, b: BBox) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e7) / 1e7 : v);

await mkdir('tests/fixtures', { recursive: true });
for (const [key, id] of Object.entries(LAYERS)) {
  const fc = JSON.parse(await readFile(`.cache/raw/layer-${id}.geojson`, 'utf8'));
  // Keep whole features that touch the box, so polygons stay valid. Layer 24
  // is kept whole: its outside-CPZ polygon is the city.
  const features =
    key === 'cpzWithUncontrolled'
      ? fc.features.filter((f: any) => f.properties.Zone_Type === 'Outside the Controlled Parking Zone')
      : fc.features.filter((f: any) => {
          const c = coordsOf(f.geometry);
          return c.length && intersects(bboxOf(c), FIXTURE_BBOX);
        });
  await writeFile(`tests/fixtures/${key}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }, round));
  console.log(`${key}: ${features.length} of ${fc.features.length}`);
}
