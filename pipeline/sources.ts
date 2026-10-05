// Where the data comes from. Two modes, normalised to the same BuildInputs:
//
//   open (default)  Open Government Licence data only: the council's Parking
//                   Bays, Controlled Parking Zones and Ward Boundaries
//                   (INSPIRE service, published on its open data hub) and
//                   OS Open Roads for street names. Tariffs come from
//                   pipeline/tariff-rules.json.
//   council         The council's parking web map layers (Transport service),
//                   including the Parking Tariff Area, Street Types and
//                   outside-CPZ layers, which have no published reuse licence.

import { bboxOf, ringsOf, type BBox, type LngLat } from '../src/lib/geo';
import type { AreaGeom, BayKind, FeatureCollection } from '../src/lib/types';
import { fetchCached, INSPIRE, TRANSPORT, type LayerRef } from './arcgis';
import { freeZoneFromBoundary } from './freezone';
import { loadOsRoads } from './osroads';
import { streetLinesFrom, type StreetLine } from './streets';
import type { TariffRules } from './tariff-rules';

export type SourceMode = 'open' | 'council';

const BAY_TYPES: Record<string, BayKind> = {
  'Public Parking charged as per tariff on parking meter': 'pd',
  'Residents Permit or Public Parking as per tariff on parking meter': 'shared',
};
const bayTypeWhere = `Bay_Type IN (${Object.keys(BAY_TYPES)
  .map((t) => `'${t}'`)
  .join(',')})`;

export const OPEN_LAYERS = {
  bays: { service: INSPIRE, id: 11, where: bayTypeWhere },
  cpz: { service: INSPIRE, id: 12 },
  wards: { service: INSPIRE, id: 24, outFields: 'OBJECTID,Ward_Name' },
} satisfies Record<string, LayerRef>;

export const COUNCIL_LAYERS = {
  cpz: { service: TRANSPORT, id: 4 },
  payDisplay: { service: TRANSPORT, id: 13 },
  shared: { service: TRANSPORT, id: 15 },
  tariffs: { service: TRANSPORT, id: 16 },
  streets: { service: TRANSPORT, id: 18, outFields: 'OBJECTID,primary_ns,feature_ty,classifica,adoption_s' },
  cpzWithUncontrolled: { service: TRANSPORT, id: 24 },
} satisfies Record<string, LayerRef>;

/** Attribution shown with the data, per mode (meta.json -> legend). */
export const ATTRIBUTION: Record<SourceMode, string> = {
  open:
    'Copyright City of Edinburgh Council, contains Ordnance Survey data © Crown copyright and database right. ' +
    'Bays, zones and ward boundaries under the Open Government Licence v3.0. ' +
    'Street names from OS Open Roads, contains OS data © Crown copyright and database right.',
  council:
    'Copyright City of Edinburgh Council, contains Ordnance Survey data © Crown copyright and database right. ' +
    'Includes council parking map layers with no published reuse licence.',
};

/** Layer used for the datum sanity check in each mode. */
export const DATUM_CHECK_LAYER: Record<SourceMode, LayerRef> = { open: OPEN_LAYERS.cpz, council: COUNCIL_LAYERS.cpz };

export interface BayInput {
  kind: BayKind;
  zone: string;
  geometry: AreaGeom;
}

/** Council mode: tariff polygons (layer 16 features). Open mode: the rules file. */
export type TariffInput = { kind: 'areas'; features: any[] } | { kind: 'rules'; rules: TariffRules };

export interface BuildInputs {
  mode: SourceMode;
  bays: BayInput[];
  /** Named road lines (centrelines or kerb outlines) for naming and entry points. */
  streets: StreetLine[];
  /** CPZ and priority-area polygons. */
  controlled: AreaGeom[];
  /** Everywhere outside the controlled zones, or null if unavailable. */
  freeZone: AreaGeom | null;
  tariffs: TariffInput;
  rawCounts: Record<string, number>;
}

export type OpenRaw = Record<keyof typeof OPEN_LAYERS, FeatureCollection<any, any>> & { roads: StreetLine[]; roadsRelease: string };
export type CouncilRaw = Record<keyof typeof COUNCIL_LAYERS, FeatureCollection<any, any>>;

function isArea(g: any): g is AreaGeom {
  return g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

const areas = (fc: FeatureCollection<any, any>) => fc.features.map((f) => f.geometry).filter(isArea);

function bayInputs(fc: FeatureCollection<any, any>, kindOf: (f: any) => BayKind | undefined): BayInput[] {
  const out: BayInput[] = [];
  for (const f of fc.features) {
    const kind = kindOf(f);
    if (!kind) continue;
    out.push({ kind, zone: String(f.properties?.Zone_No ?? '').trim(), geometry: f.geometry });
  }
  return out;
}

export function fromOpen(raw: OpenRaw, rules: TariffRules): BuildInputs {
  const controlled = areas(raw.cpz);
  const wards = areas(raw.wards);
  return {
    mode: 'open',
    bays: bayInputs(raw.bays, (f) => BAY_TYPES[f.properties?.Bay_Type]),
    streets: raw.roads,
    controlled,
    freeZone: wards.length ? freeZoneFromBoundary(wards, controlled) : null,
    tariffs: { kind: 'rules', rules },
    rawCounts: { bays: raw.bays.features.length, cpz: raw.cpz.features.length, wards: raw.wards.features.length, roads: raw.roads.length },
  };
}

const OUTSIDE_CPZ = 'Outside the Controlled Parking Zone';

export function fromCouncil(raw: CouncilRaw): BuildInputs {
  const outside = raw.cpzWithUncontrolled.features.find((f) => f.properties?.Zone_Type === OUTSIDE_CPZ);
  return {
    mode: 'council',
    bays: [...bayInputs(raw.payDisplay, () => 'pd'), ...bayInputs(raw.shared, () => 'shared')],
    streets: streetLinesFrom(raw.streets.features),
    controlled: areas(raw.cpz),
    freeZone: outside && isArea(outside.geometry) ? outside.geometry : null,
    tariffs: { kind: 'areas', features: raw.tariffs.features },
    rawCounts: Object.fromEntries(Object.entries(raw).map(([k, fc]) => [k, fc.features.length])),
  };
}

function padBBox(b: BBox, m: number): BBox {
  const dLat = m / 111_320;
  const dLng = m / 62_300;
  return [b[0] - dLng, b[1] - dLat, b[2] + dLng, b[3] + dLat];
}

export async function fetchOpen(cache: { cacheDir: string; useCache: boolean }): Promise<OpenRaw> {
  const opts = () => cache;
  const bays = await fetchCached('open-bays', OPEN_LAYERS.bays, opts());
  const cpz = await fetchCached('open-cpz', OPEN_LAYERS.cpz, opts());
  const wards = await fetchCached('open-wards', OPEN_LAYERS.wards, opts());
  // Roads only where they matter: around the bays and the controlled zones.
  const extent: LngLat[] = [...bays.features, ...cpz.features].flatMap((f) => ringsOf(f.geometry).flat());
  const roads = await loadOsRoads(padBBox(bboxOf(extent), 1000), cache.cacheDir);
  return { bays, cpz, wards, roads: roads.lines, roadsRelease: roads.release };
}

export async function fetchCouncil(cache: { cacheDir: string; useCache: boolean }): Promise<CouncilRaw> {
  const raw = {} as CouncilRaw;
  for (const [key, ref] of Object.entries(COUNCIL_LAYERS) as [keyof CouncilRaw, LayerRef][]) {
    raw[key] = await fetchCached(`council-${key}`, ref, cache);
  }
  return raw;
}
