import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Permite que las pruebas de memoria (p. ej. la paginación de 1M filas) midan la memoria retenida con gc().
    execArgv: ['--expose-gc'],
  },
});
