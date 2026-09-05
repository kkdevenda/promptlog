import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // The integration files spawn dozens of git and node processes; run test
    // files one at a time so they cannot starve vitest's own worker channel on
    // small CI runners (seen as "Timeout calling onTaskUpdate" with all tests green).
    fileParallelism: false,
    env: { PROMPTLOG_NO_UPDATE_CHECK: '1' },
  },
});
