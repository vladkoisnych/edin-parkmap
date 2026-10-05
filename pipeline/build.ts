// Pure transform: normalised source data in (see sources.ts), app data files out.

import { geometryCentroid, pointInGeometry, principalAxis, roundCoord, simplifyRing, type LngLat } from '../src/lib/geo';
import { tariffFromProps, type Tariff } from '../src/lib/tariff';
import type {
  AreaGeom,
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
import type { BuildInputs, TariffInput } from './sources';
import { StreetNamer } from './streets';
import { RulesResolver } from './tariff-rules';

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

function compactBayGeometry(g: AreaGeom): PolygonGeom | MultiPolygonGeom {
  const ring = (r: LngLat[]) => (simplifyRing(r, 0.3) ?? r).map((c) => roundCoord(c, 6));
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map(ring) };
  return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map(ring)) };
}

const outerRing = (g: AreaGeom) => (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]);

interface Resolver {
  tariffs: Record<string, Tariff>;
  codeFor(bay: { centroid: LngLat; zone: string; street: string }): { code: string; via: string } | null;
  /** Tariff polygons, when the source has them (council mode only). */
  areas: TariffArea[];
}

function resolverFor(input: TariffInput, warnings: string[], dropped: Record<string, number>): Resolver {
  if (input.kind === 'rules') {
    const r = new RulesResolver(input.rules);
    for (const e of r.errors) warnings.push(e);
    dropped.tariffUnparseable += r.errors.length;
    return { tariffs: r.tariffs, codeFor: (b) => r.codeFor(b), areas: [] };
  }
  const tariffs: Record<string, Tariff> = {};
  const areas: TariffArea[] = [];
  for (const f of input.features) {
    const t = tariffFromProps(f.properties ?? {});
    if ('error' in t) {
      dropped.tariffUnparseable++;
      warnings.push(`Tariff OBJECTID ${f.properties?.OBJECTID}: ${t.error}`);
      continue;
    }
    if (!f.geometry) continue;
    const prev = tariffs[t.code];
    if (prev && (prev.pencePerHour !== t.pencePerHour || prev.hours !== t.hours)) {
      warnings.push(`Tariff ${t.code} has conflicting definitions; keeping the first`);
    } else if (!prev) {
      tariffs[t.code] = t;
    }
    areas.push({ code: t.code, geometry: f.geometry });
  }
  const joiner = new TariffJoiner(areas);
  return { tariffs, codeFor: (b) => joiner.codeAt(b.centroid), areas };
}

export function build(input: BuildInputs): BuildOutput {
  const warnings: string[] = [];
  const dropped: Record<string, number> = {
    tariffUnparseable: 0,
    bayNoGeometry: 0,
    bayNoTariff: 0,
    bayNoStreet: 0,
  };

  // 1. Tariffs.
  const resolver = resolverFor(input.tariffs, warnings, dropped);
  const { tariffs } = resolver;

  // 2. Bays, named and then priced (rules can depend on the street).
  const namer = new StreetNamer(input.streets);
  const candidates: { bay: (typeof input.bays)[number]; centroid: LngLat; outer: LngLat[]; axis: ReturnType<typeof principalAxis>; name: string }[] = [];
  for (const bay of input.bays) {
    if (!bay.geometry || (bay.geometry.type !== 'Polygon' && bay.geometry.type !== 'MultiPolygon')) {
      dropped.bayNoGeometry++;
      continue;
    }
    const centroid = geometryCentroid(bay.geometry);
    const outer = outerRing(bay.geometry);
    const axis = principalAxis(outer);
    const street = namer.nameFor(centroid, axis);
    if (!street) {
      dropped.bayNoStreet++;
      continue;
    }
    candidates.push({ bay, centroid, outer, axis, name: street.name });
  }

  const named: NamedBay[] = [];
  const geoms: (PolygonGeom | MultiPolygonGeom)[] = [];
  const via: Record<string, number> = {};
  for (const { bay, centroid, outer, name } of candidates) {
    const tariff = resolver.codeFor({ centroid, zone: bay.zone, street: name });
    if (!tariff || !tariffs[tariff.code]) {
      dropped.bayNoTariff++;
      continue;
    }
    via[tariff.via] = (via[tariff.via] ?? 0) + 1;
    named.push({ index: named.length, street: name, code: tariff.code, zone: bay.zone, kind: bay.kind, centroid, outline: outer });
    geoms.push(compactBayGeometry(bay.geometry));
  }

  // Cheap strips with no bay polygons inside are parking in their own right.
  let areaBays = 0;
  for (const a of resolver.areas) {
    if (!tariffs[a.code]?.cheap) continue;
    if (named.some((b) => b.code === a.code && pointInGeometry(b.centroid, a.geometry))) continue;
    const centroid = geometryCentroid(a.geometry);
    const outer = outerRing(a.geometry);
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

  // 4. Tariff areas, merged per code and simplified (council mode only).
  const byCode = new Map<string, AreaGeom[]>();
  for (const a of resolver.areas) byCode.set(a.code, [...(byCode.get(a.code) ?? []), a.geometry]);
  const tariffAreas: BuildOutput['tariffAreas'] = {
    type: 'FeatureCollection',
    features: [...byCode].map(([code, gs]) => ({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: gs.flatMap((g) => simplifyArea(g, 5, 100).coordinates) },
      properties: { t: code },
    })),
  };

  // 5. Free zone and entry points.
  let freeZone: BuildOutput['freeZone'] = { type: 'FeatureCollection', features: [] };
  let freePoints: BuildOutput['freePoints'] = { type: 'FeatureCollection', features: [] };
  if (!input.freeZone) {
    warnings.push('No free-zone polygon available');
  } else {
    freeZone = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: simplifyArea(input.freeZone, 8, 2000), properties: {} }],
    };
    freePoints = freeEntryPoints(input.streets, input.controlled, input.freeZone);
  }

  const counts: Record<string, number> = {
    ...Object.fromEntries(Object.entries(input.rawCounts).map(([k, v]) => [`raw_${k}`, v])),
    tariffCodes: Object.keys(tariffs).length,
    bays: bays.features.length,
    cheapBays: named.filter((b) => tariffs[b.code]?.cheap).length,
    ...Object.fromEntries(Object.entries(via).map(([k, v]) => [`tariffVia_${k}`, v])),
    cheapStripsWithoutBays: areaBays,
    segments: segments.length,
    cheapSegments: segments.filter((s) => tariffs[s.t]?.cheap).length,
    freePoints: freePoints.features.length,
  };

  return { bays, tariffAreas, segments, freeZone, freePoints, tariffs, counts, dropped, warnings };
}
