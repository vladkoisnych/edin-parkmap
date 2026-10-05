// Spatial join: bay centroid -> tariff polygon.

import { bboxOf, distanceToEdges, GridIndex, pointInGeometry, ringArea, ringsOf, type LngLat } from '../src/lib/geo';
import type { AreaGeom } from '../src/lib/types';

export const TARIFF_FALLBACK_M = 20;

export interface TariffArea {
  code: string;
  geometry: AreaGeom;
}

function areaM2(g: AreaGeom): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.reduce((s, p) => s + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
}

export class TariffJoiner {
  private index = new GridIndex<TariffArea & { area: number }>(250);

  constructor(areas: TariffArea[]) {
    for (const a of areas) this.index.insert({ ...a, area: areaM2(a.geometry) }, bboxOf(ringsOf(a.geometry).flat()));
  }

  /**
   * Tariff code for a point: the smallest polygon containing it (cheap
   * long-stay strips are drawn on top of the wider zone tariff), else the nearest
   * polygon edge within TARIFF_FALLBACK_M (bays often sit on a boundary
   * drawn down the road centreline), else null.
   */
  codeAt(p: LngLat): { code: string; via: 'inside' | 'nearest' } | null {
    const candidates = this.index.near(p, TARIFF_FALLBACK_M).sort((a, b) => a.area - b.area);
    for (const a of candidates) if (pointInGeometry(p, a.geometry)) return { code: a.code, via: 'inside' };
    let best: { code: string; d: number } | null = null;
    for (const a of candidates) {
      const d = distanceToEdges(p, a.geometry);
      if (d <= TARIFF_FALLBACK_M && (!best || d < best.d)) best = { code: a.code, d };
    }
    return best ? { code: best.code, via: 'nearest' } : null;
  }
}
