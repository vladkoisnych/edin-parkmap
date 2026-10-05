// OS Open Roads (OS OpenData, Open Government Licence v3.0): named road
// centrelines for street naming and free entry points in the open build.
//
// OS only publishes it for the whole of GB (~600 MB zip). We download it once
// per release into .cache/raw/osroads, pull out the NT tile (Edinburgh) and keep
// the links inside our area of interest.

import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';
import type { BBox, LngLat } from '../src/lib/geo';
import { bngToWgs84 } from './datum';
import type { StreetLine } from './streets';

export const OS_OPEN_ROADS_URL =
  'https://api.os.uk/downloads/v1/products/OpenRoads/downloads?area=GB&format=ESRI%C2%AE+Shapefile&redirect';
/** 100 km grid square covering Edinburgh. */
const TILE = 'NT';

/** Resolve the download redirect; its path names the release (e.g. 2026-04). */
async function resolveRelease(): Promise<{ url: string; release: string }> {
  const res = await fetch(OS_OPEN_ROADS_URL, { redirect: 'manual' });
  const url = res.headers.get('location');
  if (!url) throw new Error(`OS Open Roads: expected a redirect, got HTTP ${res.status}`);
  const release = url.match(/OpenRoads\/(\d{4}-\d{2})\//)?.[1] ?? 'unknown';
  return { url, release };
}

async function download(url: string, file: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`OS Open Roads download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(file));
}

/** Read named entries from a (non-zip64) zip without extracting the rest. */
async function readZipEntries(file: string, wanted: string[]): Promise<Map<string, Buffer>> {
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Not a zip file');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const out = new Map<string, Buffer>();
    for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!wanted.includes(name)) continue;
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, dataStart);
      out.set(name, method === 8 ? inflateRawSync(data) : data);
    }
    for (const w of wanted) if (!out.has(w)) throw new Error(`${w} not found in ${file}`);
    return out;
  } finally {
    await fh.close();
  }
}

/** dBase III records as string maps. */
export function parseDbf(buf: Buffer): Record<string, string>[] {
  const count = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let off = 32; buf[off] !== 0x0d; off += 32) {
    fields.push({ name: buf.toString('latin1', off, off + 11).replace(/\0.*$/, ''), len: buf[off + 16] });
  }
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    let p = headerLen + i * recordLen + 1; // skip deletion flag
    const row: Record<string, string> = {};
    for (const f of fields) {
      row[f.name] = buf.toString('utf8', p, p + f.len).trim();
      p += f.len;
    }
    rows.push(row);
  }
  return rows;
}

/** Polyline parts (shape types 3/13/23) in source coordinates, record-aligned. */
export function parseShpPolylines(buf: Buffer): [number, number][][][] {
  const out: [number, number][][][] = [];
  for (let off = 100; off + 8 <= buf.length; ) {
    const contentLen = buf.readInt32BE(off + 4) * 2;
    const rec = off + 8;
    const type = buf.readInt32LE(rec);
    const parts: [number, number][][] = [];
    if (type === 3 || type === 13 || type === 23) {
      const numParts = buf.readInt32LE(rec + 36);
      const numPoints = buf.readInt32LE(rec + 40);
      const partStarts = Array.from({ length: numParts }, (_, i) => buf.readInt32LE(rec + 44 + i * 4));
      const pts = rec + 44 + numParts * 4;
      for (let i = 0; i < numParts; i++) {
        const end = i + 1 < numParts ? partStarts[i + 1] : numPoints;
        const part: [number, number][] = [];
        for (let j = partStarts[i]; j < end; j++) part.push([buf.readDoubleLE(pts + j * 16), buf.readDoubleLE(pts + j * 16 + 8)]);
        parts.push(part);
      }
    }
    out.push(parts);
    off = rec + contentLen;
  }
  return out;
}

export interface OsRoadsResult {
  release: string;
  lines: StreetLine[];
}

/**
 * Named OS Open Roads links within `bbox` (lng/lat), as StreetLines.
 * Coordinates are converted from British National Grid with the same
 * OSGB36->WGS84 shift the council server applies (transformation 1314), so
 * roads and bays line up.
 */
export async function loadOsRoads(bbox: BBox, cacheDir: string): Promise<OsRoadsResult> {
  const dir = join(cacheDir, 'osroads');
  await mkdir(dir, { recursive: true });
  const { url, release } = await resolveRelease();
  const zip = join(dir, `oproad-${release}.zip`);
  const have = await stat(zip).then((s) => s.size > 0).catch(() => false);
  if (!have) {
    console.log(`downloading OS Open Roads ${release} (~600 MB, cached afterwards)`);
    await download(url, `${zip}.part`);
    await rename(`${zip}.part`, zip);
    // Drop superseded releases so the cache doesn't grow.
    for (const f of await readdir(dir)) if (f.startsWith('oproad-') && join(dir, f) !== zip) await rm(join(dir, f));
  }
  const files = await readZipEntries(zip, [`data/${TILE}_RoadLink.shp`, `data/${TILE}_RoadLink.dbf`]);
  const shapes = parseShpPolylines(files.get(`data/${TILE}_RoadLink.shp`)!);
  const rows = parseDbf(files.get(`data/${TILE}_RoadLink.dbf`)!);
  if (shapes.length !== rows.length) throw new Error(`OS Open Roads: ${shapes.length} shapes but ${rows.length} records`);

  const lines: StreetLine[] = [];
  rows.forEach((row, i) => {
    const name = row.name1 || row.name2;
    if (!name || row.fictitious === 'true') return;
    for (const part of shapes[i]) {
      const coords: LngLat[] = part.map(([e, n]) => bngToWgs84(e, n));
      if (!coords.some(([x, y]) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3])) continue;
      lines.push({
        name,
        featureType: row.function,
        classification: row.trunkRoad === 'true' ? 'Trunk' : row.class,
        adoption: '',
        coords,
      });
    }
  });
  return { release, lines };
}
