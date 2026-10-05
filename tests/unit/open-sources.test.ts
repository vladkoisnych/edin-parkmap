import { describe, expect, it } from 'vitest';
import { pointInGeometry, ringArea, type LngLat } from '../../src/lib/geo';
import { freeZoneFromBoundary, isParkableRoad } from '../../pipeline/freezone';
import { parseDbf, parseShpPolylines } from '../../pipeline/osroads';
import { RulesResolver, type TariffRules } from '../../pipeline/tariff-rules';

const M_LAT = 1 / 111_320;
const M_LNG = 1 / 62_300;
const at = (eastM: number, northM: number): LngLat => [-3.2 + eastM * M_LNG, 55.95 + northM * M_LAT];
const square = (x0: number, y0: number, x1: number, y1: number) => ({
  type: 'Polygon' as const,
  coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]],
});

describe('RulesResolver', () => {
  const weekday = 'Mon-Fri, 8:30am-5:30pm';
  const rules: TariffRules = {
    provenance: [],
    tariffs: {
      D: { Charge: 'Charge D', Cost: '£4.20/hr', Hours: weekday },
      C1: { Charge: 'Charge C1', Cost: '£6/hr', Hours: weekday },
      E: { Charge: 'Charge E', Cost: '£1/hr', Hours: weekday, Remarks: 'max 9 hr stay' },
    },
    zones: { N1: 'D' },
    streets: [{ street: "St Giles' Street", zone: 'N1', code: 'C1' }],
    cheap: [{ street: 'Fettes Avenue', code: 'E', pts: [at(0, 0), at(20, 0)] }],
  };
  const r = new RulesResolver(rules);

  it('prefers a £1/hr location, then a street exception, then the zone default', () => {
    expect(r.codeFor({ centroid: at(21, 1), zone: 'N1', street: 'Anything' })).toEqual({ code: 'E', via: 'cheap' });
    expect(r.codeFor({ centroid: at(500, 0), zone: 'N1', street: 'St Giles Street' })).toEqual({ code: 'C1', via: 'street' });
    expect(r.codeFor({ centroid: at(500, 0), zone: 'N1', street: 'Other Road' })).toEqual({ code: 'D', via: 'zone' });
    expect(r.codeFor({ centroid: at(500, 0), zone: 'Z9', street: 'Other Road' })).toBeNull();
  });

  it('only matches £1/hr points within a few metres', () => {
    expect(r.codeFor({ centroid: at(10, 0), zone: 'N1', street: 'Fettes Avenue' })?.code).toBe('D');
  });

  it('builds tariffs and reports rules that use unknown codes', () => {
    expect(r.tariffs.E).toMatchObject({ cheap: true, maxStayHours: 9 });
    expect(r.errors).toEqual([]);
    const bad = new RulesResolver({ ...rules, zones: { N1: 'X' } });
    expect(bad.errors.join()).toMatch(/unknown tariff X/);
  });
});

describe('freeZoneFromBoundary', () => {
  it('is the city minus the controlled zones', () => {
    const city = [square(0, 0, 500, 1000), square(500, 0, 1000, 1000)]; // two wards
    const zone = square(400, 400, 600, 600);
    const free = freeZoneFromBoundary(city, [zone]);
    expect(pointInGeometry(at(100, 100), free)).toBe(true);
    expect(pointInGeometry(at(500, 500), free)).toBe(false);
    const area = free.coordinates.reduce((s, poly) => s + Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
    expect(area).toBeCloseTo(1000 * 1000 - 200 * 200, -3);
  });
});

describe('isParkableRoad', () => {
  const road = (featureType: string, classification = 'Unclassified', adoption = '') => ({ name: 'X', featureType, classification, adoption, coords: [] });
  it('keeps local roads from either source and drops main, trunk and private roads', () => {
    expect(isParkableRoad(road('Local Road'))).toBe(true);
    expect(isParkableRoad(road('General Access Road', 'LA Non Principal', 'Adopted'))).toBe(true);
    expect(isParkableRoad(road('A Road'))).toBe(false);
    expect(isParkableRoad(road('Local Road', 'Trunk'))).toBe(false);
    expect(isParkableRoad(road('Restricted Local Access Road'))).toBe(false);
    expect(isParkableRoad(road('General Access Road', 'LA Non Principal', 'Private'))).toBe(false);
  });
});

describe('OS Open Roads file parsing', () => {
  it('reads dBase records', () => {
    const fields = [
      ['name1', 12],
      ['function', 10],
    ] as const;
    const recordLen = 1 + fields.reduce((s, [, l]) => s + l, 0);
    const headerLen = 32 + fields.length * 32 + 1;
    const buf = Buffer.alloc(headerLen + recordLen * 2);
    buf.writeUInt32LE(2, 4);
    buf.writeUInt16LE(headerLen, 8);
    buf.writeUInt16LE(recordLen, 10);
    fields.forEach(([name, len], i) => {
      buf.write(name, 32 + i * 32, 'latin1');
      buf[32 + i * 32 + 11] = 'C'.charCodeAt(0);
      buf[32 + i * 32 + 16] = len;
    });
    buf[headerLen - 1] = 0x0d;
    const row = (i: number, a: string, b: string) => {
      const off = headerLen + i * recordLen;
      buf[off] = 0x20;
      buf.write(a.padEnd(12), off + 1, 'utf8');
      buf.write(b.padEnd(10), off + 13, 'utf8');
    };
    row(0, 'Rose Street', 'Local Road');
    row(1, 'Leith Walk', 'A Road');
    expect(parseDbf(buf)).toEqual([
      { name1: 'Rose Street', function: 'Local Road' },
      { name1: 'Leith Walk', function: 'A Road' },
    ]);
  });

  it('reads polyline shapes with multiple parts', () => {
    const pts = [
      [325000, 673000],
      [325010, 673000],
      [325020, 673005],
    ];
    const content = 44 + 2 * 4 + pts.length * 16;
    const buf = Buffer.alloc(100 + 8 + content);
    buf.writeInt32BE(1, 100);
    buf.writeInt32BE(content / 2, 104);
    const rec = 108;
    buf.writeInt32LE(3, rec);
    buf.writeInt32LE(2, rec + 36);
    buf.writeInt32LE(pts.length, rec + 40);
    buf.writeInt32LE(0, rec + 44);
    buf.writeInt32LE(2, rec + 48);
    pts.forEach(([x, y], i) => {
      buf.writeDoubleLE(x, rec + 52 + i * 16);
      buf.writeDoubleLE(y, rec + 60 + i * 16);
    });
    expect(parseShpPolylines(buf)).toEqual([[[pts[0], pts[1]], [pts[2]]]]);
  });
});
