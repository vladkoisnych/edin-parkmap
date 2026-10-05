// Paged GeoJSON fetch from the council's ArcGIS MapServers.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distanceM, type BBox } from '../src/lib/geo';
import type { FeatureCollection } from '../src/lib/types';
import { bngToWgs84 } from './datum';

const SERVER = 'https://edinburghcouncilmaps.info/arcgis/rest/services';
export const TRANSPORT = `${SERVER}/Transport/Transport/MapServer`;
/** The council's INSPIRE service: the layers its open data hub publishes under OGL v3.0. */
export const INSPIRE = `${SERVER}/Misc/INSPIRE/MapServer`;

export interface LayerRef {
  service: string;
  id: number;
  where?: string;
  outFields?: string;
}

export function layerUrl(ref: LayerRef): string {
  return `${ref.service}/${ref.id}`;
}

/**
 * The layers are stored in British National Grid (OSGB36). Reprojecting to
 * WGS84 without a datum transformation leaves everything ~90 m east of where
 * it belongs on the web map. 1314 is OSGB_1936_To_WGS_1984_Petroleum (~2 m).
 */
export const DATUM_TRANSFORMATION = '1314';
/** How far the server's WGS84 may differ from our own Helmert conversion. */
const DATUM_TOLERANCE_M = 15;

const USER_AGENT = 'edin-parkmap data pipeline (+https://github.com/)';

async function getJson(url: string, attempt = 1): Promise<any> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const body = await res.json();
    if (body.error) throw new Error(`ArcGIS error ${JSON.stringify(body.error)} for ${url}`);
    return body;
  } catch (e) {
    if (attempt >= 4) throw e;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return getJson(url, attempt + 1);
  }
}

/**
 * Fetch every matching feature of a layer as GeoJSON (WGS84), paging with
 * resultOffset until the server stops reporting exceededTransferLimit.
 * `bbox` (lng/lat) limits the query to features intersecting it.
 */
export async function fetchLayer(ref: LayerRef, bbox?: BBox): Promise<FeatureCollection<any, any>> {
  const features: any[] = [];
  const seen = new Set<unknown>();
  for (let offset = 0; ; ) {
    const params = new URLSearchParams({
      where: ref.where ?? '1=1',
      outFields: ref.outFields ?? '*',
      outSR: '4326',
      datumTransformation: DATUM_TRANSFORMATION,
      f: 'geojson',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
    });
    if (bbox) {
      params.set('geometry', bbox.join(','));
      params.set('geometryType', 'esriGeometryEnvelope');
      params.set('inSR', '4326');
      params.set('spatialRel', 'esriSpatialRelIntersects');
    }
    const page = await getJson(`${layerUrl(ref)}/query?${params}`);
    const batch: any[] = page.features ?? [];
    for (const f of batch) {
      // Guard against servers that ignore resultOffset and repeat a page.
      const key = f.id ?? f.properties?.OBJECTID;
      if (key != null && seen.has(key)) continue;
      seen.add(key);
      features.push(f);
    }
    const more = page.exceededTransferLimit || page.properties?.exceededTransferLimit;
    if (!more || batch.length === 0) break;
    offset += batch.length;
  }
  return { type: 'FeatureCollection', features };
}

/** Fetch with an on-disk cache under .cache/raw, so reruns don't hit the council server. */
export async function fetchCached(name: string, ref: LayerRef, opts: { cacheDir: string; useCache: boolean; bbox?: BBox }) {
  const file = join(opts.cacheDir, `${name}.geojson`);
  if (opts.useCache) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as FeatureCollection<any, any>;
    } catch {
      /* fall through to network */
    }
  }
  const fc = await fetchLayer(ref, opts.bbox);
  await mkdir(opts.cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(fc));
  return fc;
}

function firstVertex(geom: any): [number, number] {
  if (geom.rings) return geom.rings[0][0];
  if (geom.paths) return geom.paths[0][0];
  throw new Error('Unexpected geometry in datum check');
}

/**
 * Guard against a silently ignored datum transformation: fetch one vertex in
 * native BNG and in WGS84, and compare the server's WGS84 with an independent
 * conversion. Throws if they disagree.
 */
export async function checkDatum(ref: LayerRef): Promise<number> {
  const base = { where: '1=1', outFields: 'OBJECTID', orderByFields: 'OBJECTID', resultRecordCount: '1', f: 'json' };
  const q = (extra: Record<string, string>) => getJson(`${layerUrl(ref)}/query?${new URLSearchParams({ ...base, ...extra })}`);
  const native = await q({});
  const wgs = await q({ outSR: '4326', datumTransformation: DATUM_TRANSFORMATION });
  if (native.spatialReference?.wkid !== 27700) {
    throw new Error(`Expected source data in EPSG:27700, got ${JSON.stringify(native.spatialReference)}`);
  }
  const [E, N] = firstVertex(native.features[0].geometry);
  const server = firstVertex(wgs.features[0].geometry);
  const offset = distanceM(server, bngToWgs84(E, N));
  if (offset > DATUM_TOLERANCE_M) {
    throw new Error(`Server reprojection is ${offset.toFixed(0)} m off; datum transformation not applied?`);
  }
  return offset;
}
