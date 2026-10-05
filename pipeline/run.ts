// Fetch council layers, build, validate, write data files.
//
//   npm run data                       fetch live, write public/data
//   npm run data -- --cache            reuse .cache/raw if present
//   npm run data -- --previous <url|path to meta.json>   drift check against last good run
//   npm run data -- --no-drift         skip the drift check (first run, known big change)
//
// Exits 2 on validation failure without touching the output directory.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Meta } from '../src/lib/types';
import { checkDatum, fetchLayerCached, LAYERS, layerUrl } from './arcgis';
import { build, type RawLayers } from './build';
import { validate } from './validate';

const { values: args } = parseArgs({
  options: {
    cache: { type: 'boolean', default: false },
    out: { type: 'string', default: 'public/data' },
    previous: { type: 'string' },
    'no-drift': { type: 'boolean', default: false },
  },
});

async function loadPrevious(src: string | undefined): Promise<Meta | undefined> {
  if (!src) return undefined;
  try {
    const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await readFile(src, 'utf8');
    return JSON.parse(text) as Meta;
  } catch (e) {
    console.warn(`No previous meta at ${src} (${(e as Error).message}); skipping drift check`);
    return undefined;
  }
}

async function main() {
  const cacheDir = '.cache/raw';
  const started = Date.now();
  if (!args.cache) console.log(`datum check: server WGS84 within ${(await checkDatum()).toFixed(1)} m of local conversion`);
  const raw = {} as RawLayers;
  for (const [key, id] of Object.entries(LAYERS) as [keyof RawLayers, number][]) {
    const fields = key === 'streets' ? 'OBJECTID,primary_ns,feature_ty,classifica,adoption_s' : '*';
    raw[key] = await fetchLayerCached(id, cacheDir, args.cache!, fields);
    console.log(`layer ${id} (${key}): ${raw[key].features.length} features`);
  }

  const out = build(raw);
  for (const w of out.warnings) console.warn(`warning: ${w}`);

  const previous = args['no-drift'] ? undefined : await loadPrevious(args.previous);
  const errors = validate(out, previous?.counts);
  console.log('counts', out.counts);
  console.log('dropped', out.dropped);
  if (errors.length) {
    console.error('Validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(2);
  }

  const meta: Meta = {
    fetchedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(LAYERS).map(([k, id]) => [k, layerUrl(id)])),
    counts: out.counts,
    dropped: out.dropped,
    tariffs: out.tariffs,
  };

  await mkdir(args.out!, { recursive: true });
  const files: Record<string, unknown> = {
    'bays.geojson': out.bays,
    'tariffs.geojson': out.tariffAreas,
    'segments.json': out.segments,
    'free-zone.geojson': out.freeZone,
    'free-points.geojson': out.freePoints,
    'meta.json': meta,
  };
  for (const [name, data] of Object.entries(files)) {
    const text = JSON.stringify(data);
    await writeFile(join(args.out!, name), text);
    console.log(`wrote ${name} (${(text.length / 1024).toFixed(0)} KB)`);
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
