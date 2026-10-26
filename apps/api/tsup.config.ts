import { defineConfig } from 'tsup';

// Bundle the shared framework package (shipped as TypeScript source) into the server build.
export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/seed-demo.ts', 'src/scripts/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: ['@calleval/framework'],
});
