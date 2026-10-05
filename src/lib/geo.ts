// Small planar geometry helpers. Edinburgh spans ~20 km, so a local
// equirectangular projection is accurate to well under 1% and far cheaper
// than geodesic maths, which matters on phones and in the build join.

export type LngLat = [number, number];
export type Ring = LngLat[];
export type PolygonCoords = Ring[];
export type MultiPolygonCoords = PolygonCoords[];

const REF_LAT = 55.95;
export const M_PER_DEG_LAT = 111_320;
export const M_PER_DEG_LNG = 111_320 * Math.cos((REF_LAT * Math.PI) / 180);

/** Project lng/lat to local metres (x east, y north). */
export function toXY([lng, lat]: LngLat): [number, number] {
  return [lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT];
}

export function toLngLat([x, y]: [number, number]): LngLat {
  return [x / M_PER_DEG_LNG, y / M_PER_DEG_LAT];
}

/** Straight-line distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  const dx = (a[0] - b[0]) * M_PER_DEG_LNG;
  const dy = (a[1] - b[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Closest point on segment ab to p, all in projected metres. */
export function closestOnSegmentXY(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { point: [number, number]; dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point: [number, number] = [a[0] + t * dx, a[1] + t * dy];
  return { point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]), t };
}

/** Distance in metres from p to a polyline, plus the nearest point on it. */
export function nearestOnLine(p: LngLat, line: LngLat[]): { point: LngLat; dist: number; index: number } {
  const pp = toXY(p);
  let best = { point: line[0], dist: Infinity, index: 0 };
  if (line.length === 1) return { point: line[0], dist: distanceM(p, line[0]), index: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const r = closestOnSegmentXY(pp, toXY(line[i]), toXY(line[i + 1]));
    if (r.dist < best.dist) best = { point: toLngLat(r.point), dist: r.dist, index: i };
  }
  return best;
}

function pointInRing(pt: LngLat, ring: Ring): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt: LngLat, poly: PolygonCoords): boolean {
  if (!pointInRing(pt, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(pt, poly[i])) return false;
  return true;
}

export function pointInGeometry(pt: LngLat, geom: { type: string; coordinates: unknown }): boolean {
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates as PolygonCoords);
  if (geom.type === 'MultiPolygon') return (geom.coordinates as MultiPolygonCoords).some((p) => pointInPolygon(pt, p));
  return false;
}

/** All rings of a (multi)polygon, for distance-to-edge checks. */
export function ringsOf(geom: { type: string; coordinates: unknown }): Ring[] {
  if (geom.type === 'Polygon') return geom.coordinates as Ring[];
  if (geom.type === 'MultiPolygon') return (geom.coordinates as MultiPolygonCoords).flat();
  return [];
}

/** Distance from p to the nearest polygon edge, in metres. */
export function distanceToEdges(p: LngLat, geom: { type: string; coordinates: unknown }): number {
  let best = Infinity;
  for (const ring of ringsOf(geom)) best = Math.min(best, nearestOnLine(p, ring).dist);
  return best;
}

/**
 * Area-weighted centroid of a polygon's outer ring (falls back to vertex mean).
 * Works relative to the first vertex: with absolute projected coordinates
 * (y ≈ 6.2e6 m) the shoelace products cancel badly and a small bay's
 * centroid can land metres away from the bay.
 */
export function ringCentroid(ring: Ring): LngLat {
  const [ox, oy] = toXY(ring[0]);
  const pts = ring.map((c) => {
    const [x, y] = toXY(c);
    return [x - ox, y - oy];
  });
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += f;
    cx += (pts[j][0] + pts[i][0]) * f;
    cy += (pts[j][1] + pts[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length;
    return toLngLat([ox + pts.reduce((s, q) => s + q[0], 0) / n, oy + pts.reduce((s, q) => s + q[1], 0) / n]);
  }
  return toLngLat([ox + cx / (3 * a), oy + cy / (3 * a)]);
}

export function geometryCentroid(geom: { type: string; coordinates: unknown }): LngLat {
  if (geom.type === 'Polygon') return ringCentroid((geom.coordinates as PolygonCoords)[0]);
  if (geom.type === 'MultiPolygon') {
    // Use the largest part: multi-part bays are rare and their parts are adjacent.
    const parts = geom.coordinates as MultiPolygonCoords;
    let best = parts[0];
    let bestArea = -1;
    for (const p of parts) {
      const area = Math.abs(ringArea(p[0]));
      if (area > bestArea) {
        bestArea = area;
        best = p;
      }
    }
    return ringCentroid(best[0]);
  }
  throw new Error(`Unsupported geometry ${geom.type}`);
}

/** Signed area in m². */
export function ringArea(ring: Ring): number {
  const [ox, oy] = toXY(ring[0]);
  const pts = ring.map((c) => {
    const [x, y] = toXY(c);
    return [x - ox, y - oy];
  });
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

/**
 * Principal axis of a polygon outline: the bearing (radians, 0..π) of its
 * longest edge and how elongated it is. Kerbside bays are long and thin and
 * run parallel to their street, which helps pick the right street at junctions.
 */
export function principalAxis(ring: Ring): { angle: number; elongation: number; length: number } {
  const pts = ring.map(toXY);
  let bestLen = 0;
  let angle = 0;
  let perimeter = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    perimeter += len;
    if (len > bestLen) {
      bestLen = len;
      angle = Math.atan2(dy, dx);
    }
  }
  if (angle < 0) angle += Math.PI;
  const width = Math.max(perimeter / 2 - bestLen, 0.1);
  return { angle, elongation: bestLen / width, length: bestLen };
}

/** Smallest angle between two undirected bearings, 0..π/2. */
export function axisDifference(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** Douglas–Peucker simplification in metres. Keeps closed rings closed. */
export function simplifyLine(line: LngLat[], toleranceM: number): LngLat[] {
  if (line.length <= 2) return line.slice();
  const pts = line.map(toXY);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = closestOnSegmentXY(pts[i], pts[s], pts[e]).dist;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

export function simplifyRing(ring: Ring, toleranceM: number): Ring | null {
  // Split a closed ring in two so DP has distinct endpoints to anchor on.
  if (ring.length < 5) return ring;
  const mid = Math.floor(ring.length / 2);
  const a = simplifyLine(ring.slice(0, mid + 1), toleranceM);
  const b = simplifyLine(ring.slice(mid), toleranceM);
  const out = [...a, ...b.slice(1)];
  if (out.length < 4) return null;
  return out;
}

export function roundCoord([lng, lat]: LngLat, dp = 6): LngLat {
  const f = 10 ** dp;
  return [Math.round(lng * f) / f, Math.round(lat * f) / f];
}

/** Intersection point of segments p1p2 and p3p4, if any (lng/lat in, lng/lat out). */
export function segmentIntersection(p1: LngLat, p2: LngLat, p3: LngLat, p4: LngLat): LngLat | null {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (d === 0) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

export type BBox = [number, number, number, number];

export function bboxOf(coords: LngLat[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Uniform grid index over items with bounding boxes, for "what is near this
 * point" queries. Cell size is in metres.
 */
export class GridIndex<T> {
  private cells = new Map<string, T[]>();
  constructor(private cellM: number) {}

  private key(ix: number, iy: number) {
    return `${ix},${iy}`;
  }

  insert(item: T, bbox: BBox): void {
    const [x0, y0] = toXY([bbox[0], bbox[1]]);
    const [x1, y1] = toXY([bbox[2], bbox[3]]);
    for (let ix = Math.floor(x0 / this.cellM); ix <= Math.floor(x1 / this.cellM); ix++) {
      for (let iy = Math.floor(y0 / this.cellM); iy <= Math.floor(y1 / this.cellM); iy++) {
        const k = this.key(ix, iy);
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = []));
        cell.push(item);
      }
    }
  }

  /** Items whose cells fall within radiusM of p (a superset; caller filters). */
  near(p: LngLat, radiusM: number): T[] {
    const [x, y] = toXY(p);
    return this.cellsIn(x - radiusM, y - radiusM, x + radiusM, y + radiusM);
  }

  /** Items whose cells overlap a lng/lat bbox (a superset; caller filters). */
  inBBox(bbox: BBox): T[] {
    const [x0, y0] = toXY([bbox[0], bbox[1]]);
    const [x1, y1] = toXY([bbox[2], bbox[3]]);
    return this.cellsIn(x0, y0, x1, y1);
  }

  private cellsIn(x0: number, y0: number, x1: number, y1: number): T[] {
    const out = new Set<T>();
    for (let ix = Math.floor(x0 / this.cellM); ix <= Math.floor(x1 / this.cellM); ix++) {
      for (let iy = Math.floor(y0 / this.cellM); iy <= Math.floor(y1 / this.cellM); iy++) {
        for (const item of this.cells.get(this.key(ix, iy)) ?? []) out.add(item);
      }
    }
    return [...out];
  }
}
