import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Isolation tests share one database and assert on cross-tenant visibility.
    // Running files in parallel would let one file's fixtures appear in
    // another's scope and produce false passes. Serialize them.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
