import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const tenantDomain = process.env.VITE_TENANT_DOMAIN || '';
const tenantName =
  process.env.VITE_TENANT_NAME ||
  (tenantDomain ? `uMail — ${tenantDomain}` : 'uMail — Instant Business Mail');

export default defineConfig({
  base: '/umail/',
  server: {
    host: '127.0.0.1',
    port: 5176,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
      includeAssets: ['favicon.svg'],
      manifest: {
        name: tenantName,
        short_name: 'uMail',
        description: `Bespoke Multi-Tenant Instant Webmail Client${tenantDomain ? ` for ${tenantDomain}` : ''} powered by UMANG Phone Identity & Stalwart Mail`,
        start_url: '/umail/',
        scope: '/umail/',
        theme_color: '#6200ee',
        background_color: '#f5f5f5',
        display: 'standalone',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ]
});
