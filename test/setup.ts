/**
 * vitest `setupFiles` entry (see vitest.config.ts).
 *
 * The heavy suites (integration, multiperson, attribution, git, skill,
 * status, cli) run long chains of synchronous `spawnSync` calls back to back
 * and never yield to the event loop between tests. On slow CI runners that
 * starves vitest's own worker RPC channel (birpc) long enough that its
 * "onTaskUpdate" acknowledgement from the main process never gets processed
 * before birpc's own timer fires, surfacing as
 * `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` even though every
 * test itself passed. Yielding once via `setImmediate` before and after each
 * test gives the event loop - and that IPC traffic - a turn to run.
 */

import { afterEach, beforeEach } from 'vitest';

beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
