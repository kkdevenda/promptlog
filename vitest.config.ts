import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Integration tests spawn many git and node processes; on 3-core CI
    // runners more workers starve the worker RPC and vitest reports a timeout.
    maxWorkers: 2,
    env: { PROMPTLOG_NO_UPDATE_CHECK: '1' },
  },
});
