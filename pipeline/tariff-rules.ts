// Tariffs without the unlicensed council tariff layer: a rules file kept in
// the repo (pipeline/tariff-rules.json) maps each bay to a charge by its
// zone, its street, or a known £1/hr location.

import { readFile } from 'node:fs/promises';
import { distanceM, type LngLat } from '../src/lib/geo';
import { tariffFromProps, type RawTariffProps, type Tariff } from '../src/lib/tariff';

export const RULES_FILE = 'pipeline/tariff-rules.json';
/** A bay is at a £1/hr location when its centre is this close to a listed point. */
export const CHEAP_MATCH_M = 3;

export interface TariffRules {
  /** Where the rules came from and when they were last checked. */
  provenance: string[];
  /** Charge code -> attributes in the council's own format. */
  tariffs: Record<string, RawTariffProps>;
  /** Default charge per controlled zone (bay Zone_No). */
  zones: Record<string, string>;
  /** Streets charged differently from their zone's default. */
  streets: { street: string; zone: string; code: string }[];
  /**
   * £1/hr long-stay locations: bays within CHEAP_MATCH_M of one of `pts`
   * (bay centres). `street` is a label for people editing the file.
   */
  cheap: { street: string; code: string; pts: LngLat[] }[];
}

export async function loadRules(file = RULES_FILE): Promise<TariffRules> {
  return JSON.parse(await readFile(file, 'utf8')) as TariffRules;
}

/** Compare names loosely: "St Giles' Street" = "St Giles Street", "Heriothill" = "Heriot Hill". */
export const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class RulesResolver {
  readonly tariffs: Record<string, Tariff> = {};
  readonly errors: string[] = [];
  private streets = new Map<string, string>();

  constructor(private rules: TariffRules) {
    for (const [code, props] of Object.entries(rules.tariffs)) {
      const t = tariffFromProps(props);
      if ('error' in t) this.errors.push(`Tariff ${code}: ${t.error}`);
      else this.tariffs[code] = { ...t, code };
    }
    const known = (code: string, where: string) => {
      if (!rules.tariffs[code]) this.errors.push(`${where} uses unknown tariff ${code}`);
    };
    for (const [zone, code] of Object.entries(rules.zones)) known(code, `Zone ${zone}`);
    for (const r of rules.streets) {
      known(r.code, `Street ${r.street}`);
      this.streets.set(`${norm(r.zone)}|${norm(r.street)}`, r.code);
    }
    for (const r of rules.cheap) known(r.code, `£1/hr rule ${r.street}`);
  }

  /** Most specific rule wins: £1/hr location, then street within zone, then zone. */
  codeFor(bay: { centroid: LngLat; zone: string; street: string }): { code: string; via: 'cheap' | 'street' | 'zone' } | null {
    for (const r of this.rules.cheap) {
      if (r.pts.some((p) => distanceM(bay.centroid, p) <= CHEAP_MATCH_M)) return { code: r.code, via: 'cheap' };
    }
    const street = norm(bay.street);
    const byStreet = this.streets.get(`${norm(bay.zone)}|${street}`);
    if (byStreet) return { code: byStreet, via: 'street' };
    const byZone = this.rules.zones[bay.zone.trim()];
    return byZone ? { code: byZone, via: 'zone' } : null;
  }
}
