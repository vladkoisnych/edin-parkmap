import { describe, expect, it } from 'vitest';
import { edinburghClock, formatSchedule, isControlledAt, nextChangeLabel, parseHours } from '../../src/lib/schedule';

describe('parseHours', () => {
  it('parses the weekday tariff text', () => {
    expect(parseHours('Mon-Fri, 8:30am-5:30pm')).toEqual([{ days: [1, 2, 3, 4, 5], start: 510, end: 1050 }]);
  });

  it('parses multi-rule city-centre hours', () => {
    expect(parseHours('Mon-Sat 8:30am-6:30pm. Sun 12:30pm-6:30pm.')).toEqual([
      { days: [1, 2, 3, 4, 5, 6], start: 510, end: 1110 },
      { days: [0], start: 750, end: 1110 },
    ]);
  });

  it('handles 24h times, "to", and day lists', () => {
    expect(parseHours('Mon, Wed & Fri 09:00 to 17:00')).toEqual([{ days: [1, 3, 5], start: 540, end: 1020 }]);
    expect(parseHours('Saturday 12pm-1pm')).toEqual([{ days: [6], start: 720, end: 780 }]);
  });

  it('wraps day ranges across Sunday', () => {
    expect(parseHours('Fri-Mon 8am-6pm')[0].days).toEqual([0, 1, 5, 6]);
  });

  it('rejects text with no schedule', () => {
    expect(() => parseHours('At any time')).toThrow();
    expect(() => parseHours(' ')).toThrow();
  });
});

describe('controlled hours', () => {
  const weekday = parseHours('Mon-Fri, 8:30am-5:30pm');
  // 2026-10-05 is a Monday. October is BST (UTC+1).
  const at = (iso: string) => new Date(iso);

  it('evaluates in Edinburgh time regardless of device zone', () => {
    expect(edinburghClock(at('2026-10-05T07:45:00Z'))).toEqual({ day: 1, minute: 8 * 60 + 45 });
    expect(edinburghClock(at('2026-12-07T08:45:00Z'))).toEqual({ day: 1, minute: 8 * 60 + 45 }); // GMT
  });

  it('is controlled inside hours and free outside', () => {
    expect(isControlledAt(weekday, at('2026-10-05T07:29:00Z'))).toBe(false); // 08:29 BST
    expect(isControlledAt(weekday, at('2026-10-05T07:30:00Z'))).toBe(true); // 08:30
    expect(isControlledAt(weekday, at('2026-10-05T16:29:00Z'))).toBe(true); // 17:29
    expect(isControlledAt(weekday, at('2026-10-05T16:30:00Z'))).toBe(false); // 17:30
    expect(isControlledAt(weekday, at('2026-10-10T11:00:00Z'))).toBe(false); // Saturday
  });

  it('labels the next change', () => {
    expect(nextChangeLabel(weekday, at('2026-10-05T11:00:00Z'))).toBe('until 17:30');
    expect(nextChangeLabel(weekday, at('2026-10-05T05:00:00Z'))).toBe('until 08:30');
    expect(nextChangeLabel(weekday, at('2026-10-09T18:00:00Z'))).toBe('until Mon 08:30'); // Friday evening
  });

  it('formats schedules compactly', () => {
    expect(formatSchedule(weekday)).toBe('Mon–Fri 08:30–17:30');
    expect(formatSchedule(parseHours('Mon-Sat 8:30am-6:30pm. Sun 12:30pm-6:30pm.'))).toBe(
      'Mon–Sat 08:30–18:30; Sun 12:30–18:30',
    );
  });
});
