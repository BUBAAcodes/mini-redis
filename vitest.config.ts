import { defineConfig } from 'vitest/config';

// One project per test suite from spec section 15. `npm test` runs the fast
// in-process ones; the others have their own scripts because they need Docker,
// a built server, or a long run time.
const project = (name: string, timeout = 10_000) => ({
  test: {
    name,
    include: [`tests/${name}/**/*.test.ts`],
    environment: 'node' as const,
    testTimeout: timeout,
    hookTimeout: timeout,
  },
});

export default defineConfig({
  test: {
    projects: [
      project('unit'),
      project('property', 60_000),
      project('integration', 20_000),
      project('differential', 300_000),
      project('crash', 600_000),
      project('fuzz', 600_000),
      project('replication', 60_000),
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
