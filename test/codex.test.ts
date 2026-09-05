import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { codex } from '../src/agents/codex';
import { edits as codexEdits, parseV4A } from '../src/agents/codex/edits';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'codex');

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `promptlog-${name}-`));
}

describe('codex edits(): apply_patch hunks, add/delete/move, and shell writes', () => {
  test('parses the fixture rollout', () => {
    const fixture = path.join(FIXTURES_DIR, 'apply-patch.jsonl');
    const session = codex.parse(fixture);
    const root = '/tmp/promptlog-fixture';
    const list = codexEdits(session, { root });

    expect(codex.capabilities.edits).toBe(true);

    const byRelOp = (rel: string, op?: string) =>
      list.find((e) => e.rel === rel && (op === undefined || (e as { op?: string }).op === op));

    const helper = byRelOp('src/helper.py', 'update');
    expect(helper).toBeTruthy();
    expect(helper?.kind).toBe('patch');
    expect(helper?.hunks).toEqual([
      {
        removed: ['def old_name(value):', '    return value'],
        added: ['def new_name(value):', '    return value.strip()'],
      },
    ]);
    expect(helper?.turnId).toBe(session.turns[0]?.gid);

    const added = byRelOp('docs/README.md');
    expect((added as { op?: string } | undefined)?.op).toBe('add');
    expect(added?.hunks?.[0]?.added).toEqual(['# Helper', '', 'One function, one job.']);
    expect(added?.hunks?.[0]?.removed).toEqual([]);

    const deleted = byRelOp('src/legacy.py', 'delete');
    expect(deleted).toBeTruthy();
    expect(deleted?.hunks).toEqual([]);

    // `*** Move to:` attributes the new path (and marks the old one changed).
    const moved = list.find((e) => e.rel === 'lib/helper.py');
    expect((moved as { movedFrom?: string } | undefined)?.movedFrom).toBe('src/helper.py');
    expect(moved?.turnId).toBe(session.turns[1]?.gid);
    expect(list.some((e) => e.rel === 'src/helper.py' && (e as { op?: string }).op === 'move-from')).toBe(
      true,
    );

    // Tier B, from both shell shapes Codex uses.
    const shell = list
      .filter((e) => e.kind === 'shell')
      .map((e) => e.rel)
      .sort();
    expect(shell).toEqual(['build/helper.py', 'lib/notes.txt', 'tests/test_helper.py']);
  });
});

test('parseV4A handles every directive and ignores anything before the header', () => {
  expect(parseV4A('not a patch')).toEqual([]);
  const files = parseV4A(
    [
      'chatter the model emitted first',
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@ class Foo',
      ' context stays out of it',
      '-gone',
      '+here',
      '@@',
      '+second hunk',
      '*** End Patch',
      'trailing chatter',
    ].join('\n'),
  );
  expect(files.length).toBe(1);
  expect(files[0]?.file).toBe('a.txt');
  expect(files[0]?.hunks.length).toBe(2);
  expect(files[0]?.hunks[0]).toEqual({ removed: ['gone'], added: ['here'] });
  expect(files[0]?.hunks[1]).toEqual({ removed: [], added: ['second hunk'] });
});

// --------------------------------------------------------------------------
// Subagents (children())
// --------------------------------------------------------------------------

function codexRollout(
  file: string,
  {
    id,
    parentId,
    ts,
    prompts = [],
    totals = [],
  }: {
    id: string;
    parentId?: string;
    ts: string;
    prompts?: Array<{ text: string; ts: string; endTs: string; durationS: number }>;
    totals?: Array<Record<string, number>>;
  },
): void {
  const recs: unknown[] = [
    {
      type: 'session_meta',
      timestamp: ts,
      payload: { id, cwd: '/repo', timestamp: ts, originator: 'codex-tui', parent_thread_id: parentId },
    },
  ];
  prompts.forEach((p, i) => {
    recs.push({ type: 'event_msg', timestamp: p.ts, payload: { type: 'task_started' } });
    recs.push({ type: 'event_msg', timestamp: p.ts, payload: { type: 'user_message', message: p.text } });
    const t = totals[i];
    if (t) {
      recs.push({
        type: 'event_msg',
        timestamp: p.endTs,
        payload: { type: 'token_count', info: { total_token_usage: t, last_token_usage: t } },
      });
    }
    recs.push({
      type: 'event_msg',
      timestamp: p.endTs,
      payload: { type: 'task_complete', started_at: 0, completed_at: p.durationS },
    });
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function codexFixture(childTs: string): { home: string; parentPath: string } {
  const home = tmpDir('codexhome');
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '03');
  const parentId = '01a00000-0000-7000-0000-000000000001';
  const childId = '01a00000-0000-7000-0000-000000000002';
  codexRollout(path.join(dir, `rollout-2026-09-03T10-00-00-${parentId}.jsonl`), {
    id: parentId,
    ts: '2026-09-03T10:00:00.000Z',
    prompts: [
      {
        text: 'parent turn',
        ts: '2026-09-03T10:00:00.000Z',
        endTs: '2026-09-03T10:05:00.000Z',
        durationS: 300,
      },
    ],
    totals: [
      {
        input_tokens: 5000,
        cached_input_tokens: 4000,
        cache_write_input_tokens: 0,
        output_tokens: 500,
        reasoning_output_tokens: 50,
      },
    ],
  });
  codexRollout(path.join(dir, `rollout-2026-09-03T10-01-00-${childId}.jsonl`), {
    id: childId,
    parentId,
    ts: childTs,
    prompts: [{ text: 'child work', ts: childTs, endTs: childTs, durationS: 10 }],
    totals: [
      {
        input_tokens: 700,
        cached_input_tokens: 600,
        cache_write_input_tokens: 0,
        output_tokens: 70,
        reasoning_output_tokens: 7,
      },
    ],
  });
  return { home, parentPath: path.join(dir, `rollout-2026-09-03T10-00-00-${parentId}.jsonl`) };
}

test('codex: a child whose start falls inside a turn window is linked by time', () => {
  const fx = codexFixture('2026-09-03T10:01:00.000Z');
  const session = codex.parse(fx.parentPath);
  const result = codex.children(session, { home: fx.home });
  expect(result.children.length).toBe(1);
  expect(result.children[0]?.linkage).toBe('time');
  expect(result.children[0]?.spawnedByTurnId).toBe(session.turns[0]?.fullId);
});

test('codex: a child that starts outside every window is unattributed, never assigned to the nearest turn', () => {
  const fx = codexFixture('2026-09-03T23:59:00.000Z');
  const session = codex.parse(fx.parentPath);
  const result = codex.children(session, { home: fx.home });
  expect(result.children.length).toBe(1);
  expect(result.children[0]?.linkage).toBe('none');
  expect(result.children[0]?.spawnedByTurnId).toBeNull();
});

test("codex: a child's usage is its own whole-session total, not folded into the parent", () => {
  const fx = codexFixture('2026-09-03T10:01:00.000Z');
  const session = codex.parse(fx.parentPath);
  const result = codex.children(session, { home: fx.home });
  const child = result.children[0];
  expect(child?.usage.output).toBe(70);
  expect(child?.usage.thinking).toBe(7);
  // The parent turn's own tokens are unaffected by the child's existence.
  expect(session.turns[0]?.outputTokens).toBe(500);
});
