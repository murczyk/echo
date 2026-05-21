import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    setupFiles: ['./src/ts/test/vitest.setup.ts'],
  },
});
