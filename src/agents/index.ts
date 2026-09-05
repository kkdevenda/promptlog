/**
 * The adapter registry: the only place core code names an agent. Adding an
 * agent is one directory under src/agents/ plus one line here.
 */

import { claude } from './claude';
import { codex } from './codex';
import { cursor } from './cursor';
import type { Adapter } from './types';

const ALL: readonly Adapter[] = [claude, codex, cursor].sort((a, b) => a.id.localeCompare(b.id));

/** Every adapter, sorted by id. */
export function agents(): readonly Adapter[] {
  return ALL;
}

export function byId(id: string): Adapter | undefined {
  return ALL.find((a) => a.id === id);
}

/** Adapters whose agent is installed on this machine. */
export function detectInstalled(home: string): Adapter[] {
  return ALL.filter((a) => {
    try {
      return a.detectInstalled(home);
    } catch {
      return false;
    }
  });
}
