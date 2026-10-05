// Group adjacent bays on the same street and tariff into street segments.

import { distanceM, nearestOnLine, principalAxis, roundCoord, type LngLat } from '../src/lib/geo';
import type { BayKind, Segment } from '../src/lib/types';

/** Bays whose outlines come within this distance, on the same street and tariff, chain together. */
export const SEGMENT_LINK_M = 25;

export interface NamedBay {
  index: number;
  street: string;
  code: string;
  zone: string;
  kind: BayKind;
  centroid: LngLat;
  /** Outer ring; long £1/hr strips have centroids far apart even when touching. */
  outline?: LngLat[];
}

/** Gap between two bays: outline to outline where known, else centroid to centroid. */
export function bayGap(a: NamedBay, b: NamedBay): number {
  if (!a.outline || !b.outline) return distanceM(a.centroid, b.centroid);
  let best = Infinity;
  for (const p of a.outline) best = Math.min(best, nearestOnLine(p, b.outline).dist);
  for (const p of b.outline) best = Math.min(best, nearestOnLine(p, a.outline).dist);
  return best;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Returns segments and a map from bay index to segment id. */
export function buildSegments(bays: NamedBay[]): { segments: Segment[]; segOf: Map<number, string> } {
  const groups = new Map<string, NamedBay[]>();
  for (const b of bays) {
    const key = `${b.street}\u0000${b.code}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(b);
  }

  const segments: Segment[] = [];
  const segOf = new Map<number, string>();
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const group = groups.get(key)!;
    // Union-find over the group (groups are small, O(n²) is fine).
    const parent = group.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        if (bayGap(group[i], group[j]) <= SEGMENT_LINK_M) parent[find(i)] = find(j);

    const clusters = new Map<number, NamedBay[]>();
    group.forEach((b, i) => {
      const r = find(i);
      let c = clusters.get(r);
      if (!c) clusters.set(r, (c = []));
      c.push(b);
    });

    // Order clusters west to east so ids are stable between runs.
    const ordered = [...clusters.values()].sort((a, b) => a[0].centroid[0] - b[0].centroid[0]);
    ordered.forEach((members, n) => {
      const { street, code } = members[0];
      const id = `${slug(street)}-${code.toLowerCase()}-${n + 1}`;
      const mean: LngLat = [
        members.reduce((s, m) => s + m.centroid[0], 0) / members.length,
        members.reduce((s, m) => s + m.centroid[1], 0) / members.length,
      ];
      // Label on a real bay, the one nearest the cluster's middle.
      const label = members.reduce((best, m) => (distanceM(m.centroid, mean) < distanceM(best.centroid, mean) ? m : best)).centroid;
      const zones = [...new Set(members.map((m) => m.zone).filter(Boolean))].sort();
      segments.push({
        id,
        street,
        t: code,
        zone: zones.join(', '),
        kinds: [...new Set(members.map((m) => m.kind))].sort() as BayKind[],
        bays: members.length,
        kerbM: Math.round(members.reduce((s, m) => s + (m.outline ? principalAxis(m.outline).length : 6), 0)),
        label: roundCoord(label),
        pts: members.map((m) => roundCoord(m.centroid, 5)),
      });
      for (const m of members) segOf.set(m.index, id);
    });
  }
  return { segments, segOf };
}
