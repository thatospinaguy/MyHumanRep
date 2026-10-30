import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds the admin SPA into the Worker's static assets directory under /admin/.
// The Worker serves these files only after Cloudflare Access verification.
export default defineConfig({
  root: 'src/web/admin',
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: '../../../dist/client/admin',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
