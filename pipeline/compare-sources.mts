// Compare the open build with the council build, bay by bay (matched by
// location). Run after both caches exist:  npx tsx pipeline/compare-sources.mts
import { distanceM, geometryCentroid, GridIndex } from '../src/lib/geo';
import { build } from './build';
import { fetchCouncil, fetchOpen, fromCouncil, fromOpen } from './sources';
import { loadRules } from './tariff-rules';

const cache = { cacheDir: '.cache/raw', useCache: true };
const open = build(fromOpen(await fetchOpen(cache), await loadRules()));
const council = build(fromCouncil(await fetchCouncil(cache)));

const index = new GridIndex<{ c: [number, number]; t: string; street: string }>(50);
const cSeg = new Map(council.segments.map((s) => [s.id, s]));
for (const b of council.bays.features) {
  const c = geometryCentroid(b.geometry);
  index.insert({ c, t: b.properties.t, street: cSeg.get(b.properties.seg)!.street }, [c[0], c[1], c[0], c[1]]);
}
const oSeg = new Map(open.segments.map((s) => [s.id, s]));
let matched = 0, sameTariff = 0, sameStreet = 0, cheapBoth = 0, cheapOpenOnly = 0, cheapCouncilOnly = 0;
const tariffDiffs = new Map<string, number>();
const streetDiffs: string[] = [];
for (const b of open.bays.features) {
  const c = geometryCentroid(b.geometry);
  const m = index.near(c, 2).find((x) => distanceM(x.c, c) < 1);
  if (!m) continue;
  matched++;
  const street = oSeg.get(b.properties.seg)!.street;
  if (m.t === b.properties.t) sameTariff++;
  else tariffDiffs.set(`${m.t}->${b.properties.t}`, (tariffDiffs.get(`${m.t}->${b.properties.t}`) ?? 0) + 1);
  if (m.street === street) sameStreet++;
  else if (streetDiffs.length < 12) streetDiffs.push(`${m.street} -> ${street}`);
  const oc = open.tariffs[b.properties.t].cheap, cc = council.tariffs[m.t].cheap;
  if (oc && cc) cheapBoth++;
  else if (oc) cheapOpenOnly++;
  else if (cc) cheapCouncilOnly++;
}
const pct = (n: number) => `${((n / matched) * 100).toFixed(1)}%`;
console.log(`bays: open ${open.counts.bays}, council ${council.counts.bays}, matched ${matched}`);
console.log(`same tariff: ${sameTariff} (${pct(sameTariff)}); differences:`, Object.fromEntries(tariffDiffs));
console.log(`£1/hr: both ${cheapBoth}, open only ${cheapOpenOnly}, council only ${cheapCouncilOnly}`);
console.log(`same street name: ${sameStreet} (${pct(sameStreet)}); e.g.`, streetDiffs);
console.log(`free points: open ${open.counts.freePoints}, council ${council.counts.freePoints}`);
