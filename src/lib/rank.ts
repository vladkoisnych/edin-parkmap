import { distanceM, type LngLat } from './geo';

export const WALK_M_PER_MIN = 80;

export interface Candidate {
  id: string;
  street: string;
  pts: LngLat[];
}

export interface Ranked<T extends Candidate> {
  item: T;
  distanceM: number;
  /** The candidate point closest to the destination. */
  nearest: LngLat;
}

/**
 * Rank candidates by straight-line distance from `dest` to their nearest
 * point, keeping only the closest candidate per street so one long street
 * can't fill the list.
 */
export function rankByDistance<T extends Candidate>(dest: LngLat, items: T[], limit: number): Ranked<T>[] {
  const bestPerStreet = new Map<string, Ranked<T>>();
  for (const item of items) {
    let best: Ranked<T> | null = null;
    for (const p of item.pts) {
      const d = distanceM(dest, p);
      if (!best || d < best.distanceM) best = { item, distanceM: d, nearest: p };
    }
    if (!best) continue;
    const key = item.street.toLowerCase();
    const prev = bestPerStreet.get(key);
    if (!prev || best.distanceM < prev.distanceM) bestPerStreet.set(key, best);
  }
  return [...bestPerStreet.values()].sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

export function walkMinutes(distanceM: number): number {
  return Math.max(1, Math.round(distanceM / WALK_M_PER_MIN));
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}
