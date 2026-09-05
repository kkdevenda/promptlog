import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { slug } from '../src/agents/claude/locate';
import { Turn } from '../src/core/model';
import * as sessionRecords from '../src/core/sessionRecords';
import * as store from '../src/core/store';

const BIN = path.join(__dirname, '..', 'bin', 'promptlog.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'claude', 'branch.jsonl');

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

test('default (no subcommand) renders a tree', () => {
  const r = run(['--session', FIXTURE]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('session');
  expect(r.stdout).toContain('first prompt');
});

test('last: prints the most recent non-command prompt', () => {
  const r = run(['--session', FIXTURE, 'last']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('fourth prompt on new branch');
});

test('last 2: prints the second most recent prompt', () => {
  const r = run(['--session', FIXTURE, 'last', '2']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('second prompt, take two');
});

test('last all: prints every prompt oldest-first, numbered', () => {
  const r = run(['--session', FIXTURE, 'last', 'all']);
  expect(r.status).toBe(0);
  expect(r.stdout.startsWith('--- 1 ---')).toBe(true);
  expect(r.stdout).toContain('first prompt');
  expect(r.stdout).toContain('fourth prompt on new branch');
});

/** A spawn env with no live-session hints and HOME pointed at `home`, so the
 * CLI can only see what the test put there. */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    PROMPTLOG_NO_UPDATE_CHECK: '1',
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  return env;
}

describe('sessions', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  test('lists exactly the transcripts recorded for cwd under HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sess-home-'));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sess-cwd-')));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    const sessionId = '0f0f0f0f-1111-4222-8333-444455556666';
    const dir = path.join(home, '.claude', 'projects', slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${sessionId}.jsonl`);
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd,
        timestamp: '2026-09-02T10:01:00Z',
        message: { role: 'user', content: 'hermetic prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: false,
        sessionId,
        cwd,
        timestamp: '2026-09-02T10:02:00Z',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ];
    fs.writeFileSync(transcript, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const opts = { cwd, env: hermeticEnv(home) };
    const r = run(['sessions'], opts);
    expect(r.status).toBe(0);
    const rows = r.stdout.split('\n').filter(Boolean);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain(sessionId.slice(0, 8));
    expect(rows[0]).toContain('1 prompts');
    expect(rows[0]).toContain(transcript);

    const rj = run(['sessions', '--json'], opts);
    expect(rj.status).toBe(0);
    const data = JSON.parse(rj.stdout);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].id).toBe(sessionId);
    expect(data[0].prompts).toBe(1);
    expect(data[0].path).toBe(transcript);
    expect(data[0].agent).toBe('claude');
  });

  /** Write a Claude transcript for `cwd` under `home`; returns its path. */
  function writeClaudeTranscript(home: string, cwd: string, sessionId: string, startedIso: string): string {
    const dir = path.join(home, '.claude', 'projects', slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${sessionId}.jsonl`);
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
        sessionId,
        cwd,
        timestamp: startedIso,
        message: { role: 'user', content: 'claude prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        isSidechain: false,
        sessionId,
        cwd,
        timestamp: startedIso,
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'm',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 10,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ];
    fs.writeFileSync(transcript, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return transcript;
  }

  /** Write a Codex rollout for `cwd` under `home` (the layout
   * src/agents/codex/locate.ts walks: ~/.codex/sessions/**\/rollout-*.jsonl,
   * first line `session_meta`). */
  function writeCodexRollout(home: string, cwd: string, threadId: string, startedIso: string): string {
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '02');
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-09-02T10-00-00-${threadId}.jsonl`);
    const records = [
      { type: 'session_meta', payload: { id: threadId, cwd, timestamp: startedIso } },
      { timestamp: startedIso, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        timestamp: startedIso,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'codex prompt' },
      },
      { timestamp: startedIso, type: 'event_msg', payload: { type: 'agent_message', message: 'ok, done' } },
      {
        timestamp: startedIso,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50,
              reasoning_output_tokens: 5,
              total_tokens: 150,
            },
          },
        },
      },
      {
        timestamp: startedIso,
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 't1', started_at: 1000, completed_at: 1005 },
      },
    ];
    fs.writeFileSync(rollout, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return rollout;
  }

  test('aggregates every agent for the project; --agent narrows to one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sess-home-'));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sess-cwd-')));
    cleanups.push(() => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    });

    const claudeId = '0f0f0f0f-1111-4222-8333-444455556666';
    const codexId = 'c0dec0de-2222-4333-8444-555566667777';
    // Codex is the newer session, so it must come first regardless of adapter order.
    const claudePath = writeClaudeTranscript(home, cwd, claudeId, '2026-09-02T10:01:00Z');
    const codexPath = writeCodexRollout(home, cwd, codexId, '2026-09-02T11:01:00Z');

    const opts = { cwd, env: hermeticEnv(home) };
    const r = run(['sessions'], opts);
    expect(r.status).toBe(0);
    const rows = r.stdout.split('\n').filter(Boolean);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain(codexId.slice(0, 8));
    expect(rows[0]).toContain('  codex  ');
    expect(rows[0]).toContain(codexPath);
    expect(rows[1]).toContain(claudeId.slice(0, 8));
    expect(rows[1]).toContain('  claude  ');
    expect(rows[1]).toContain(claudePath);

    const rj = run(['sessions', '--json'], opts);
    expect(rj.status).toBe(0);
    const data = JSON.parse(rj.stdout);
    expect(data.map((s: { agent: string }) => s.agent)).toEqual(['codex', 'claude']);
    expect(data.map((s: { id: string }) => s.id)).toEqual([codexId, claudeId]);

    const one = run(['sessions', '--json', '--agent', 'claude'], opts);
    expect(one.status).toBe(0);
    const only = JSON.parse(one.stdout);
    expect(only.length).toBe(1);
    expect(only[0].agent).toBe('claude');
    expect(only[0].path).toBe(claudePath);

    const none = run(['sessions', '--agent', 'cursor'], opts);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/no sessions found/);
  });
});

test('--help: --agent choices come from the registry; --format auto is ASCII', () => {
  const r = run(['--help']);
  expect(r.status).toBe(0);
  const agentLine = r.stdout.split('\n').find((l) => l.trim().startsWith('--agent'));
  expect(agentLine).toBeTruthy();
  for (const id of ['claude', 'codex', 'cursor', 'auto']) expect(agentLine).toContain(id);
  expect(r.stdout).not.toContain('detected UI');
  expect(r.stdout).toMatch(/--format auto\|ascii\|mermaid .*ASCII/);
});

test('show/grep/files fall back to the repo store when no live transcript exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-repo-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-repo-')));
  try {
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.promptlog', 'sessions'), { recursive: true });

    const sessionId = 'c86e0429-3e3b-4f17-8262-35a6f0c85599';
    const gid = 'claude:c86e0429:5043cd5';
    const t = new Turn({
      id: '5043cd5',
      fullId: '5043cd5a-bbbb-cccc-dddd-eeeeeeeeeeee',
      parentId: null,
      agent: 'claude',
      sessionId,
      tsMicros: 1788000000 * 1000000,
      prompt: 'archived prompt about the repo store',
      response: 'done',
      responsePending: false,
      isCommand: false,
    });
    t.durationS = 12;
    t.outputTokens = 10;
    t.inputTokens = 2;
    t.toolCalls = 1;
    t.toolNames = new Map([['Edit', 1]]);
    t.files = new Set(['lib/store.js']);
    t.models = new Set(['m']);
    sessionRecords.upsertSession(repo, {
      agent: 'claude',
      sessionId,
      cwd: repo,
      started: '2026-09-02T10:19:46.683Z',
      originPath: path.join(home, '.claude', 'projects', 'x', `${sessionId}.jsonl`),
      config: store.DEFAULT_CONFIG,
      turns: [t],
    });

    const opts = { cwd: repo, env: hermeticEnv(home) };
    for (const args of [
      ['show', gid],
      ['grep', 'archived'],
      ['files', 'lib/store.js'],
    ]) {
      const r = run(args, opts);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('archived prompt about the repo store');
      expect(r.stderr).toContain('no live transcript; searching the repo only');
    }

    // Everything else still needs a transcript.
    const rt = run(['tree'], opts);
    expect(rt.status).toBe(1);
    expect(rt.stderr).toContain('no session found');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('mermaid: prints a fenced gitGraph', () => {
  const r = run(['--session', FIXTURE, 'mermaid']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('```mermaid');
  expect(r.stdout).toContain('gitGraph LR:');
});

test('fragment -: writes the fragment to stdout', () => {
  const r = run(['--session', FIXTURE, 'fragment', '-']);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('<div id="promptlog-');
  expect(/<!doctype/i.test(r.stdout)).toBe(false);
});

test('json: every turn carries a gid', () => {
  const r = run(['--session', FIXTURE, 'json']);
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout);
  expect(Array.isArray(data.turns) && data.turns.length > 0).toBe(true);
  for (const t of data.turns) {
    expect(typeof t.gid).toBe('string');
    expect(t.gid).toContain(':');
  }
});

test('env --json: has the documented keys', () => {
  const r = run(['--session', FIXTURE, 'env', '--json']);
  expect(r.status).toBe(0);
  const data = JSON.parse(r.stdout);
  for (const key of ['agent', 'session', 'how', 'transcript', 'repoRoot', 'enabled', 'hooksInstalled']) {
    expect(Object.hasOwn(data, key)).toBe(true);
  }
  expect(data.agent).toBe('claude');
});

test('--help lists every subcommand from DESIGN.md', () => {
  const r = run(['--help']);
  expect(r.status).toBe(0);
  const subcommands = [
    'tree',
    'last',
    'show',
    'grep',
    'files',
    'sessions',
    'mermaid',
    'html',
    'fragment',
    'json',
    'env',
    'init',
    'enable',
    'disable',
    'sync',
    'trailers',
    'reindex',
    'review',
    'hook',
  ];
  for (const cmd of subcommands) {
    expect(new RegExp(`(^|\\s)${cmd}(\\s|$)`, 'm').test(r.stdout)).toBe(true);
  }
});

test('unknown subcommand exits 2', () => {
  const r = run(['--session', FIXTURE, 'bogus']);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('unrecognized subcommand');
});

test('review is a read-only preview: it never creates .promptlog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ro-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const r = spawnSync(process.execPath, [BIN, 'review', '--no-color'], { cwd: dir, encoding: 'utf-8' });
    expect(fs.existsSync(path.join(dir, '.promptlog'))).toBe(false);
    expect(r.status).not.toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
