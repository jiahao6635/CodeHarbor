import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const API_TARGET = process.env.CODEHARBOR_API ?? 'http://127.0.0.1:8080';

// The console is served by the CodeHarbor service under /ui. In development Vite proxies the API to a
// locally running service and rewrites Host/Origin so the service's same-origin check passes.
export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Never inline assets: the /ui CSP forbids data: fonts and scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, headers: { origin: API_TARGET } },
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
