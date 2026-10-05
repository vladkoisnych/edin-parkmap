// Data contract between the build pipeline and the client.
// Files live in /data/ next to the app; see pipeline/run.ts.

import type { LngLat } from './geo';
import type { Tariff } from './tariff';

/**
 * pd: layer 13 pay & display. shared: layer 15 residents or pay & display.
 * area: a £1/hr tariff strip with no bay polygons drawn inside it; the strip
 * itself is the parking.
 */
export type BayKind = 'pd' | 'shared' | 'area';

export interface BayProps {
  /** Segment id this bay belongs to. */
  seg: string;
  /** Tariff code, key into Meta.tariffs. */
  t: string;
  k: BayKind;
  z: string;
}

export interface Segment {
  id: string;
  street: string;
  t: string;
  zone: string;
  kinds: BayKind[];
  bays: number;
  /** Approximate kerb length in metres. One council "bay" can be a 100 m strip. */
  kerbM: number;
  /** Where to place the price label and the maps hand-off. */
  label: LngLat;
  /** Bay centroids, for distance-to-nearest-bay ranking. */
  pts: LngLat[];
}

export interface FreePointProps {
  id: string;
  street: string;
}

export interface Meta {
  fetchedAt: string;
  /** "open" (OGL-only sources, the default) or "council" (the council's parking map layers). */
  sourceMode?: 'open' | 'council';
  /** Required attribution for the data in this snapshot. */
  attribution?: string;
  sources: Record<string, string>;
  counts: Record<string, number>;
  dropped: Record<string, number>;
  tariffs: Record<string, Tariff>;
}

export interface Feature<G, P> {
  type: 'Feature';
  id?: string | number;
  geometry: G;
  properties: P;
}
export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}
export interface PolygonGeom {
  type: 'Polygon';
  coordinates: LngLat[][];
}
export interface MultiPolygonGeom {
  type: 'MultiPolygon';
  coordinates: LngLat[][][];
}
export interface PointGeom {
  type: 'Point';
  coordinates: LngLat;
}
export interface LineGeom {
  type: 'LineString';
  coordinates: LngLat[];
}
export interface MultiLineGeom {
  type: 'MultiLineString';
  coordinates: LngLat[][];
}

export type AreaGeom = PolygonGeom | MultiPolygonGeom;
