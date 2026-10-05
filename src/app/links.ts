import type { LngLat } from '../lib/geo';

/** Driving directions to exact coordinates: a bare street name is ambiguous on long streets. */
export function googleMapsUrl([lng, lat]: LngLat): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=driving`;
}

export function appleMapsUrl([lng, lat]: LngLat, label: string): string {
  return `https://maps.apple.com/?daddr=${lat.toFixed(6)},${lng.toFixed(6)}&dirflg=d&q=${encodeURIComponent(label)}`;
}
