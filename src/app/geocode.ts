import type { LngLat } from '../lib/geo';

/** Edinburgh viewbox (west, north, east, south) for Nominatim's bounded search. */
export const EDINBURGH_VIEWBOX = [-3.45, 56.0, -3.05, 55.84] as const;

const POSTCODE_RE = /^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$/i;
const OUTCODE_RE = /^\s*(EH\d{1,2})\s*$/i;

export interface GeocodeResult {
  point: LngLat;
  label: string;
}

export function isPostcode(q: string): boolean {
  return POSTCODE_RE.test(q) || OUTCODE_RE.test(q);
}

async function postcodeLookup(q: string): Promise<GeocodeResult | null> {
  const full = q.match(POSTCODE_RE);
  const url = full
    ? `https://api.postcodes.io/postcodes/${encodeURIComponent(`${full[1]} ${full[2]}`)}`
    : `https://api.postcodes.io/outcodes/${encodeURIComponent(q.trim())}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Postcode lookup failed (${res.status})`);
  const { result } = await res.json();
  if (!result || result.longitude == null) return null;
  return { point: [result.longitude, result.latitude], label: (result.postcode ?? result.outcode ?? q).toUpperCase() };
}

async function nominatim(q: string): Promise<GeocodeResult | null> {
  const [w, n, e, s] = EDINBURGH_VIEWBOX;
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    limit: '1',
    bounded: '1',
    viewbox: `${w},${n},${e},${s}`,
    countrycodes: 'gb',
    addressdetails: '0',
  });
  // Nominatim identifies apps by Referer, which the browser sends for us.
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'Accept-Language': 'en-GB' },
  });
  if (!res.ok) throw new Error(`Address search failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  const label = String(hit.display_name ?? q)
    .split(',')
    .slice(0, 2)
    .join(',')
    .trim();
  return { point: [Number(hit.lon), Number(hit.lat)], label };
}

/** One request per submit (no autocomplete, per Nominatim policy). */
export async function geocode(q: string): Promise<GeocodeResult | null> {
  const query = q.trim();
  if (!query) return null;
  if (isPostcode(query)) return postcodeLookup(query);
  return nominatim(query);
}
