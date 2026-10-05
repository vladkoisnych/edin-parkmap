import { describe, expect, it } from 'vitest';
import { distanceM } from '../../src/lib/geo';
import { bngToWgs84 } from '../../pipeline/datum';

describe('bngToWgs84', () => {
  it('matches the OS worked example to within a few metres', () => {
    // Ordnance Survey's guide: TG 51409 13177 (E 651409.903, N 313177.270)
    // is 52°39'27.2531"N 1°43'4.5177"E in OSGB36. WGS84 sits ~45 m north and
    // ~125 m west of that in Norfolk.
    const [lng, lat] = bngToWgs84(651409.903, 313177.27);
    const osgb36: [number, number] = [1.7179216, 52.6575703];
    expect(lat).toBeCloseTo(52.65798, 4);
    expect(lng).toBeCloseTo(1.71605, 4);
    expect(distanceM([lng, lat], osgb36)).toBeGreaterThan(100);
  });

  it('agrees with the council server’s transformed output in Edinburgh', () => {
    // Harrison Road vertex: native BNG vs server WGS84 with datumTransformation=1314.
    const ours = bngToWgs84(323494, 672022.0001);
    expect(distanceM(ours, [-3.2262146335462143, 55.93514431464314])).toBeLessThan(10);
    // ...and is far from the untransformed output that put bays a street off.
    expect(distanceM(ours, [-3.2247954848474856, 55.93520058319686])).toBeGreaterThan(50);
  });
});
