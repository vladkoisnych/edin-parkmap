// Independent British National Grid (OSGB36, EPSG:27700) -> WGS84 conversion,
// used only to sanity-check the server's reprojection. A 7-parameter Helmert
// shift is good to ~5 m, plenty to catch a missing datum transformation
// (which puts everything ~90 m east in Edinburgh).

const deg = Math.PI / 180;

/** OS National Grid easting/northing -> OSGB36 lat/lon (radians), per OS guide annex C. */
function gridToOsgb36(E: number, N: number): [number, number] {
  const a = 6377563.396;
  const b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = 49 * deg;
  const lon0 = -2 * deg;
  const N0 = -100000;
  const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;

  const meridional = (lat: number) =>
    b *
    F0 *
    ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0) -
      (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0) +
      ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0)) -
      (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0)));

  let lat = lat0;
  let M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    M = meridional(lat);
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const tan = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * tan ** 2 + eta2 - 9 * tan ** 2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * tan ** 2 + 45 * tan ** 4);
  const X = 1 / (cos * nu);
  const XI = (1 / (cos * 6 * nu ** 3)) * (nu / rho + 2 * tan ** 2);
  const XII = (1 / (cos * 120 * nu ** 5)) * (5 + 28 * tan ** 2 + 24 * tan ** 4);
  const XIIA = (1 / (cos * 5040 * nu ** 7)) * (61 + 662 * tan ** 2 + 1320 * tan ** 4 + 720 * tan ** 6);
  const dE = E - E0;
  return [
    lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  ];
}

function toCartesian(lat: number, lon: number, a: number, b: number): [number, number, number] {
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [nu * Math.cos(lat) * Math.cos(lon), nu * Math.cos(lat) * Math.sin(lon), (1 - e2) * nu * Math.sin(lat)];
}

function fromCartesian([x, y, z]: [number, number, number], a: number, b: number): [number, number] {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

/** BNG easting/northing -> WGS84 [lng, lat] in degrees (Helmert, ~5 m). */
export function bngToWgs84(E: number, N: number): [number, number] {
  const [lat, lon] = gridToOsgb36(E, N);
  const [x, y, z] = toCartesian(lat, lon, 6377563.396, 6356256.909);
  // OSGB36 -> WGS84 Helmert parameters (OS guide, inverse of the published WGS84->OSGB36 set).
  const tx = 446.448;
  const ty = -125.157;
  const tz = 542.06;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * deg;
  const ry = (0.247 / 3600) * deg;
  const rz = (0.8421 / 3600) * deg;
  const out: [number, number, number] = [
    tx + (1 + s) * x - rz * y + ry * z,
    ty + rz * x + (1 + s) * y - rx * z,
    tz - ry * x + rx * y + (1 + s) * z,
  ];
  const [la, lo] = fromCartesian(out, 6378137, 6356752.3142);
  return [lo / deg, la / deg];
}
