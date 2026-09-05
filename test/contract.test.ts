/**
 * Runs unchanged against every registered adapter: for each one, parse every
 * fixture at test/fixtures/<id>/ and assert the invariants every adapter's
 * output must satisfy regardless of source format. The registry is a static
 * list now (src/agents/index.ts), so unlike OLD there is no directory scan
 * and no broken-adapter-is-skipped behaviour to test.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { template } from '../src/agents/_template';
import { agents } from '../src/agents/index';
import type { Adapter } from '../src/agents/types';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Every method + property the Adapter interface (src/agents/types.ts)
// requires. Kept explicit, not derived, so a future field must be added here
// deliberately.
const REQUIRED_KEYS: Array<keyof Adapter> = [
  'id',
  'displayName',
  'capabilities',
  'sessionEnvVars',
  'detectInstalled',
  'skillDirs',
  'locate',
  'findSession',
  'newestForCwd',
  'parse',
  'edits',
  'children',
  'ui',
  'sessionIdFor',
  'looksLikeOwnFile',
];

const REQUIRED_CAPABILITIES: Array<keyof Adapter['capabilities']> = [
  'parse',
  'liveSession',
  'edits',
  'tokens',
  'hooks',
  'statusline',
  'subagents',
];

test('contract: every adapter implements every required method of the Adapter interface', () => {
  for (const adapter of agents()) {
    for (const key of REQUIRED_KEYS) {
      expect(adapter[key], `adapter "${adapter.id}" is missing "${key}"`).not.toBeUndefined();
    }
  }
});

test('contract: capabilities.tokens is a plain boolean on every adapter (never "partial" etc.)', () => {
  for (const adapter of agents()) {
    expect(typeof adapter.capabilities.tokens).toBe('boolean');
    for (const cap of REQUIRED_CAPABILITIES) {
      expect(
        typeof adapter.capabilities[cap],
        `adapter "${adapter.id}".capabilities.${cap} is ${JSON.stringify(adapter.capabilities[cap])}, expected a boolean`,
      ).toBe('boolean');
    }
  }
});

test('contract: the _template adapter satisfies the Adapter interface with every capability false', () => {
  for (const key of REQUIRED_KEYS) {
    expect(template[key], `template adapter is missing "${key}"`).not.toBeUndefined();
  }
  for (const cap of REQUIRED_CAPABILITIES) {
    expect(
      template.capabilities[cap],
      `template.capabilities.${cap} is ${JSON.stringify(template.capabilities[cap])}, expected false`,
    ).toBe(false);
  }
});

test('contract: the _template adapter is not registered (it is a copyable skeleton, not a real agent)', () => {
  expect(agents().some((a) => a.id === template.id)).toBe(false);
});

function fixturesFor(agentId: string): string[] {
  const dir = path.join(FIXTURES_DIR, agentId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f));
}

describe('contract: shared invariants', () => {
  for (const adapter of agents()) {
    const fixtures = fixturesFor(adapter.id);
    for (const fixture of fixtures) {
      test(`[${adapter.id}] ${path.basename(fixture)} satisfies the shared invariants`, () => {
        const session = adapter.parse(fixture);

        expect(session).toBeTruthy();
        expect(Array.isArray(session.turns)).toBe(true);
        expect(session.turns.length).toBeGreaterThan(0);

        // turns sorted chronologically
        for (let i = 1; i < session.turns.length; i++) {
          expect(
            (session.turns[i] as (typeof session.turns)[number]).tsMicros,
            `turn ${i} is not chronologically after turn ${i - 1}`,
          ).toBeGreaterThanOrEqual((session.turns[i - 1] as (typeof session.turns)[number]).tsMicros);
        }

        // ids unique (both short id and full id)
        const ids = new Set<string>();
        const fullIds = new Set<string>();
        for (const t of session.turns) {
          expect(ids.has(t.id), `duplicate short id ${t.id}`).toBe(false);
          ids.add(t.id);
          expect(fullIds.has(t.fullId), `duplicate full id ${t.fullId}`).toBe(false);
          fullIds.add(t.fullId);
        }

        // gid format: <agent>:<sessionId8>:<shortId>
        const gidRe = /^[^:]+:[^:]{0,8}:[^:]+$/;
        for (const t of session.turns) {
          expect(t.gid).toMatch(gidRe);
          expect(t.gid.split(':')[0]).toBe(adapter.id);
        }

        // parentId references an existing turn's fullId, or is null
        for (const t of session.turns) {
          if (t.parentId === null || t.parentId === undefined) continue;
          expect(fullIds.has(t.parentId), `parentId ${t.parentId} does not reference any turn`).toBe(true);
        }

        // durations are never negative
        for (const t of session.turns) {
          expect(t.durationS, `turn ${t.id} has a negative duration (${t.durationS})`).toBeGreaterThanOrEqual(
            0,
          );
        }
      });
    }
  }
});

test('contract: at least one adapter has fixtures (this test suite is not vacuous)', () => {
  const any = agents().some((a) => fixturesFor(a.id).length > 0);
  expect(any).toBe(true);
});
