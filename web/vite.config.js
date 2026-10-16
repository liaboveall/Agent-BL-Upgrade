// Vite builds the React dashboard from web/ into dist/, which src/app/server.js serves.
// Static assets that keep their names (chain-config.json, vendored ethers/cosmjs, cargo pictures)
// live in public/ and are copied as-is.
//
// `npm run dev:web` serves the app with hot reload on :5173 and forwards /api to the Node server
// (start it with `npm run dev` or `npm start`; AGENTBL_API_URL overrides the target).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = process.env.AGENTBL_API_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  root,
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    // The page runs under a strict CSP (script-src 'self'): no inline module preload polyfill.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/api': { target: api, changeOrigin: false } }
  }
});
