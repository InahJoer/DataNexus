import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Pruebas e2e (issue #50): levantan la API completa contra PostgreSQL real.
 * test/e2e/setup.ts crea un esquema aislado por suite y lo elimina al terminar.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/e2e/setup.ts'],
    // Migrar un esquema por suite tarda unos segundos.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
