// Render PNG app icons from public/icon.svg (run once, outputs are committed).
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile('public/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [size, file, pad] of [
  [192, 'public/pwa-192.png', 0],
  [512, 'public/pwa-512.png', 0],
  [512, 'public/pwa-maskable-512.png', 0.1],
  [180, 'public/apple-touch-icon.png', 0],
] as const) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  // Maskable icons need a full-bleed background with the mark in the safe zone.
  await page.setContent(
    `<body style="margin:0;background:#d4007a;display:grid;place-items:center;height:${size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`,
  );
  await page.screenshot({ path: file, omitBackground: pad === 0 && file.includes('apple') === false });
  console.log('wrote', file);
}
await browser.close();
