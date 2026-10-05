// Data contract checks. A failure keeps the previous snapshot live.

import type { BuildOutput } from './build';

/** Allowed change in key counts versus the last good run. */
export const MAX_COUNT_DRIFT = 0.2;
const DRIFT_KEYS = ['bays', 'cheapBays', 'segments', 'tariffCodes', 'freePoints'];

export function validate(out: BuildOutput, previousCounts?: Record<string, number>): string[] {
  const errors: string[] = [];

  if (out.counts.bays === 0) errors.push('No bays survived the join');
  if (out.counts.cheapBays === 0) errors.push('No £1/hr bays found');
  if (out.dropped.tariffUnparseable > 0) errors.push(`${out.dropped.tariffUnparseable} tariff polygon(s) could not be parsed`);
  if (out.freeZone.features.length === 0) errors.push('Free zone polygon missing');

  for (const b of out.bays.features) {
    if (!out.tariffs[b.properties.t]) {
      errors.push(`Bay ${b.id} references unknown tariff ${b.properties.t}`);
      break;
    }
  }
  for (const [code, t] of Object.entries(out.tariffs)) {
    if (!t.schedule.length) errors.push(`Tariff ${code} has no parsed schedule`);
  }
  const segIds = new Set(out.segments.map((s) => s.id));
  if (segIds.size !== out.segments.length) errors.push('Duplicate segment ids');
  if (out.bays.features.some((b) => !segIds.has(b.properties.seg))) errors.push('Bay without a segment');

  if (previousCounts) {
    for (const k of DRIFT_KEYS) {
      const prev = previousCounts[k];
      const cur = out.counts[k];
      if (!prev || cur == null) continue;
      const drift = Math.abs(cur - prev) / prev;
      if (drift > MAX_COUNT_DRIFT) errors.push(`${k} changed by ${(drift * 100).toFixed(0)}% (${prev} -> ${cur})`);
    }
  }
  return errors;
}
