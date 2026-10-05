import type {
  AreaGeom,
  BayProps,
  FeatureCollection,
  FreePointProps,
  Meta,
  MultiPolygonGeom,
  PointGeom,
  Segment,
} from '../lib/types';

export interface AppData {
  meta: Meta;
  segments: Segment[];
  segById: Map<string, Segment>;
  bays: FeatureCollection<AreaGeom, BayProps>;
  freeZone: FeatureCollection<MultiPolygonGeom, Record<string, never>>;
  freePoints: FeatureCollection<PointGeom, FreePointProps>;
}

const base = `${import.meta.env.BASE_URL}data/`;

async function get<T>(name: string): Promise<T> {
  const res = await fetch(base + name);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return res.json() as Promise<T>;
}

export async function loadData(): Promise<AppData> {
  const [meta, segments, bays, freeZone, freePoints] = await Promise.all([
    get<Meta>('meta.json'),
    get<Segment[]>('segments.json'),
    get<AppData['bays']>('bays.geojson'),
    get<AppData['freeZone']>('free-zone.geojson'),
    get<AppData['freePoints']>('free-points.geojson'),
  ]);
  return { meta, segments, segById: new Map(segments.map((s) => [s.id, s])), bays, freeZone, freePoints };
}
