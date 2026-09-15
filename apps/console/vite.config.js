import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const sharedContract = fileURLToPath(new URL('../../packages/design-tokens/index.js', import.meta.url));
// The ONE shared date picker (Calendar / DatePicker / DateRangePicker).
const sharedDatePicker = fileURLToPath(new URL('../../packages/date-picker/index.js', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    // packages/date-picker imports React from outside the app folder; pin one copy.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Single canonical source shared with the API + tenant web app (US states,
      // design tokens). Same alias name the web app uses.
      '@aba1on1/schemas': sharedContract,
      '@aba1on1/date-picker': sharedDatePicker,
    },
  },

  server: {
    port: 3100,

    proxy: {
      '/api/v1': {
        target:
          process.env.VITE_API_PROXY_TARGET ??
          'http://localhost:4000',

        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },

  // Makes React act() flush effects in jsdom component tests (parity with the
  // web app); silences the "environment not configured to support act" notice.
  define: { 'globalThis.IS_REACT_ACT_ENVIRONMENT': 'true' },

  test: {
    environment: 'node',
  },
});