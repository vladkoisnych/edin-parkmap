// Free parking: the area outside every controlled zone, and the points
// where ordinary roads cross into it ("free entry points").

import {
  bboxOf,
  distanceM,
  GridIndex,
  pointInGeometry,
  ringArea,
  ringsOf,
  roundCoord,
  segmentIntersection,
  simplifyRing,
  toLngLat,
  toXY,
  type LngLat,
} from '../src/lib/geo';
import type { AreaGeom, Feature, FeatureCollection, FreePointProps, MultiPolygonGeom, PointGeom } from '../src/lib/types';
import type { StreetLine } from './streets';

/** Distance to step along the road past the boundary, so the point is clearly outside. */
export const ENTRY_STEP_M = 25;
/** Keep entry points on the same street at least this far apart. */
export const ENTRY_DEDUPE_M = 300;

/** Residential and local roads only: no trunk roads, bypass, footpaths or private roads. */
export function isParkableRoad(s: StreetLine): boolean {
  return (
    (s.featureType === 'General Access Road' || s.featureType === 'District / Local Distributor') &&
    s.classification !== 'Trunk' &&
    s.adoption.startsWith('Adopted')
  );
}

/** Simplify a (multi)polygon, dropping slivers smaller than minAreaM2. */
export function simplifyArea(geom: AreaGeom, toleranceM: number, minAreaM2: number): MultiPolygonGeom {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const out: LngLat[][][] = [];
  for (const poly of polys) {
    const [outer, ...holes] = poly;
    if (Math.abs(ringArea(outer)) < minAreaM2) continue;
    const so = simplifyRing(outer, toleranceM);
    if (!so) continue;
    const sh = holes
      .filter((h) => Math.abs(ringArea(h)) >= minAreaM2)
      .map((h) => simplifyRing(h, toleranceM))
      .filter((h): h is LngLat[] => !!h);
    out.push([so, ...sh].map((r) => r.map((c) => roundCoord(c, 5))));
  }
  return { type: 'MultiPolygon', coordinates: out };
}

interface Edge {
  a: LngLat;
  b: LngLat;
}

/**
 * Where parkable roads cross from a controlled zone into the free zone.
 * `controlled` are the CPZ and priority-area polygons; `free` is the
 * outside-CPZ polygon (unsimplified, for accurate tests).
 */
export function freeEntryPoints(
  streets: StreetLine[],
  controlled: AreaGeom[],
  free: AreaGeom,
): FeatureCollection<PointGeom, FreePointProps> {
  const edges = new GridIndex<Edge>(100);
  for (const g of controlled)
    for (const ring of ringsOf(g))
      for (let i = 0; i < ring.length - 1; i++) edges.insert({ a: ring[i], b: ring[i + 1] }, bboxOf([ring[i], ring[i + 1]]));

  const isControlled = (p: LngLat) => controlled.some((g) => pointInGeometry(p, g));
  const found = new Map<string, LngLat[]>();

  for (const s of streets) {
    if (!isParkableRoad(s)) continue;
    for (let i = 0; i < s.coords.length - 1; i++) {
      const p1 = s.coords[i];
      const p2 = s.coords[i + 1];
      for (const e of edges.inBBox(bboxOf([p1, p2]))) {
        const x = segmentIntersection(p1, p2, e.a, e.b);
        if (!x) continue;
        // Step along the road both ways; keep the side that is free.
        const [xx, xy] = toXY(x);
        const [ax, ay] = toXY(p1);
        const [bx, by] = toXY(p2);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        for (const dir of [1, -1]) {
          const q = toLngLat([xx + dir * ENTRY_STEP_M * ux, xy + dir * ENTRY_STEP_M * uy]);
          if (pointInGeometry(q, free) && !isControlled(q)) {
            const list = found.get(s.name) ?? [];
            if (!list.some((o) => distanceM(o, q) < ENTRY_DEDUPE_M)) list.push(q);
            found.set(s.name, list);
            break;
          }
        }
      }
    }
  }

  const features: Feature<PointGeom, FreePointProps>[] = [];
  for (const name of [...found.keys()].sort()) {
    found.get(name)!.forEach((p, n) => {
      const id = `free-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${n + 1}`;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: roundCoord(p, 5) }, properties: { id, street: name } });
    });
  }
  return { type: 'FeatureCollection', features };
}
