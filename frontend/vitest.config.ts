import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
