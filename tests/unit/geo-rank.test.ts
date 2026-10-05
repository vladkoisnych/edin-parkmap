import { describe, expect, it } from 'vitest';
import {
  axisDifference,
  distanceM,
  nearestOnLine,
  pointInPolygon,
  principalAxis,
  ringArea,
  ringCentroid,
  segmentIntersection,
  simplifyLine,
  type LngLat,
} from '../../src/lib/geo';
import { formatDistance, rankByDistance, walkMinutes } from '../../src/lib/rank';

// Roughly 1 m in each direction at Edinburgh's latitude.
const M_LAT = 1 / 111_320;
const M_LNG = 1 / 62_300;
const at = (eastM: number, northM: number, origin: LngLat = [-3.2, 55.95]): LngLat => [
  origin[0] + eastM * M_LNG,
  origin[1] + northM * M_LAT,
];

describe('geo', () => {
  it('measures short distances to within 1%', () => {
    expect(distanceM(at(0, 0), at(300, 400))).toBeCloseTo(500, -1);
  });

  it('finds the nearest point on a line', () => {
    const r = nearestOnLine(at(50, 10), [at(0, 0), at(100, 0)]);
    expect(r.dist).toBeCloseTo(10, 0);
    expect(distanceM(r.point, at(50, 0))).toBeLessThan(0.5);
  });

  it('tests points in polygons with holes', () => {
    const outer = [at(0, 0), at(100, 0), at(100, 100), at(0, 100), at(0, 0)];
    const hole = [at(40, 40), at(60, 40), at(60, 60), at(40, 60), at(40, 40)];
    expect(pointInPolygon(at(10, 10), [outer, hole])).toBe(true);
    expect(pointInPolygon(at(50, 50), [outer, hole])).toBe(false);
    expect(pointInPolygon(at(150, 50), [outer, hole])).toBe(false);
  });

  it('computes centroids of small bays without precision loss', () => {
    // A 1.5 m x 11 m bay, rotated 45°: the centroid must sit inside it.
    const d = (e: number, n: number) => at(e * Math.SQRT1_2 - n * Math.SQRT1_2, e * Math.SQRT1_2 + n * Math.SQRT1_2);
    const ring = [d(0, 0), d(11, 0), d(11, 1.5), d(0, 1.5), d(0, 0)];
    expect(distanceM(ringCentroid(ring), d(5.5, 0.75))).toBeLessThan(0.05);
    expect(Math.abs(ringArea(ring))).toBeCloseTo(16.5, 1);
  });

  it('finds the long axis of a kerbside bay', () => {
    const bay = [at(0, 0), at(30, 0), at(30, 2.5), at(0, 2.5), at(0, 0)];
    const { angle, elongation } = principalAxis(bay);
    expect(axisDifference(angle, 0)).toBeLessThan(0.01);
    expect(elongation).toBeGreaterThan(5);
  });

  it('intersects segments', () => {
    const x = segmentIntersection(at(-10, 0), at(10, 0), at(0, -10), at(0, 10));
    expect(x && distanceM(x, at(0, 0))).toBeLessThan(0.01);
    expect(segmentIntersection(at(-10, 0), at(10, 0), at(20, -10), at(20, 10))).toBeNull();
  });

  it('simplifies collinear points away', () => {
    const line = [at(0, 0), at(10, 0.1), at(20, 0), at(30, 0)];
    expect(simplifyLine(line, 1)).toHaveLength(2);
  });
});

describe('rankByDistance', () => {
  const dest = at(0, 0);
  const items = [
    { id: 'a1', street: 'Long Street', pts: [at(500, 0), at(100, 0)] },
    { id: 'a2', street: 'Long Street', pts: [at(50, 0)] },
    { id: 'b', street: 'Short Road', pts: [at(0, 80)] },
    { id: 'c', street: 'Far Place', pts: [at(0, 2000)] },
  ];

  it('orders by distance to each candidate’s nearest point', () => {
    const r = rankByDistance(dest, items, 10);
    expect(r.map((x) => x.item.id)).toEqual(['a2', 'b', 'c']);
    expect(r[0].distanceM).toBeCloseTo(50, -1);
  });

  it('keeps one result per street and honours the limit', () => {
    const r = rankByDistance(dest, items, 2);
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.item.street)).size).toBe(2);
  });

  it('estimates walking time at 80 m/min', () => {
    expect(walkMinutes(400)).toBe(5);
    expect(walkMinutes(10)).toBe(1);
    expect(formatDistance(437)).toBe('440 m');
    expect(formatDistance(1530)).toBe('1.5 km');
  });
});
