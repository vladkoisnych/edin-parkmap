import { parseHours, type Schedule } from './schedule';

/** Cheap means £1/hr only (spec decision #1). */
export const CHEAP_PENCE_PER_HOUR = 100;

/** "£4.20/hr" -> 420. Returns null when no hourly price can be read. */
export function parseCostPence(cost: string): number | null {
  const m = cost.replace(/\s/g, '').match(/£(\d+(?:\.\d{1,2})?)(?:\/|per)h/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * 100);
}

/** "Charge B1" -> "B1". */
export function parseChargeCode(charge: string): string {
  return charge.replace(/^\s*charge\s*/i, '').trim();
}

/** "... £11.20 for max 9 hr stay" -> 9. */
export function parseMaxStayHours(remarks: string): number | null {
  const m = remarks.match(/max(?:imum)?\.?\s*(\d+(?:\.\d+)?)\s*(?:hr|hour)/i);
  return m ? Number(m[1]) : null;
}

export interface Tariff {
  code: string;
  cost: string;
  pencePerHour: number;
  hours: string;
  schedule: Schedule;
  remarks: string;
  maxStayHours: number | null;
  cheap: boolean;
}

export interface RawTariffProps {
  Charge?: string;
  Cost?: string;
  Hours?: string;
  Remarks?: string;
}

/** Build a Tariff from council attributes, or explain why it can't be used. */
export function tariffFromProps(p: RawTariffProps): Tariff | { error: string } {
  const code = parseChargeCode(p.Charge ?? '');
  if (!code) return { error: 'missing Charge' };
  const pence = parseCostPence(p.Cost ?? '');
  if (pence == null) return { error: `unparseable Cost "${p.Cost}"` };
  let schedule: Schedule;
  try {
    schedule = parseHours(p.Hours ?? '');
  } catch (e) {
    return { error: (e as Error).message };
  }
  const remarks = (p.Remarks ?? '').trim();
  return {
    code,
    cost: (p.Cost ?? '').trim(),
    pencePerHour: pence,
    hours: (p.Hours ?? '').trim(),
    schedule,
    remarks,
    maxStayHours: parseMaxStayHours(remarks),
    cheap: pence <= CHEAP_PENCE_PER_HOUR,
  };
}

export function formatPrice(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}/hr` : `£${(pence / 100).toFixed(2)}/hr`;
}
