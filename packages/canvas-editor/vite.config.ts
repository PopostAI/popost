import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone build of the canvas editor. Relative asset URLs (`base: './'`) let the same
// bundle run under the web app (`<BASE>/canvas/`) and the skill server (`/_editor/`).
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  resolve: { alias: { '@editor': path.resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
