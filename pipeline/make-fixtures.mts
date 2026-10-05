// Freeze a small slice of both source modes into tests/fixtures, so tests
// never hit the network. Run after `npm run data` (open) and
// `npm run data -- --source council` have filled .cache/raw:
//   npm run data:fixtures
//
// The slice covers Stockbridge/Inverleith/Fettes: £1/hr strips (E, G, H),
// zone tariffs, shared-use bays and the CPZ edge with free streets beyond.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { bboxOf, ringsOf, type BBox, type LngLat } from '../src/lib/geo';
import { loadOsRoads } from './osroads';

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

const touches = (f: any) => {
  const c = coordsOf(f.geometry);
  return c.length > 0 && intersects(bboxOf(c), FIXTURE_BBOX);
};
const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e7) / 1e7 : v);

async function slice(cacheName: string, out: string, keep: (f: any) => boolean = touches) {
  const fc = JSON.parse(await readFile(`.cache/raw/${cacheName}.geojson`, 'utf8'));
  const features = fc.features.filter(keep);
  await writeFile(out, JSON.stringify({ type: 'FeatureCollection', features }, round));
  console.log(`${out}: ${features.length} of ${fc.features.length}`);
}

await mkdir('tests/fixtures/council', { recursive: true });
await mkdir('tests/fixtures/open', { recursive: true });

for (const key of ['cpz', 'payDisplay', 'shared', 'tariffs', 'streets']) {
  await slice(`council-${key}`, `tests/fixtures/council/${key}.geojson`);
}
// Layer 24's outside-CPZ polygon is the city; keep it whole.
await slice('council-cpzWithUncontrolled', 'tests/fixtures/council/cpzWithUncontrolled.geojson', (f) =>
  f.properties.Zone_Type === 'Outside the Controlled Parking Zone',
);

for (const key of ['bays', 'cpz', 'wards']) await slice(`open-${key}`, `tests/fixtures/open/${key}.geojson`);
const roads = await loadOsRoads(FIXTURE_BBOX, '.cache/raw');
await writeFile('tests/fixtures/open/roads.json', JSON.stringify(roads.lines, round));
console.log(`tests/fixtures/open/roads.json: ${roads.lines.length} lines (OS Open Roads ${roads.release})`);
