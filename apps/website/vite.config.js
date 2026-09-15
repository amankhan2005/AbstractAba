import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const sharedContract = fileURLToPath(new URL('../../packages/design-tokens/index.js', import.meta.url));
const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

/**
 * Vite config for the public Abstract ABA website (JavaScript). A separate
 * application from the tenant web panel (apps/web) and the platform console
 * (apps/console). It shares only the brand contract in packages/design-tokens
 * (@aba1on1/schemas) and talks to the existing API (apps/api) for the contact
 * form. In development /api proxies to the Express app, so no CORS change is
 * needed locally.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@aba1on1/schemas': sharedContract,
    },
  },
  server: {
    port: 3200,
    fs: { allow: ['.', packagesDir] },
    proxy: { '/api': { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000', changeOrigin: true } },
  },
  preview: { port: 3200 },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  define: process.env.VITEST ? { 'globalThis.IS_REACT_ACT_ENVIRONMENT': 'true' } : {},
  test: { environment: 'jsdom' },
});
