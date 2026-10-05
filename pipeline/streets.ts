// Street naming: each bay takes the nearest named road centreline. Centrelines
// come from OS Open Roads in the open default, or from the council's Street
// Types layer (Transport 18) in council mode.

import { axisDifference, bboxOf, closestOnSegmentXY, GridIndex, toXY, type LngLat } from '../src/lib/geo';

export const STREET_RADIUS_M = 30;
/** Second pass for bays set back from the centreline on wide streets and squares. */
export const STREET_RADIUS_WIDE_M = 60;
/** Penalty (m) for a long bay lying perpendicular to a candidate street. */
const AXIS_PENALTY_M = 20;

export interface StreetLine {
  name: string;
  /** Road function/category, e.g. "Local Road" (OS) or "General Access Road" (council). */
  featureType: string;
  /** "Trunk" for trunk roads, else the road class. */
  classification: string;
  /** Council adoption status; empty when the source doesn't say. */
  adoption: string;
  coords: LngLat[];
}

interface Edge {
  street: StreetLine;
  a: [number, number];
  b: [number, number];
  angle: number;
}

/** Normalise council line features (LineString or MultiLineString) into named lines. */
export function streetLinesFrom(features: any[]): StreetLine[] {
  const out: StreetLine[] = [];
  for (const f of features) {
    const name = String(f.properties?.primary_ns ?? '').trim();
    if (!name || !f.geometry) continue;
    const parts: LngLat[][] =
      f.geometry.type === 'LineString'
        ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiLineString'
          ? f.geometry.coordinates
          : [];
    for (const coords of parts) {
      if (coords.length < 2) continue;
      out.push({
        name,
        featureType: String(f.properties?.feature_ty ?? ''),
        classification: String(f.properties?.classifica ?? ''),
        adoption: String(f.properties?.adoption_s ?? ''),
        coords,
      });
    }
  }
  return out;
}

export class StreetNamer {
  private index = new GridIndex<Edge>(100);

  constructor(lines: StreetLine[]) {
    for (const street of lines) {
      for (let i = 0; i < street.coords.length - 1; i++) {
        const a = toXY(street.coords[i]);
        const b = toXY(street.coords[i + 1]);
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (angle < 0) angle += Math.PI;
        this.index.insert({ street, a, b, angle }, bboxOf([street.coords[i], street.coords[i + 1]]));
      }
    }
  }

  /**
   * Best street for a bay: nearest named centreline, with a penalty when an
   * elongated bay lies across the street rather than along it (the usual
   * junction mix-up).
   */
  nameFor(centroid: LngLat, axis?: { angle: number; elongation: number }): { name: string; dist: number } | null {
    for (const radius of [STREET_RADIUS_M, STREET_RADIUS_WIDE_M]) {
      const p = toXY(centroid);
      let best: { name: string; score: number; dist: number } | null = null;
      for (const e of this.index.near(centroid, radius)) {
        const { dist } = closestOnSegmentXY(p, e.a, e.b);
        if (dist > radius) continue;
        let score = dist;
        if (axis && axis.elongation >= 2) score += AXIS_PENALTY_M * Math.sin(axisDifference(axis.angle, e.angle));
        if (!best || score < best.score) best = { name: e.street.name, score, dist };
      }
      if (best) return { name: best.name, dist: best.dist };
    }
    return null;
  }
}
