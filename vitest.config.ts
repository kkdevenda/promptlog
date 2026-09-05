import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // The integration files spawn dozens of git and node processes; run the
    // whole suite in ONE forked child process rather than a pool of worker
    // threads, so it cannot starve vitest's own worker RPC channel on small
    // CI runners (seen as "Timeout calling onTaskUpdate" with all tests
    // green, on both macOS and Windows CI - `fileParallelism: false` alone
    // did not fix it: that still runs each file in its own worker thread,
    // one after another, and it is the RPC channel back to the main process
    // that was starving, not file-level concurrency). `pool: 'forks'` with
    // `singleFork: true` is the same idea as `--runInBand` elsewhere.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: { PROMPTLOG_NO_UPDATE_CHECK: '1' },
  },
});
