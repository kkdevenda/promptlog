/**
 * Subagent usage (DESIGN.md "Subagent usage").
 *
 * The two rules this file exists to prove, as equalities rather than as
 * plausible-looking output:
 *
 *   CONSERVATION  sum over turns of (own + subagents) + subagentsUnattributed
 *                 == deduped usage over EVERY transcript of the session.
 *   ONCE          sum of turn.subagents.count + subagentsUnattributed.count
 *                 == the number of subagent transcripts.
 *
 * Both are asserted field by field, on a synthetic session shaped like the
 * real thing: two top-level agents, one nested grandchild, one background
 * agent linked only by a task notification, a message id duplicated across
 * two files, and a decoy copy under `tasks/` that must never be read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { claude } from '../src/agents/claude';
import { codex } from '../src/agents/codex';
import { cursor } from '../src/agents/cursor';
import { zeroSubagents } from '../src/core/model';
import { renderStatus, statusStats } from '../src/core/renderStatus';
import { renderLast, renderTree } from '../src/core/renderTree';
import { attachSubagents, totalsWithSubagents } from '../src/core/subagents';
import { tmpDir as sharedTmpDir } from './helpers';

const FIELDS = ['output', 'input', 'cacheRead', 'cacheWrite', 'thinking'] as const;

function tmpdir(name: string): string {
  return sharedTmpDir(`promptlog-${name}-`);
}

interface Usage {
  output_tokens: number;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens_details: { thinking_tokens: number };
}

function usage(
  output: number,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  thinking: number,
): Usage {
  return {
    output_tokens: output,
    input_tokens: input,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens_details: { thinking_tokens: thinking },
  };
}

/** An assistant record with usage, and optionally a tool_use block. */
function assistant({
  uuid,
  parentUuid,
  sessionId,
  msgId,
  u,
  toolUse = null,
  sidechain = false,
  agentId = null,
  ts,
}: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  msgId: string;
  u: Usage;
  toolUse?: { id: string; name: string } | null;
  sidechain?: boolean;
  agentId?: string | null;
  ts: string;
}): Record<string, unknown> {
  const content: unknown[] = [{ type: 'text', text: 'ok' }];
  if (toolUse) content.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} });
  const rec: Record<string, unknown> = {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId,
    timestamp: ts,
    message: { id: msgId, model: 'test-model', role: 'assistant', content, usage: u },
  };
  if (sidechain) rec.isSidechain = true;
  if (agentId) rec.agentId = agentId;
  return rec;
}

function prompt({
  uuid,
  parentUuid,
  sessionId,
  text,
  ts,
}: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  text: string;
  ts: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId,
    cwd: '/repo',
    timestamp: ts,
    message: { role: 'user', content: text },
  };
}

function toolResult({
  uuid,
  parentUuid,
  sessionId,
  toolUseId,
  text,
  ts,
}: {
  uuid: string;
  parentUuid: string;
  sessionId: string;
  toolUseId: string;
  text: string;
  ts: string;
}): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId,
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }],
    },
  };
}

function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

interface UsageTotals {
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

interface Fixture {
  home: string;
  main: string;
  sid: string;
  subDir: string;
  files: number;
  expectedAll: UsageTotals;
  duplicates: number;
}

/**
 * Build the fixture session on disk and return everything a test needs.
 *
 * Shape:
 *   turn1 -> Agent(toolu_a) -> agent-AAA           (top level)
 *         -> Agent(toolu_b) -> agent-BBB           (top level)
 *                              agent-BBB spawns Agent(toolu_c) -> agent-CCC (nested)
 *   turn2 -> background Agent, linked ONLY by a <task-notification> record
 *                              -> agent-DDD
 */
function buildFixture({
  withSubagents = true,
  emptyDir = false,
}: {
  withSubagents?: boolean;
  emptyDir?: boolean;
} = {}): Fixture {
  const home = tmpdir('home');
  const slug = path.join(home, '.claude', 'projects', '-repo');
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const main = path.join(slug, `${sid}.jsonl`);
  const T = (n: number) => `2026-09-03T10:${String(n).padStart(2, '0')}:00.000Z`;

  writeJsonl(main, [
    prompt({ uuid: 'u-1', parentUuid: null, sessionId: sid, text: 'first prompt', ts: T(0) }),
    assistant({
      uuid: 'a-1',
      parentUuid: 'u-1',
      sessionId: sid,
      msgId: 'msg-main-1',
      u: usage(100, 1, 1000, 10, 5),
      toolUse: { id: 'toolu_a', name: 'Agent' },
      ts: T(1),
    }),
    toolResult({
      uuid: 'r-1',
      parentUuid: 'a-1',
      sessionId: sid,
      toolUseId: 'toolu_a',
      text: 'Agent finished\nagentId: AAA\n',
      ts: T(2),
    }),
    assistant({
      uuid: 'a-2',
      parentUuid: 'r-1',
      sessionId: sid,
      msgId: 'msg-main-2',
      u: usage(200, 2, 2000, 20, 6),
      toolUse: { id: 'toolu_b', name: 'Agent' },
      ts: T(3),
    }),
    toolResult({
      uuid: 'r-2',
      parentUuid: 'a-2',
      sessionId: sid,
      toolUseId: 'toolu_b',
      text: 'agentId: BBB',
      ts: T(4),
    }),
    prompt({ uuid: 'u-2', parentUuid: 'r-2', sessionId: sid, text: 'second prompt', ts: T(5) }),
    assistant({
      uuid: 'a-3',
      parentUuid: 'u-2',
      sessionId: sid,
      msgId: 'msg-main-3',
      u: usage(300, 3, 3000, 30, 7),
      toolUse: { id: 'toolu_d', name: 'Agent' },
      ts: T(6),
    }),
    // A background agent: no tool_result text, only a queue-operation record
    // carrying both ids. This is the only link that exists for it.
    {
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: sid,
      timestamp: T(7),
      content:
        '<task-notification>\n<task-id>DDD</task-id>\n<tool-use-id>toolu_d</tool-use-id>\n</task-notification>',
    },
  ]);

  const subDir = path.join(slug, sid, 'subagents');
  if (emptyDir) fs.mkdirSync(subDir, { recursive: true });

  const expected = { output: 600, input: 6, cacheRead: 6000, cacheWrite: 60, thinking: 18 };
  if (!withSubagents) return { home, main, sid, subDir, files: 0, expectedAll: expected, duplicates: 0 };

  const kid = (agentId: string, msgs: Array<[string, Usage]>, toolUse?: { id: string; name: string }) => {
    const recs: unknown[] = [];
    let i = 0;
    for (const [msgId, u] of msgs) {
      recs.push(
        assistant({
          uuid: `${agentId}-${i}`,
          parentUuid: i ? `${agentId}-${i - 1}` : null,
          sessionId: sid,
          msgId,
          u,
          sidechain: true,
          agentId,
          toolUse: i === 0 ? (toolUse ?? null) : null,
          ts: T(10 + i),
        }),
      );
      i += 1;
    }
    writeJsonl(path.join(subDir, `agent-${agentId}.jsonl`), recs);
  };

  kid('AAA', [
    ['msg-aaa-1', usage(10, 1, 100, 1, 2)],
    ['msg-aaa-2', usage(11, 1, 110, 1, 2)],
  ]);
  // BBB spawns CCC with tool_use toolu_c, and its meta names the tool call in
  // the MAIN chain that created BBB.
  kid('BBB', [['msg-bbb-1', usage(20, 2, 200, 2, 3)]], { id: 'toolu_c', name: 'Agent' });
  // CCC is the grandchild. `msg-aaa-2` is deliberately repeated here: the same
  // message id in two files must be counted exactly once.
  kid('CCC', [
    ['msg-ccc-1', usage(30, 3, 300, 3, 4)],
    ['msg-aaa-2', usage(11, 1, 110, 1, 2)],
  ]);
  kid('DDD', [['msg-ddd-1', usage(40, 4, 400, 4, 5)]]);

  fs.writeFileSync(
    path.join(subDir, 'agent-AAA.meta.json'),
    JSON.stringify({ toolUseId: 'toolu_a', spawnDepth: 1 }),
  );
  fs.writeFileSync(
    path.join(subDir, 'agent-BBB.meta.json'),
    JSON.stringify({ toolUseId: 'toolu_b', spawnDepth: 1 }),
  );
  fs.writeFileSync(
    path.join(subDir, 'agent-CCC.meta.json'),
    JSON.stringify({ toolUseId: 'toolu_c', parentAgentId: 'BBB', spawnDepth: 2 }),
  );
  // DDD has NO meta sidecar: it must be linked by the task notification alone.

  // A decoy: Claude Code leaves copies of subagent transcripts under a task
  // scratch directory. Reading it would count agent AAA twice.
  const decoyDir = path.join(slug, sid, 'tasks', 'whatever');
  writeJsonl(path.join(decoyDir, 'agent-AAA.jsonl'), [
    assistant({
      uuid: 'x-0',
      parentUuid: null,
      sessionId: sid,
      msgId: 'msg-decoy',
      u: usage(9999, 9999, 9999, 9999, 9999),
      sidechain: true,
      agentId: 'AAA',
      ts: T(20),
    }),
  ]);

  // Deduped over every real transcript: main + AAA + BBB + CCC + DDD, with
  // msg-aaa-2 counted once.
  const expectedAll = {
    output: 600 + 10 + 11 + 20 + 30 + 40,
    input: 6 + 1 + 1 + 2 + 3 + 4,
    cacheRead: 6000 + 100 + 110 + 200 + 300 + 400,
    cacheWrite: 60 + 1 + 1 + 2 + 3 + 4,
    thinking: 18 + 2 + 2 + 3 + 4 + 5,
  };
  return { home, main, sid, subDir, files: 4, expectedAll, duplicates: 1 };
}

function sumOwnPlusSubagents(session: ReturnType<typeof claude.parse>): Record<string, number> {
  const acc = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const add = (b: {
    output: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    thinking: number;
  }) => {
    acc.output += b.output;
    acc.input += b.input;
    acc.cacheRead += b.cacheRead;
    acc.cacheWrite += b.cacheWrite;
    acc.thinking += b.thinking;
  };
  for (const t of session.turns) {
    add({
      output: t.outputTokens,
      input: t.inputTokens,
      cacheRead: t.cacheReadTokens,
      cacheWrite: t.cacheWriteTokens,
      thinking: t.thinkingTokens,
    });
    add(t.subagents);
  }
  add(session.subagentsUnattributed);
  return acc;
}

describe('subagents', () => {
  test('CONSERVATION - own + subagents + unattributed equals the deduped usage of every transcript', () => {
    const fx = buildFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const got = sumOwnPlusSubagents(session);
    for (const f of FIELDS) {
      expect(got[f], `field ${f}: got ${got[f]}, expected ${fx.expectedAll[f]}`).toBe(fx.expectedAll[f]);
    }
  });

  test('ONCE - every transcript is counted under exactly one turn (or the session bucket)', () => {
    const fx = buildFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const counted =
      session.turns.reduce((s, t) => s + t.subagents.count, 0) + session.subagentsUnattributed.count;
    expect(session.subagentFiles).toBe(fx.files);
    expect(counted).toBe(fx.files);
  });

  test('a message id repeated across two files is counted once, and reported', () => {
    const fx = buildFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    expect(session.subagentDuplicateIds).toBe(fx.duplicates);
    // Conservation already pins the arithmetic; this pins the report. The
    // headline "output" is output + thinking (DESIGN.md "Subagent usage").
    const total = totalsWithSubagents(session.turns, session.subagentsUnattributed);
    expect(total.total.output).toBe(fx.expectedAll.output + fx.expectedAll.thinking);
  });

  test('copies under a tasks/ directory are never read', () => {
    const fx = buildFixture();
    const result = claude.children(claude.parse(fx.main), { home: fx.home });
    expect(result.children.length).toBe(fx.files);
    for (const c of result.children) {
      expect(c.path.includes(`${path.sep}tasks${path.sep}`), `read a tasks/ copy: ${c.path}`).toBe(false);
      expect(c.path.includes(`${path.sep}subagents${path.sep}`), `read outside subagents/: ${c.path}`).toBe(
        true,
      );
    }
    // The decoy's 9999s would be impossible to miss in the totals.
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    expect(sumOwnPlusSubagents(session).output).toBe(fx.expectedAll.output);
  });

  test('linkage is exact for top-level, nested and background agents alike', () => {
    const fx = buildFixture();
    const session = claude.parse(fx.main);
    const byAgent = new Map(claude.children(session, { home: fx.home }).children.map((c) => [c.agentId, c]));
    const gid1 = session.turns[0]?.gid;
    const gid2 = session.turns[1]?.gid;

    expect(byAgent.get('AAA')?.linkage).toBe('exact');
    expect(byAgent.get('AAA')?.spawnedByTurnGid).toBe(gid1);
    expect(byAgent.get('BBB')?.spawnedByTurnGid).toBe(gid1);
    // The grandchild lands on the SAME top-level turn as its parent chain.
    expect(byAgent.get('CCC')?.linkage).toBe('exact');
    expect(byAgent.get('CCC')?.spawnedByTurnGid).toBe(gid1);
    expect(byAgent.get('CCC')?.parentAgentId).toBe('BBB');
    // Linked only by the <task-notification> record, with no meta sidecar.
    expect(byAgent.get('DDD')?.linkage).toBe('exact');
    expect(byAgent.get('DDD')?.spawnedByTurnGid).toBe(gid2);
  });

  test('no subagents directory -> all zero, no error; an empty one -> the same', () => {
    for (const opts of [{ withSubagents: false }, { withSubagents: false, emptyDir: true }]) {
      const fx = buildFixture(opts);
      const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
      expect(session.subagentFiles).toBe(0);
      expect(session.subagentsUnattributed).toEqual(zeroSubagents());
      for (const t of session.turns) expect(t.subagents).toEqual(zeroSubagents());
      const got = sumOwnPlusSubagents(session);
      for (const f of FIELDS) expect(got[f]).toBe(fx.expectedAll[f]);
    }
  });

  test("a turn's own token fields are never touched", () => {
    const fx = buildFixture();
    const plain = claude.parse(fx.main);
    const withKids = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    for (let i = 0; i < plain.turns.length; i++) {
      const plainTurn = plain.turns[i];
      const kidTurn = withKids.turns[i];
      if (!plainTurn || !kidTurn) throw new Error('turn missing');
      for (const f of [
        'outputTokens',
        'inputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'thinkingTokens',
      ] as const) {
        expect(kidTurn[f], `turn ${i}.${f} changed`).toBe(plainTurn[f]);
      }
      expect(kidTurn.subagents.count > 0 || kidTurn.subagents.output === 0).toBe(true);
    }
  });

  test('toJSON carries the per-turn block and the session fields', () => {
    const fx = buildFixture();
    const json = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude }).toJSON();
    expect(json.subagent_files).toBe(fx.files);
    expect(json.subagent_duplicate_ids).toBe(fx.duplicates);
    expect(Object.keys(json.subagents_unattributed).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'count',
      'input',
      'linkage',
      'output',
      'thinking',
    ]);
    expect(json.turns[0]?.subagents.count).toBe(3);
    expect(json.turns[0]?.subagents.linkage).toBe('exact');
    expect(json.turns[1]?.subagents.count).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Accounting defects reproduced as fixtures (each was a real bug)
  // --------------------------------------------------------------------------

  /**
   * A child's assistant message ALSO written into the main transcript, flagged
   * `isSidechain: true`, with the same message.id. The parser counts sidechain
   * records in no turn; the dedup seed must apply the same rule, or the
   * child's tokens are marked duplicate and vanish from every total.
   */
  function buildSidechainEchoFixture(): { home: string; main: string; expectedAll: UsageTotals } {
    const home = tmpdir('echo');
    const slug = path.join(home, '.claude', 'projects', '-repo');
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const main = path.join(slug, `${sid}.jsonl`);
    const T = (n: number) => `2026-09-03T10:${String(n).padStart(2, '0')}:00.000Z`;
    writeJsonl(main, [
      prompt({ uuid: 'u-1', parentUuid: null, sessionId: sid, text: 'first prompt', ts: T(0) }),
      assistant({
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: sid,
        msgId: 'msg-main-1',
        u: usage(3, 1, 10, 1, 0),
        toolUse: { id: 'toolu_a', name: 'Agent' },
        ts: T(1),
      }),
      // The echo: the child's message, in the main file, as a sidechain record.
      assistant({
        uuid: 'AAA-0-echo',
        parentUuid: null,
        sessionId: sid,
        msgId: 'msg-aaa-1',
        u: usage(17, 2, 20, 2, 1),
        sidechain: true,
        agentId: 'AAA',
        ts: T(2),
      }),
      toolResult({
        uuid: 'r-1',
        parentUuid: 'a-1',
        sessionId: sid,
        toolUseId: 'toolu_a',
        text: 'agentId: AAA',
        ts: T(3),
      }),
    ]);
    const subDir = path.join(slug, sid, 'subagents');
    writeJsonl(path.join(subDir, 'agent-AAA.jsonl'), [
      assistant({
        uuid: 'AAA-0',
        parentUuid: null,
        sessionId: sid,
        msgId: 'msg-aaa-1',
        u: usage(17, 2, 20, 2, 1),
        sidechain: true,
        agentId: 'AAA',
        ts: T(2),
      }),
    ]);
    fs.writeFileSync(
      path.join(subDir, 'agent-AAA.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_a', spawnDepth: 1 }),
    );
    // Deduped over main (parser rule: sidechain dropped) + the child.
    const expectedAll = {
      output: 3 + 17,
      input: 1 + 2,
      cacheRead: 10 + 20,
      cacheWrite: 1 + 2,
      thinking: 0 + 1,
    };
    return { home, main, expectedAll };
  }

  test('a child message echoed into the main chain as isSidechain is counted once, on the child, not dropped', () => {
    const fx = buildSidechainEchoFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    // The parser never counted the echo in the turn's own fields.
    expect(session.turns[0]?.outputTokens).toBe(3);
    // The 17 land on the spawning turn's subagent block...
    expect(session.turns[0]?.subagents.count).toBe(1);
    expect(session.turns[0]?.subagents.output).toBe(17);
    // ...and are not reported as a duplicate: nothing else counted them.
    expect(session.subagentDuplicateIds).toBe(0);
    const got = sumOwnPlusSubagents(session);
    for (const f of FIELDS)
      expect(got[f], `field ${f}: got ${got[f]}, expected ${fx.expectedAll[f]}`).toBe(fx.expectedAll[f]);
  });

  /**
   * Two top-level prompts whose uuids share the first 7 characters. Turn ids
   * are that prefix, so both turns have the SAME gid; only fullId tells them
   * apart. A child owned by the first (via its meta toolUseId) must land on
   * the first.
   */
  function buildGidCollisionFixture(): { home: string; main: string; u1: string; u2: string } {
    const home = tmpdir('collide');
    const slug = path.join(home, '.claude', 'projects', '-repo');
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const main = path.join(slug, `${sid}.jsonl`);
    const T = (n: number) => `2026-09-03T10:${String(n).padStart(2, '0')}:00.000Z`;
    const u1 = 'abcdefg1-0000-4000-8000-000000000001';
    const u2 = 'abcdefg2-0000-4000-8000-000000000002';
    writeJsonl(main, [
      prompt({ uuid: u1, parentUuid: null, sessionId: sid, text: 'first prompt', ts: T(0) }),
      assistant({
        uuid: 'a-1',
        parentUuid: u1,
        sessionId: sid,
        msgId: 'msg-main-1',
        u: usage(100, 1, 0, 0, 0),
        toolUse: { id: 'toolu_a', name: 'Agent' },
        ts: T(1),
      }),
      toolResult({
        uuid: 'r-1',
        parentUuid: 'a-1',
        sessionId: sid,
        toolUseId: 'toolu_a',
        text: 'agentId: AAA',
        ts: T(2),
      }),
      prompt({ uuid: u2, parentUuid: 'r-1', sessionId: sid, text: 'second prompt', ts: T(5) }),
      assistant({
        uuid: 'a-2',
        parentUuid: u2,
        sessionId: sid,
        msgId: 'msg-main-2',
        u: usage(200, 2, 0, 0, 0),
        ts: T(6),
      }),
    ]);
    const subDir = path.join(slug, sid, 'subagents');
    writeJsonl(path.join(subDir, 'agent-AAA.jsonl'), [
      assistant({
        uuid: 'AAA-0',
        parentUuid: null,
        sessionId: sid,
        msgId: 'msg-aaa-1',
        u: usage(10, 1, 0, 0, 0),
        sidechain: true,
        agentId: 'AAA',
        ts: T(3),
      }),
    ]);
    fs.writeFileSync(
      path.join(subDir, 'agent-AAA.meta.json'),
      JSON.stringify({ toolUseId: 'toolu_a', spawnDepth: 1 }),
    );
    return { home, main, u1, u2 };
  }

  test('two turns with the same 7-char id prefix - the child attaches to its exact owner, not the later gid', () => {
    const fx = buildGidCollisionFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    expect(session.turns.length).toBe(2);
    expect(session.turns[0]?.fullId).toBe(fx.u1);
    expect(session.turns[1]?.fullId).toBe(fx.u2);
    // The collision is real: same gid, different fullId.
    expect(session.turns[0]?.gid).toBe(session.turns[1]?.gid);
    expect(session.turns[0]?.subagents.count).toBe(1);
    expect(session.turns[0]?.subagents.output).toBe(10);
    expect(session.turns[1]?.subagents.count).toBe(0);
    expect(session.subagentsUnattributed.count).toBe(0);
    // The adapter says so explicitly, by fullId.
    const kid = claude.children(claude.parse(fx.main), { home: fx.home }).children[0];
    expect(kid?.spawnedByTurnId).toBe(fx.u1);
    expect(kid?.spawnedByTurnGid).toBe(session.turns[0]?.gid);
  });

  test('a legacy adapter giving only spawnedByTurnGid is honoured when the gid is unique, unattributed when it collides', () => {
    const fx = buildGidCollisionFixture();
    const usage0 = { output: 5, input: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 };
    const legacy = (gid: string | null) => ({
      ...claude,
      children: () => ({
        children: [
          {
            path: '/x/agent-Z.jsonl',
            agentId: 'Z',
            parentAgentId: null,
            spawnedByTurnId: null,
            spawnedByTurnGid: gid,
            linkage: 'exact' as const,
            usage: usage0,
          },
        ],
        duplicates: 0,
      }),
    });
    // Colliding gid: two turns share it, so the child must go to the bucket.
    const collided = claude.parse(fx.main);
    attachSubagents(collided, { home: fx.home, adapter: legacy(collided.turns[0]?.gid ?? null) });
    expect(collided.turns[0]?.subagents.count).toBe(0);
    expect(collided.turns[1]?.subagents.count).toBe(0);
    expect(collided.subagentsUnattributed.count).toBe(1);
    expect(collided.subagentFiles).toBe(1);
    // Unique gid (the main fixture): the legacy field still works.
    const plain = buildFixture({ withSubagents: false });
    const unique = claude.parse(plain.main);
    attachSubagents(unique, { home: plain.home, adapter: legacy(unique.turns[1]?.gid ?? null) });
    expect(unique.turns[1]?.subagents.count).toBe(1);
    expect(unique.turns[1]?.subagents.output).toBe(5);
    expect(unique.subagentsUnattributed.count).toBe(0);
  });

  test('attachSubagents is idempotent - calling it twice equals calling it once', () => {
    const fx = buildFixture();
    const once = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const twice = claude.parse(fx.main);
    attachSubagents(twice, { home: fx.home, adapter: claude });
    attachSubagents(twice, { home: fx.home, adapter: claude });
    expect(twice.toJSON()).toEqual(once.toJSON());
    expect(twice.subagentFiles).toBe(fx.files);
    expect(twice.subagentDuplicateIds).toBe(fx.duplicates);
    for (let i = 0; i < once.turns.length; i++)
      expect(twice.turns[i]?.subagents).toEqual(once.turns[i]?.subagents);
    expect(twice.subagentsUnattributed).toEqual(once.subagentsUnattributed);
  });

  test("contract - every adapter's children carry spawnedByTurnId (fullId or null) with a matching display gid", () => {
    const check = (
      children: Array<{
        agentId: string;
        spawnedByTurnId: string | null;
        spawnedByTurnGid: string | null;
        linkage: string;
      }>,
      turns: Array<{ fullId: string; gid: string }>,
      label: string,
    ) => {
      const byFullId = new Map(turns.map((t) => [t.fullId, t]));
      for (const c of children) {
        expect('spawnedByTurnId' in c, `${label}: child ${c.agentId} lacks spawnedByTurnId`).toBe(true);
        expect(
          c.spawnedByTurnId === null || typeof c.spawnedByTurnId === 'string',
          `${label}: spawnedByTurnId must be null or a string`,
        ).toBe(true);
        expect(
          c.spawnedByTurnGid === null || typeof c.spawnedByTurnGid === 'string',
          `${label}: spawnedByTurnGid must be null or a string`,
        ).toBe(true);
        if (c.spawnedByTurnId === null) {
          expect(c.spawnedByTurnGid, `${label}: gid without a fullId`).toBe(null);
          expect(c.linkage).toBe('none');
        } else {
          const t = byFullId.get(c.spawnedByTurnId);
          expect(t, `${label}: spawnedByTurnId names no turn of the session`).toBeTruthy();
          expect(c.spawnedByTurnGid, `${label}: display gid disagrees with the linked turn`).toBe(t?.gid);
          expect(c.linkage).not.toBe('none');
        }
      }
    };
    const cf = buildFixture();
    const cs = claude.parse(cf.main);
    const ck = claude.children(cs, { home: cf.home }).children;
    expect(ck.length).toBe(cf.files);
    check(ck, cs.turns, 'claude');

    const xf = codexFixture('2026-09-03T10:01:00.000Z');
    const xs = codex.parse(xf.parentPath);
    const xk = codex.children(xs, { home: xf.home }).children;
    expect(xk.length).toBe(1);
    check(xk, xs.turns, 'codex');

    const home = tmpdir('cursorcontract');
    const dir = path.join(home, '.cursor', 'projects', 'Users-x', 'agent-transcripts', 'sess-1');
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', 'kid-1.jsonl'), '{}\n');
    const uk = cursor.children(
      { path: path.join(dir, 'sess-1.jsonl'), turns: [] } as unknown as ReturnType<typeof cursor.parse>,
      { home },
    ).children;
    expect(uk.length).toBe(1);
    check(uk, [], 'cursor');
  });

  test('a symlink inside subagents/ pointing outside it is never read', () => {
    const fx = buildFixture();
    const before = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const beforeTotals = totalsWithSubagents(before.turns, before.subagentsUnattributed);

    // A transcript OUTSIDE the subagents directory, with unmissable usage, and
    // a symlink to it planted inside. Also a symlink to a sibling real file
    // (same dir): still a symlink, still skipped - the rule is "regular files
    // inside the real directory", not "resolves somewhere plausible".
    const outside = path.join(fx.home, 'elsewhere', 'agent-EVIL.jsonl');
    writeJsonl(outside, [
      assistant({
        uuid: 'e-0',
        parentUuid: null,
        sessionId: fx.sid,
        msgId: 'msg-evil',
        u: usage(77777, 7, 7, 7, 7),
        sidechain: true,
        agentId: 'EVIL',
        ts: '2026-09-03T10:30:00.000Z',
      }),
    ]);
    fs.symlinkSync(outside, path.join(fx.subDir, 'agent-EVIL.jsonl'));
    fs.symlinkSync(path.join(fx.subDir, 'agent-AAA.jsonl'), path.join(fx.subDir, 'agent-ZZZ.jsonl'));

    const result = claude.children(claude.parse(fx.main), { home: fx.home });
    expect(result.children.length, 'symlinked entries are not listed').toBe(fx.files);
    for (const c of result.children) expect(/EVIL|ZZZ/.test(c.path), `read a symlink: ${c.path}`).toBe(false);

    const after = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    expect(after.subagentFiles).toBe(fx.files);
    expect(totalsWithSubagents(after.turns, after.subagentsUnattributed)).toEqual(beforeTotals);
    expect(sumOwnPlusSubagents(after).output).toBe(fx.expectedAll.output);
  });

  // --------------------------------------------------------------------------
  // Codex
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
        payload: {
          id,
          cwd: '/repo',
          timestamp: ts,
          originator: 'codex-tui',
          parent_thread_id: parentId || undefined,
        },
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
    const home = tmpdir('codexhome');
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
          total_tokens: 5500,
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
          total_tokens: 770,
        },
      ],
    });
    return { home, parentPath: path.join(dir, `rollout-2026-09-03T10-00-00-${parentId}.jsonl`) };
  }

  test('codex: a child whose start falls inside a turn window is linked by time', () => {
    const fx = codexFixture('2026-09-03T10:01:00.000Z');
    const session = attachSubagents(codex.parse(fx.parentPath), { home: fx.home, adapter: codex });
    expect(session.subagentFiles).toBe(1);
    expect(session.turns[0]?.subagents.count).toBe(1);
    expect(session.turns[0]?.subagents.linkage).toBe('time');
    expect(session.subagentsUnattributed.count).toBe(0);
  });

  test('codex: a child that starts outside every window is unattributed, never assigned to the nearest turn', () => {
    const fx = codexFixture('2026-09-03T23:59:00.000Z');
    const session = attachSubagents(codex.parse(fx.parentPath), { home: fx.home, adapter: codex });
    expect(session.subagentFiles).toBe(1);
    expect(session.turns[0]?.subagents.count).toBe(0);
    expect(session.subagentsUnattributed.count).toBe(1);
    expect(session.subagentsUnattributed.linkage).toBe(null);
  });

  test("codex: a child's usage is ADDED, because it is not part of the parent's own numbers", () => {
    // The protocol in DESIGN.md "Subagent usage" measured this on real local
    // rollouts: over every turn that spawned a child, the parent's cumulative
    // total_token_usage delta equals the sum of its OWN per-request
    // last_token_usage, so the child appears nowhere in it.
    const fx = codexFixture('2026-09-03T10:01:00.000Z');
    const session = attachSubagents(codex.parse(fx.parentPath), { home: fx.home, adapter: codex });
    const turn = session.turns[0];
    expect(turn?.outputTokens).toBe(500);
    expect(turn?.subagents.output).toBe(70);
    // Headline "output" is output + reasoning (thinking): 500+50 and 70+7.
    const t = totalsWithSubagents(session.turns, session.subagentsUnattributed);
    expect(t.own.output).toBe(550);
    expect(t.sub.output).toBe(77);
    expect(t.total.output).toBe(627);
  });

  // --------------------------------------------------------------------------
  // Renderers
  // --------------------------------------------------------------------------

  test('renderers: header, totals block, status suffix and last line appear only when there are subagents', () => {
    const fx = buildFixture();
    const withKids = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const none = attachSubagents(claude.parse(buildFixture({ withSubagents: false }).main), {
      home: fx.home,
      adapter: claude,
    });
    // `none` was parsed from a different home; make sure it really has none.
    none.subagentFiles = 0;
    for (const t of none.turns) t.subagents = zeroSubagents();
    none.subagentsUnattributed = zeroSubagents();

    const treeWith = renderTree(withKids, { noColor: true, width: 200 });
    const treeNone = renderTree(none, { noColor: true, width: 200 });

    expect(treeWith.split('\n')[0]).toMatch(/\(\+4 agents\)/);
    expect(treeNone.split('\n')[0]).not.toMatch(/agents\)/);

    const withTotals = treeWith.trimEnd().split('\n').slice(-3);
    expect(withTotals[0]).toMatch(/^\s*own\b/);
    expect(withTotals[1]).toMatch(/^\s*subagents \(4\)/);
    expect(withTotals[2]).toMatch(/^\s*total\b/);
    const noneTotals = treeNone.trimEnd().split('\n').slice(-1)[0];
    expect(noneTotals).not.toMatch(/^\s*own\b/);

    // Header total = own + subagents, to the token ("output" = output + thinking).
    const tot = totalsWithSubagents(withKids.turns, withKids.subagentsUnattributed);
    expect(tot.total.output).toBe(fx.expectedAll.output + fx.expectedAll.thinking);

    // Normal mode marks the row; -v spells the numbers out instead.
    expect(treeWith).toMatch(/↓\s*\S+⁺/);
    const verbose = renderTree(withKids, { noColor: true, width: 240, verbose: true });
    expect(verbose).toMatch(/\+3 agents ↑\S+ ↓\S+/);
    expect(verbose.split('\n')[2]).not.toMatch(/⁺/);

    expect(renderStatus(withKids)).toMatch(/· \+4 agents$/);
    expect(renderStatus(none)).not.toMatch(/agents/);

    const stats = statusStats(withKids);
    expect(stats.out).toBe(tot.total.output);
    expect(stats.ownOut).toBe(tot.own.output);
    expect(stats.subagentOut).toBe(tot.sub.output);
    expect(stats.subagents).toBe(4);

    expect(renderLast(withKids, 1, { colorsEnabled: false })).toMatch(/\+1 agents ↑\S+ ↓\S+/);
    expect(renderLast(none, 1, { colorsEnabled: false })).not.toMatch(/agents/);
  });

  test('records: buildRecord carries a subagents block, separate from tokens', async () => {
    const store = await import('../src/core/store');
    const sessionRecords = await import('../src/core/sessionRecords');
    const fx = buildFixture();
    const session = attachSubagents(claude.parse(fx.main), { home: fx.home, adapter: claude });
    const turn = session.turns[0];
    if (!turn) throw new Error('missing turn');
    const rec = sessionRecords.buildRecord(turn, {
      agent: 'claude',
      sessionId: session.id,
      originPath: fx.main,
      config: store.DEFAULT_CONFIG,
    });
    expect(rec.subagents.count).toBe(3);
    expect(rec.subagents.linkage).toBe('exact');
    // AAA 10+11, BBB 20, CCC 30 (its repeat of msg-aaa-2 counted once, under AAA).
    expect(rec.subagents.output).toBe(10 + 11 + 20 + 30);
    // The turn's own tokens are untouched by the block next to them.
    expect(rec.tokens.output).toBe(turn.outputTokens);
  });

  test('cursor: subagent transcripts are listed with zero usage and no arithmetic', () => {
    const home = tmpdir('cursorhome');
    const dir = path.join(home, '.cursor', 'projects', 'Users-x', 'agent-transcripts', 'sess-1');
    fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subagents', 'kid-1.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'subagents', 'kid-2.jsonl'), '{}\n');
    const result = cursor.children(
      { path: path.join(dir, 'sess-1.jsonl'), turns: [] } as unknown as ReturnType<typeof cursor.parse>,
      { home },
    );
    expect(result.children.length).toBe(2);
    for (const c of result.children) {
      expect(c.linkage).toBe('none');
      for (const f of FIELDS) expect(c.usage[f]).toBe(0);
    }
  });
});
