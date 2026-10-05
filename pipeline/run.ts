// Fetch council layers, build, validate, write data files.
//
//   npm run data                       open-licensed sources (default), write public/data
//   npm run data -- --source council   the council's parking web map layers (no reuse licence)
//   npm run data -- --cache            reuse .cache/raw if present
//   npm run data -- --previous <url|path to meta.json>   drift check against last good run
//   npm run data -- --no-drift         skip the drift check (first run, known big change)
//
// Exits 2 on validation failure without touching the output directory.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Meta } from '../src/lib/types';
import { checkDatum, layerUrl } from './arcgis';
import { build } from './build';
import { ATTRIBUTION, COUNCIL_LAYERS, DATUM_CHECK_LAYER, fetchCouncil, fetchOpen, fromCouncil, fromOpen, OPEN_LAYERS, type SourceMode } from './sources';
import { loadRules, RULES_FILE } from './tariff-rules';
import { validate } from './validate';

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: 'open' },
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
  const mode = args.source as SourceMode;
  if (mode !== 'open' && mode !== 'council') throw new Error(`--source must be "open" or "council", not "${args.source}"`);
  const cache = { cacheDir: '.cache/raw', useCache: args.cache! };
  const started = Date.now();
  console.log(`source: ${mode}`);
  if (!args.cache) console.log(`datum check: server WGS84 within ${(await checkDatum(DATUM_CHECK_LAYER[mode])).toFixed(1)} m of local conversion`);

  const raw = mode === 'open' ? await fetchOpen(cache) : undefined;
  const input = raw ? fromOpen(raw, await loadRules()) : fromCouncil(await fetchCouncil(cache));
  for (const [k, v] of Object.entries(input.rawCounts)) console.log(`${k}: ${v} features`);

  const out = build(input);
  for (const w of out.warnings) console.warn(`warning: ${w}`);

  const previous = args['no-drift'] ? undefined : await loadPrevious(args.previous);
  // Counts aren't comparable across a source switch.
  const comparable = previous && (previous.sourceMode ?? 'council') === mode ? previous.counts : undefined;
  const errors = validate(out, comparable);
  console.log('counts', out.counts);
  console.log('dropped', out.dropped);
  if (errors.length) {
    console.error('Validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(2);
  }

  const layers = mode === 'open' ? OPEN_LAYERS : COUNCIL_LAYERS;
  const meta: Meta = {
    fetchedAt: new Date().toISOString(),
    sourceMode: mode,
    attribution: ATTRIBUTION[mode],
    sources: {
      ...Object.fromEntries(Object.entries(layers).map(([k, ref]) => [k, layerUrl(ref)])),
      ...(raw ? { roads: `OS Open Roads ${raw.roadsRelease}`, tariffRules: RULES_FILE } : {}),
    },
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
