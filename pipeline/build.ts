// Pure transform: raw council layers in, app data files out.

import { geometryCentroid, pointInGeometry, principalAxis, roundCoord, simplifyRing, type LngLat } from '../src/lib/geo';
import { tariffFromProps, type Tariff } from '../src/lib/tariff';
import type {
  AreaGeom,
  BayKind,
  BayProps,
  Feature,
  FeatureCollection,
  FreePointProps,
  MultiPolygonGeom,
  PointGeom,
  PolygonGeom,
  Segment,
} from '../src/lib/types';
import { freeEntryPoints, simplifyArea } from './freezone';
import { TariffJoiner, type TariffArea } from './join';
import { buildSegments, type NamedBay } from './segments';
import { StreetNamer, streetLinesFrom } from './streets';

export interface RawLayers {
  tariffs: FeatureCollection<any, any>;
  payDisplay: FeatureCollection<any, any>;
  shared: FeatureCollection<any, any>;
  streets: FeatureCollection<any, any>;
  cpz: FeatureCollection<any, any>;
  cpzWithUncontrolled: FeatureCollection<any, any>;
}

export interface BuildOutput {
  bays: FeatureCollection<PolygonGeom | MultiPolygonGeom, BayProps>;
  tariffAreas: FeatureCollection<MultiPolygonGeom, { t: string }>;
  segments: Segment[];
  freeZone: FeatureCollection<MultiPolygonGeom, Record<string, never>>;
  freePoints: FeatureCollection<PointGeom, FreePointProps>;
  tariffs: Record<string, Tariff>;
  counts: Record<string, number>;
  dropped: Record<string, number>;
  warnings: string[];
}

const OUTSIDE_CPZ = 'Outside the Controlled Parking Zone';

function isArea(g: any): g is AreaGeom {
  return g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

function compactBayGeometry(g: AreaGeom): PolygonGeom | MultiPolygonGeom {
  const ring = (r: LngLat[]) => (simplifyRing(r, 0.3) ?? r).map((c) => roundCoord(c, 6));
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map(ring) };
  return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(ring)) };
}

export function build(raw: RawLayers): BuildOutput {
  const warnings: string[] = [];
  const dropped: Record<string, number> = {
    tariffUnparseable: 0,
    bayNoGeometry: 0,
    bayNoTariff: 0,
    bayNoStreet: 0,
  };

  // 1. Tariffs.
  const tariffs: Record<string, Tariff> = {};
  const areas: TariffArea[] = [];
  for (const f of raw.tariffs.features) {
    const t = tariffFromProps(f.properties ?? {});
    if ('error' in t) {
      dropped.tariffUnparseable++;
      warnings.push(`Tariff OBJECTID ${f.properties?.OBJECTID}: ${t.error}`);
      continue;
    }
    if (!isArea(f.geometry)) continue;
    const prev = tariffs[t.code];
    if (prev && (prev.pencePerHour !== t.pencePerHour || prev.hours !== t.hours)) {
      warnings.push(`Tariff ${t.code} has conflicting definitions; keeping the first`);
    } else if (!prev) {
      tariffs[t.code] = t;
    }
    areas.push({ code: t.code, geometry: f.geometry });
  }
  const joiner = new TariffJoiner(areas);

  // 2. Bays, joined to tariffs and named.
  const namer = new StreetNamer(streetLinesFrom(raw.streets.features));
  const named: NamedBay[] = [];
  const geoms: (PolygonGeom | MultiPolygonGeom)[] = [];
  let joinedNearest = 0;
  const sources: [BayKind, FeatureCollection<any, any>][] = [
    ['pd', raw.payDisplay],
    ['shared', raw.shared],
  ];
  for (const [kind, fc] of sources) {
    for (const f of fc.features) {
      if (!isArea(f.geometry)) {
        dropped.bayNoGeometry++;
        continue;
      }
      const centroid = geometryCentroid(f.geometry);
      const tariff = joiner.codeAt(centroid);
      if (!tariff) {
        dropped.bayNoTariff++;
        continue;
      }
      if (tariff.via === 'nearest') joinedNearest++;
      const outer = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      const street = namer.nameFor(centroid, principalAxis(outer));
      if (!street) {
        dropped.bayNoStreet++;
        continue;
      }
      named.push({
        index: named.length,
        street: street.name,
        code: tariff.code,
        zone: String(f.properties?.Zone_No ?? '').trim(),
        kind,
        centroid,
        outline: outer,
      });
      geoms.push(compactBayGeometry(f.geometry));
    }
  }

  // Cheap strips with no bay polygons inside are parking in their own right.
  let areaBays = 0;
  for (const a of areas) {
    if (!tariffs[a.code]?.cheap) continue;
    if (named.some((b) => b.code === a.code && pointInGeometry(b.centroid, a.geometry))) continue;
    const centroid = geometryCentroid(a.geometry);
    const outer = a.geometry.type === 'Polygon' ? a.geometry.coordinates[0] : a.geometry.coordinates[0][0];
    const street = namer.nameFor(centroid, principalAxis(outer));
    if (!street) {
      dropped.bayNoStreet++;
      continue;
    }
    named.push({ index: named.length, street: street.name, code: a.code, zone: '', kind: 'area', centroid, outline: outer });
    geoms.push(compactBayGeometry(a.geometry));
    areaBays++;
  }

  // 3. Segments.
  const { segments, segOf } = buildSegments(named);
  const bays: BuildOutput['bays'] = {
    type: 'FeatureCollection',
    features: named.map(
      (b): Feature<PolygonGeom | MultiPolygonGeom, BayProps> => ({
        type: 'Feature',
        id: b.index,
        geometry: geoms[b.index],
        properties: { seg: segOf.get(b.index)!, t: b.code, k: b.kind, z: b.zone },
      }),
    ),
  };

  // 4. Tariff areas, merged per code and simplified, for the low-zoom overview.
  const byCode = new Map<string, AreaGeom[]>();
  for (const a of areas) byCode.set(a.code, [...(byCode.get(a.code) ?? []), a.geometry]);
  const tariffAreas: BuildOutput['tariffAreas'] = {
    type: 'FeatureCollection',
    features: [...byCode].map(([code, gs]) => ({
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: gs.flatMap((g) => simplifyArea(g, 5, 100).coordinates),
      },
      properties: { t: code },
    })),
  };

  // 5. Free zone and entry points.
  const outside = raw.cpzWithUncontrolled.features.find((f) => f.properties?.Zone_Type === OUTSIDE_CPZ);
  let freeZone: BuildOutput['freeZone'] = { type: 'FeatureCollection', features: [] };
  let freePoints: BuildOutput['freePoints'] = { type: 'FeatureCollection', features: [] };
  if (!outside || !isArea(outside.geometry)) {
    warnings.push('No "Outside the Controlled Parking Zone" polygon in layer 24');
  } else {
    freeZone = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: simplifyArea(outside.geometry, 8, 2000), properties: {} }],
    };
    const controlled = raw.cpz.features.map((f) => f.geometry).filter(isArea);
    freePoints = freeEntryPoints(streetLinesFrom(raw.streets.features), controlled, outside.geometry);
  }

  const counts = {
    tariffPolygons: raw.tariffs.features.length,
    tariffCodes: Object.keys(tariffs).length,
    rawPayDisplay: raw.payDisplay.features.length,
    rawShared: raw.shared.features.length,
    bays: bays.features.length,
    cheapBays: named.filter((b) => tariffs[b.code]?.cheap).length,
    baysJoinedByNearest: joinedNearest,
    cheapStripsWithoutBays: areaBays,
    segments: segments.length,
    cheapSegments: segments.filter((s) => tariffs[s.t]?.cheap).length,
    streets: raw.streets.features.length,
    freePoints: freePoints.features.length,
  };

  return { bays, tariffAreas, segments, freeZone, freePoints, tariffs, counts, dropped, warnings };
}
