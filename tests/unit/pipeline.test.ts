import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { distanceM, geometryCentroid, pointInGeometry, type LngLat } from '../../src/lib/geo';
import { build, type BuildOutput } from '../../pipeline/build';
import { fromCouncil, fromOpen, type BuildInputs } from '../../pipeline/sources';
import { RULES_FILE } from '../../pipeline/tariff-rules';
import { TariffJoiner } from '../../pipeline/join';
import { buildSegments } from '../../pipeline/segments';
import { StreetNamer } from '../../pipeline/streets';
import { validate } from '../../pipeline/validate';

const M_LAT = 1 / 111_320;
const M_LNG = 1 / 62_300;
const at = (eastM: number, northM: number): LngLat => [-3.2 + eastM * M_LNG, 55.95 + northM * M_LAT];
const square = (x0: number, y0: number, x1: number, y1: number) => ({
  type: 'Polygon' as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});

describe('TariffJoiner', () => {
  const joiner = new TariffJoiner([
    { code: 'D', geometry: square(0, 0, 1000, 1000) },
    { code: 'E', geometry: square(100, 100, 300, 120) }, // £1 strip inside the D zone
  ]);

  it('prefers the most specific (smallest) containing polygon', () => {
    expect(joiner.codeAt(at(200, 110))).toEqual({ code: 'E', via: 'inside' });
    expect(joiner.codeAt(at(500, 500))).toEqual({ code: 'D', via: 'inside' });
  });

  it('falls back to the nearest polygon within 20 m', () => {
    expect(joiner.codeAt(at(1010, 500))).toEqual({ code: 'D', via: 'nearest' });
    expect(joiner.codeAt(at(1030, 500))).toBeNull();
  });
});

describe('StreetNamer', () => {
  // A junction: Main Street runs east-west, Side Road runs north from x=0.
  const namer = new StreetNamer([
    { name: 'Main Street', featureType: '', classification: '', adoption: '', coords: [at(-200, 0), at(200, 0)] },
    { name: 'Side Road', featureType: '', classification: '', adoption: '', coords: [at(0, 0), at(0, 200)] },
  ]);

  it('names a bay by the nearest centreline within 30 m', () => {
    expect(namer.nameFor(at(100, 6))?.name).toBe('Main Street');
    expect(namer.nameFor(at(5, 100))?.name).toBe('Side Road');
    expect(namer.nameFor(at(500, 500))).toBeNull();
  });

  it('uses bay orientation to resolve junction ambiguity', () => {
    // Slightly closer to Side Road, but the bay runs east-west like Main Street.
    const p = at(6, 7);
    expect(namer.nameFor(p)?.name).toBe('Side Road');
    expect(namer.nameFor(p, { angle: 0, elongation: 6 })?.name).toBe('Main Street');
  });
});

describe('buildSegments', () => {
  // A kerbside bay from x0 to x1 metres along y=0, 2.5 m deep.
  const bay = (index: number, x0: number, x1: number, street = 'Main Street', code = 'E') => ({
    index,
    street,
    code,
    zone: 'N1',
    kind: 'pd' as const,
    centroid: at((x0 + x1) / 2, 1.25),
    outline: [at(x0, 0), at(x1, 0), at(x1, 2.5), at(x0, 2.5), at(x0, 0)],
  });

  it('chains nearby bays on the same street and tariff, splitting distant runs', () => {
    const { segments, segOf } = buildSegments([
      bay(0, 0, 12),
      bay(1, 20, 32), // 8 m gap (a driveway): same run
      bay(2, 40, 52),
      bay(3, 500, 512), // far away: new segment
      bay(4, 14, 18, 'Main Street', 'D'), // different tariff: new segment
    ]);
    expect(segments).toHaveLength(3);
    expect(segOf.get(0)).toBe(segOf.get(2));
    expect(segOf.get(3)).not.toBe(segOf.get(0));
    expect(segOf.get(4)).not.toBe(segOf.get(0));
    const first = segments.find((s) => s.id === segOf.get(0))!;
    expect(first).toMatchObject({ street: 'Main Street', t: 'E', bays: 3, zone: 'N1' });
    expect(first.kerbM).toBeCloseTo(36, -1);
  });

  it('joins long strips that touch even though their centroids are far apart', () => {
    const { segments } = buildSegments([bay(0, 0, 150), bay(1, 155, 300)]);
    expect(segments).toHaveLength(1);
  });
});

const load = (path: string) => JSON.parse(readFileSync(`tests/fixtures/${path}`, 'utf8'));

const modes: [string, () => BuildInputs][] = [
  [
    'open (default)',
    () =>
      fromOpen(
        { bays: load('open/bays.geojson'), cpz: load('open/cpz.geojson'), wards: load('open/wards.geojson'), roads: load('open/roads.json'), roadsRelease: 'fixture' },
        JSON.parse(readFileSync(RULES_FILE, 'utf8')),
      ),
  ],
  [
    'council',
    () =>
      fromCouncil({
        tariffs: load('council/tariffs.geojson'),
        payDisplay: load('council/payDisplay.geojson'),
        shared: load('council/shared.geojson'),
        streets: load('council/streets.geojson'),
        cpz: load('council/cpz.geojson'),
        cpzWithUncontrolled: load('council/cpzWithUncontrolled.geojson'),
      }),
  ],
];

describe.each(modes)('build on the frozen fixture: %s sources', (_name, inputs) => {
  let input: BuildInputs;
  let out: BuildOutput;

  beforeAll(() => {
    input = inputs();
    out = build(input);
  });

  it('passes validation', () => {
    expect(validate(out)).toEqual([]);
  });

  it('finds £1/hr bays on the known long-stay streets', () => {
    const cheapStreets = new Set(out.segments.filter((s) => out.tariffs[s.t].cheap).map((s) => s.street));
    for (const s of ['Fettes Avenue', 'Inverleith Place', 'Arboretum Place']) expect(cheapStreets).toContain(s);
    expect(out.counts.cheapBays).toBeGreaterThan(20);
  });

  it('joins every bay to a known tariff and segment', () => {
    const segIds = new Set(out.segments.map((s) => s.id));
    for (const b of out.bays.features) {
      expect(out.tariffs[b.properties.t]).toBeDefined();
      expect(segIds.has(b.properties.seg)).toBe(true);
    }
  });

  it('parses every tariff schedule', () => {
    for (const t of Object.values(out.tariffs)) expect(t.schedule.length).toBeGreaterThan(0);
  });

  it('puts free entry points in the free zone, outside every CPZ', () => {
    expect(out.freePoints.features.length).toBeGreaterThan(3);
    for (const f of out.freePoints.features) {
      const p = f.geometry.coordinates;
      expect(pointInGeometry(p, input.freeZone!)).toBe(true);
      expect(input.controlled.some((g) => pointInGeometry(p, g))).toBe(false);
    }
  });

  it('dedupes entry points along a street', () => {
    const byStreet = new Map<string, LngLat[]>();
    for (const f of out.freePoints.features) byStreet.set(f.properties.street, [...(byStreet.get(f.properties.street) ?? []), f.geometry.coordinates]);
    for (const pts of byStreet.values())
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(distanceM(pts[i], pts[j])).toBeGreaterThanOrEqual(300);
  });

  it('flags large swings against the previous run', () => {
    const prev = { ...out.counts, bays: out.counts.bays * 2 };
    expect(validate(out, prev).join()).toMatch(/bays changed by/);
  });
});

describe('open and council sources agree on the fixture', () => {
  it('prices the same bays the same way', () => {
    const [open, council] = modes.map(([, f]) => build(f()));
    const key = (b: any) => geometryCentroid(b.geometry).map((x: number) => x.toFixed(5)).join(',');
    const councilCode = new Map(council.bays.features.map((b) => [key(b), b.properties.t]));
    let same = 0;
    let matched = 0;
    for (const b of open.bays.features) {
      const c = councilCode.get(key(b));
      if (c == null) continue;
      matched++;
      if (c === b.properties.t) same++;
    }
    expect(matched).toBeGreaterThan(300);
    expect(same / matched).toBeGreaterThan(0.98);
  });
});
