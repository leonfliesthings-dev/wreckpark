import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // During `npm run dev` the game server runs separately on 8080.
    // The client auto-detects this and points its socket at 8080.
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    chunkSizeWarningLimit: 2000,
  },
  // rapier3d-compat ships its wasm inlined as base64, so no special plugin needed.
  optimizeDeps: {
    exclude: [],
  },
});
