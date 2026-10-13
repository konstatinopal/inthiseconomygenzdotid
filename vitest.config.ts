import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // Several suites hash passwords with bcrypt (deliberately slow) and run in parallel.
    testTimeout: 20_000,
  },
});
