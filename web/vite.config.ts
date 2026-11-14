import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The rules engine is the workspace package `@notit/engine` (../engine, plain
// TypeScript source). Vite compiles it as part of the app; run `npm install`
// from the repo root so the workspace link exists.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
