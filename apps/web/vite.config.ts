import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fixed file names so the built app can be published as a page plus two supporting files.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:8787', changeOrigin: true },
      '/webhooks': { target: process.env.API_URL ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app[extname]',
        inlineDynamicImports: true,
      },
    },
  },
});
