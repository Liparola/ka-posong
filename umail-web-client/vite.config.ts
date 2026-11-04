import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/umail/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'uMail — Liparola Instant Business Mail',
        short_name: 'uMail',
        description: 'Bespoke Multi-Tenant Instant Webmail Client powered by UMANG Phone Identity & Stalwart Mail',
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
