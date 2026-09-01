import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 05-UI.md §4.1 — assets are built once and served by the daemon; no dev
// server in production. `base: './'` so the built asset URLs are relative
// (the daemon can serve them from any path, and there's no CDN).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // `vite dev` proxies API/hook calls to a locally running daemon —
      // set VITE_DAEMON_PORT to point it at one (see README).
      '/api': `http://127.0.0.1:${process.env.VITE_DAEMON_PORT ?? '4711'}`,
    },
  },
});
