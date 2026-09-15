import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const sharedContract = fileURLToPath(new URL('../../packages/design-tokens/index.js', import.meta.url));
// The ONE shared date picker (Calendar / DatePicker / DateRangePicker).
const sharedDatePicker = fileURLToPath(new URL('../../packages/date-picker/index.js', import.meta.url));
const packagesDir = fileURLToPath(new URL('../../packages', import.meta.url));

/**
 * Vite config for the tenant web application (JavaScript). @aba1on1/schemas is
 * aliased to the shared design-token contract in packages/design-tokens, so the
 * app and server render from one source. Tailwind v4 via its Vite plugin. In
 * development /api proxies to the Express app.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // packages/date-picker imports React from outside the app folder; pin one copy.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@aba1on1/schemas': sharedContract,
      '@aba1on1/date-picker': sharedDatePicker,
    },
  },
  server: {
    port: 3000,
    fs: { allow: ['.', packagesDir] },
    proxy: { '/api': { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
  // IS_REACT_ACT_ENVIRONMENT silences React's act() warning and, more
  // importantly, makes act() actually flush effects in component tests.
  // Test runs only: in `vite dev` this flag made React treat the running app as a
  // test environment and log an act() warning on every state update.
  define: process.env.VITEST ? { 'globalThis.IS_REACT_ACT_ENVIRONMENT': 'true' } : {},
  test: { environment: 'jsdom' },
});
