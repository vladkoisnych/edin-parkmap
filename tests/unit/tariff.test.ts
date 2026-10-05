import { describe, expect, it } from 'vitest';
import { formatPrice, parseChargeCode, parseCostPence, parseMaxStayHours, tariffFromProps } from '../../src/lib/tariff';

describe('tariff parsing', () => {
  it('reads hourly prices in pence', () => {
    expect(parseCostPence('£1/hr')).toBe(100);
    expect(parseCostPence('£4.20/hr')).toBe(420);
    expect(parseCostPence('£ 6.80 / hr')).toBe(680);
    expect(parseCostPence('£9 per hour')).toBe(900);
    expect(parseCostPence('Free')).toBeNull();
  });

  it('reads charge codes and max stay', () => {
    expect(parseChargeCode('Charge B1')).toBe('B1');
    expect(parseMaxStayHours('£1/hr up to £8.00 for 8 hrs, £11.20 for max 9 hr stay')).toBe(9);
    expect(parseMaxStayHours(' ')).toBeNull();
  });

  it('builds a cheap tariff from council attributes', () => {
    const t = tariffFromProps({
      Charge: 'Charge E',
      Cost: '£1/hr',
      Hours: 'Mon-Fri, 8:30am-5:30pm',
      Remarks: '£1/hr up to £8.00 for 8 hrs, £11.20 for max 9 hr stay',
    });
    expect(t).toMatchObject({ code: 'E', pencePerHour: 100, cheap: true, maxStayHours: 9 });
  });

  it('marks dearer tariffs as not cheap and reports unparseable ones', () => {
    expect(tariffFromProps({ Charge: 'Charge D', Cost: '£4.20/hr', Hours: 'Mon-Fri, 8:30am-5:30pm', Remarks: ' ' })).toMatchObject({
      cheap: false,
      remarks: '',
    });
    expect(tariffFromProps({ Charge: 'Charge X', Cost: 'tbc', Hours: 'Mon-Fri 9am-5pm' })).toHaveProperty('error');
  });

  it('formats prices', () => {
    expect(formatPrice(100)).toBe('£1/hr');
    expect(formatPrice(420)).toBe('£4.20/hr');
  });
});
