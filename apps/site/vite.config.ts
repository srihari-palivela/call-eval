import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { SITE } from './src/site';

// Brand, domain and description live in src/site.ts; the page's meta tags read them from there.
function siteMeta(): Plugin {
  return {
    name: 'site-meta',
    // Before Vite reads the page's links, so it never sees an unreplaced placeholder.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html
          .replaceAll('%BRAND%', SITE.brand)
          .replaceAll('%DOMAIN%', SITE.domain)
          .replaceAll('%TITLE%', SITE.title)
          .replaceAll('%DESCRIPTION%', SITE.description),
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [react(), siteMeta()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    // The 3D scene is its own chunk, loaded after the page has painted.
    chunkSizeWarningLimit: 1200,
  },
  // The prerender build bundles everything, so it runs without resolving packages at runtime.
  ssr: { noExternal: true },
});
