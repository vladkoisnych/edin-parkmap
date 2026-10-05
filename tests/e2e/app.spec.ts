import { expect, test, type Page } from '@playwright/test';

// Keep tests hermetic: no map tiles, canned geocoder answers.
async function stubNetwork(page: Page) {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  await page.route(/nominatim\.openstreetmap\.org/, (r) =>
    r.fulfill({
      json: [{ lat: '55.9640', lon: '-3.2150', display_name: 'Fettes College, Carrington Road, Edinburgh, EH4 1QX' }],
    }),
  );
  await page.route(/api\.postcodes\.io/, (r) =>
    r.fulfill({ json: { status: 200, result: { postcode: 'EH3 5LR', latitude: 55.9628, longitude: -3.2045 } } }),
  );
}

async function ready(page: Page) {
  await stubNetwork(page);
  await page.goto('./');
  await expect(page.locator('#data-date')).toContainText('Data as of');
  await page.waitForFunction(() => (window as any).__parkmap);
}

async function clipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('loads the map with £1/hr pins and the signage notice', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.cheap-pin').first()).toBeAttached();
  await expect(page.locator('.notice')).toContainText('Check the signs');
  await page.locator('#legend-chip').tap();
  await expect(page.locator('#legend')).toBeVisible();
  await expect(page.locator('#legend')).toContainText('£1/hr bays');
});

test('tapping a bay on the map copies its street and opens the sheet', async ({ page }) => {
  await ready(page);
  // Centre a known £1/hr segment at street zoom, then tap the middle of the map.
  const street = await page.evaluate(() => {
    const { map, data } = (window as any).__parkmap;
    const seg = data.segments.find((s: any) => data.meta.tariffs[s.t].cheap && s.bays >= 3);
    map.setView([seg.label[1], seg.label[0]], 19, { animate: false });
    return seg.street as string;
  });
  const box = (await page.locator('#map').boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.locator('#toast')).toHaveText(`Copied: ${street}, Edinburgh`);
  expect(await clipboard(page)).toBe(`${street}, Edinburgh`);
  const sheet = page.locator('#sheet');
  await expect(sheet.locator('h2')).toHaveText(street);
  await expect(sheet).toContainText('£1/hr');
  await expect(sheet.getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute('href', /google\.com\/maps\/dir\/.*destination=55\.\d+,-3\.\d+/);
  await expect(sheet.getByRole('link', { name: 'Open in Apple Maps' })).toHaveAttribute('href', /maps\.apple\.com\/\?daddr=55\.\d+,-3\.\d+/);

  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toBeHidden();
});

test('search ranks £1/hr streets and free streets, and tapping a result copies it', async ({ page }) => {
  await ready(page);
  await page.locator('#search-input').fill('Fettes College');
  await page.locator('#search-input').press('Enter');

  const sheet = page.locator('#sheet');
  await expect(sheet.locator('h2')).toContainText('Near Fettes College');
  const rows = sheet.locator('.result');
  await expect(rows).toHaveCount(10);

  // Sorted by distance, one row per street.
  const metres = await rows.locator('.dist').evaluateAll((els) =>
    els.map((e) => {
      const t = e.childNodes[0].textContent!;
      return t.endsWith('km') ? parseFloat(t) * 1000 : parseFloat(t);
    }),
  );
  expect(metres).toEqual([...metres].sort((a, b) => a - b));
  const streets = await rows.locator('strong').allTextContents();
  expect(new Set(streets).size).toBe(streets.length);

  await sheet.getByRole('button', { name: 'Top 5' }).tap();
  await expect(rows).toHaveCount(5);

  await sheet.getByRole('tab', { name: /Free/ }).tap();
  await expect(rows.first()).toContainText('outside controlled zone');

  const first = (await rows.first().locator('strong').textContent())!;
  await rows.first().tap();
  await expect(page.locator('#toast')).toHaveText(`Copied: ${first}, Edinburgh`);
  await expect(sheet.locator('h2')).toHaveText(first);
  await sheet.getByRole('button', { name: '← Back to results' }).tap();
  await expect(sheet.locator('h2')).toContainText('Near Fettes College');
});

test('postcodes go to postcodes.io', async ({ page }) => {
  await ready(page);
  await page.locator('#search-input').fill('eh3 5lr');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('#sheet h2')).toHaveText('Near EH3 5LR');
});

test('works offline after the first visit', async ({ page, context }) => {
  await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Reload once so the now-active worker controls the page and caches data.
  await page.reload();
  await expect(page.locator('#data-date')).toContainText('Data as of');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#data-date')).toContainText('Data as of');
  await expect(page.locator('.cheap-pin').first()).toBeAttached();
});
