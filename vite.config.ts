/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from /<repo>/; CI sets BASE_PATH accordingly.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: { target: 'es2022', sourcemap: true },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Edinburgh Cheap Parking',
        short_name: 'Cheap Parking',
        description: 'Find £1/hr and free on-street parking in Edinburgh.',
        theme_color: '#d4007a',
        background_color: '#f6f5f2',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is precached; data files are cached as they are fetched so
        // the last good snapshot works offline, refreshed in the background.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/data/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'parking-data', expiration: { maxEntries: 20 } },
          },
        ],
        // Map tiles are deliberately not cached (tile usage policies).
      },
    }),
  ],
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
