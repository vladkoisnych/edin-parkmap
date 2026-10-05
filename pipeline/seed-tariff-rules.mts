// One-off: seed pipeline/tariff-rules.json from the council's tariff layer.
//
//   npx tsx pipeline/seed-tariff-rules.mts [--cache]
//
// The result is a small, reviewable rules file: prices and hours per charge
// (these match the council's published price page), a default charge per
// zone, street exceptions, and the £1/hr long-stay locations. Once committed,
// the open build never touches the unlicensed tariff layer again; edit the
// JSON by hand as tariffs change.

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { build } from './build';
import { fetchCouncil, fromCouncil } from './sources';
import { RULES_FILE, type TariffRules } from './tariff-rules';

const { values } = parseArgs({ options: { cache: { type: 'boolean', default: false } } });
const out = build(fromCouncil(await fetchCouncil({ cacheDir: '.cache/raw', useCache: values.cache! })));
const cheap = (code: string) => out.tariffs[code].cheap;

function majority(codes: string[]): string {
  const n = new Map<string, number>();
  for (const c of codes) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// Zone defaults and street exceptions, from bays that aren't £1/hr.
const segById = new Map(out.segments.map((s) => [s.id, s]));
const byZone = new Map<string, string[]>();
const byZoneStreet = new Map<string, string[]>();
for (const b of out.bays.features) {
  const { t, z, seg } = b.properties;
  if (!z || cheap(t)) continue;
  byZone.set(z, [...(byZone.get(z) ?? []), t]);
  const key = `${z}|${segById.get(seg)!.street}`;
  byZoneStreet.set(key, [...(byZoneStreet.get(key) ?? []), t]);
}
const zones = Object.fromEntries([...byZone].sort().map(([z, codes]) => [z, majority(codes)]));
const streets = [...byZoneStreet]
  .map(([key, codes]) => {
    const [zone, street] = key.split('|');
    return { street, zone, code: majority(codes) };
  })
  .filter((r) => r.code !== zones[r.zone])
  .sort((a, b) => a.zone.localeCompare(b.zone) || a.street.localeCompare(b.street));

// £1/hr locations: one rule per cheap segment, listing its bay centres.
const cheapRules = out.segments
  .filter((s) => cheap(s.t))
  .map((s) => ({ street: s.street, code: s.t, pts: s.pts }))
  .sort((a, b) => a.street.localeCompare(b.street));

const rules: TariffRules = {
  provenance: [
    `Seeded ${new Date().toISOString().slice(0, 10)} by pipeline/seed-tariff-rules.mts from the council's Parking Tariff Area layer.`,
    'Prices and hours match the published page https://www.edinburgh.gov.uk/parking-spaces/parking-prices-times (£1/hr long-stay bays are not listed there).',
    'Maintain by hand: check signage or council notices when tariffs change.',
  ],
  tariffs: Object.fromEntries(
    Object.entries(out.tariffs).map(([code, t]) => [code, { Charge: `Charge ${code}`, Cost: t.cost, Hours: t.hours, Remarks: t.remarks }]),
  ),
  zones,
  streets,
  cheap: cheapRules,
};
await writeFile(RULES_FILE, JSON.stringify(rules, null, 2) + '\n');
console.log(`wrote ${RULES_FILE}: ${Object.keys(zones).length} zones, ${streets.length} street exceptions, ${cheapRules.length} £1/hr locations`);
