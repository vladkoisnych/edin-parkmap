// Controlled-hours schedules, parsed from the council's free-text `Hours`
// field (e.g. "Mon-Sat 8:30am-6:30pm. Sun 12:30pm-6:30pm.").

/** Days use JS numbering: 0 = Sunday … 6 = Saturday. Times are minutes after midnight. */
export interface ScheduleRule {
  days: number[];
  start: number;
  end: number;
}
export type Schedule = ScheduleRule[];

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayIndex(token: string): number {
  const i = DAY_NAMES.indexOf(token.slice(0, 3).toLowerCase());
  if (i < 0) throw new Error(`Unknown day "${token}"`);
  return i;
}

function parseDays(spec: string): number[] {
  const days = new Set<number>();
  for (const part of spec.split(/\s*(?:,|&|and)\s*/i).filter(Boolean)) {
    const range = part.split(/\s*(?:-|–|to)\s*/i);
    if (range.length === 2) {
      const a = dayIndex(range[0]);
      const b = dayIndex(range[1]);
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    } else {
      days.add(dayIndex(part));
    }
  }
  return [...days].sort((x, y) => x - y);
}

function parseTime(t: string): number {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`Unparseable time "${t}"`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) throw new Error(`Out of range time "${t}"`);
  return h * 60 + min;
}

const DAY_TOKEN = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
const TIME_TOKEN = '\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?';
const RULE_RE = new RegExp(
  `(${DAY_TOKEN}(?:\\s*(?:-|–|to|,|&|and)\\s*${DAY_TOKEN})*)[\\s,:]*(${TIME_TOKEN})\\s*(?:-|–|to)\\s*(${TIME_TOKEN})`,
  'gi',
);

/** Parse a council hours string. Throws if nothing recognisable is found. */
export function parseHours(text: string): Schedule {
  const rules: Schedule = [];
  for (const m of text.matchAll(RULE_RE)) {
    const start = parseTime(m[2]);
    const end = parseTime(m[3]);
    if (end <= start) throw new Error(`End before start in "${m[0]}"`);
    rules.push({ days: parseDays(m[1]), start, end });
  }
  if (!rules.length) throw new Error(`No schedule found in "${text}"`);
  return rules;
}

/** Day of week and minute-of-day in Edinburgh, whatever the device timezone. */
export function edinburghClock(date: Date): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: dayIndex(get('weekday')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function isControlledAt(schedule: Schedule, date: Date): boolean {
  const { day, minute } = edinburghClock(date);
  return schedule.some((r) => r.days.includes(day) && minute >= r.start && minute < r.end);
}

function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtDays(days: number[]): string {
  // Collapse consecutive runs: [1,2,3,4,5] -> "Mon–Fri".
  const runs: number[][] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length > 2 ? `${DAY_LABELS[r[0]]}–${DAY_LABELS[r[r.length - 1]]}` : r.map((d) => DAY_LABELS[d]).join(', ')))
    .join(', ');
}

/** Human summary, e.g. "Mon–Fri 08:30–17:30". */
export function formatSchedule(schedule: Schedule): string {
  return schedule.map((r) => `${fmtDays(r.days)} ${fmtTime(r.start)}–${fmtTime(r.end)}`).join('; ');
}

/**
 * When the controlled status next flips, as a short label like "until 17:30"
 * or "until Mon 08:30". Looks up to a week ahead.
 */
export function nextChangeLabel(schedule: Schedule, date: Date): string | null {
  const { day, minute } = edinburghClock(date);
  const now = isControlledAt(schedule, date);
  for (let step = 1; step <= 7 * 24 * 4; step++) {
    const t = minute + step * 15;
    const d = (day + Math.floor(t / 1440)) % 7;
    const m = t % 1440;
    const controlled = schedule.some((r) => r.days.includes(d) && m >= r.start && m < r.end);
    if (controlled !== now) {
      // Snap to the rule boundary rather than the 15-minute probe.
      const boundary = schedule
        .flatMap((r) => (r.days.includes(d) ? [r.start, r.end] : []))
        .filter((b) => b <= m && b > m - 15)[0] ?? m;
      return Math.floor(t / 1440) === 0 ? `until ${fmtTime(boundary)}` : `until ${DAY_LABELS[d]} ${fmtTime(boundary)}`;
    }
  }
  return null;
}
