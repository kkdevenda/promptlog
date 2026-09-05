/**
 * ui() adapter contract, `promptlog graph`'s ASCII-always output, `--fenced`
 * framing, mermaid's fenced id list, and Codex skill-invocation records
 * being treated as commands. See docs/DESIGN.md "Agent surfaces" and
 * CHANGELOG.md "Unreleased" for the "one visual layout for every host"
 * decision this backs: `ui()` is real signal (surfaced on `promptlog env`),
 * but `graph --format auto` always renders ASCII regardless of what it
 * reports - Mermaid stays explicit-only.
 *
 * Cases that spawn the built CLI bundle run `node bin/promptlog.js`;
 * `npm run build` runs first.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { agents, byId } from '../src/agents';
import { parseCodexSession, skillCommandName } from '../src/agents/codex/parser';

const REPO = path.resolve(__dirname, '..');
const PROMPTLOG = path.join(REPO, 'bin', 'promptlog.js');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-ui-test-'));
}

/** Creates `dir` and inits a git repo in it, returning its realpath - on
 * macOS $TMPDIR sits under a `/var` -> `/private/var` symlink, and a
 * spawned child process's `process.cwd()` reports the resolved path, which
 * would never match a transcript's recorded (unresolved) `cwd` otherwise. */
function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: real });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: real });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: real });
  return real;
}

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

/** A minimal but real-shaped Codex rollout transcript: session_meta with the
 * given `originator`, plus one ordinary user prompt/response turn (and any
 * extra user_message records appended after it, for the skill-command
 * tests). */
function writeCodexSession(
  home: string,
  {
    cwd,
    sessionId,
    originator,
    extraUserMessages = [],
  }: { cwd: string; sessionId: string; originator: string; extraUserMessages?: string[] },
): string {
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '09', '03');
  const p = path.join(dayDir, `rollout-2026-09-03T00-00-00-${sessionId}.jsonl`);
  const records: unknown[] = [
    { type: 'session_meta', payload: { id: sessionId, cwd, timestamp: '2026-09-03T00:00:00Z', originator } },
    { timestamp: '2026-09-03T00:00:01Z', type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: '2026-09-03T00:00:02Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'a normal prompt' },
    },
    {
      timestamp: '2026-09-03T00:00:03Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'ok' },
    },
    {
      timestamp: '2026-09-03T00:00:04Z',
      type: 'event_msg',
      payload: { type: 'task_complete', started_at: 0, completed_at: 1 },
    },
  ];
  let t = 10;
  for (const msg of extraUserMessages) {
    records.push({
      timestamp: `2026-09-03T00:00:${t}Z`,
      type: 'event_msg',
      payload: { type: 'task_started' },
    });
    records.push({
      timestamp: `2026-09-03T00:00:${t + 1}Z`,
      type: 'event_msg',
      payload: { type: 'user_message', message: msg },
    });
    records.push({
      timestamp: `2026-09-03T00:00:${t + 2}Z`,
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'ok' },
    });
    records.push({
      timestamp: `2026-09-03T00:00:${t + 3}Z`,
      type: 'event_msg',
      payload: { type: 'task_complete', started_at: 0, completed_at: 1 },
    });
    t += 4;
  }
  writeJsonl(p, records);
  return p;
}

function run(args: string[], { cwd, home }: { cwd: string; home: string }) {
  return spawnSync(process.execPath, [PROMPTLOG, ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
      CLAUDE_CODE_ENTRYPOINT: '',
    },
  });
}

// ------------------------------------------------------------- contract

test('contract: ui is a function on every registered adapter', () => {
  for (const adapter of agents()) {
    expect(typeof adapter.ui, `adapter "${adapter.id}".ui is not a function`).toBe('function');
  }
});

// ------------------------------------------------------------- codex ui()

test('codex ui(): originator codex-tui -> terminal; env reports it; graph auto is ASCII', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-tui');
  repoRoot = initRepo(repoRoot);
  writeCodexSession(home, { cwd: repoRoot, sessionId: 'sess-tui', originator: 'codex-tui' });

  const adapter = byId('codex');
  const session = parseCodexSession(
    path.join(home, '.codex', 'sessions', '2026', '09', '03', 'rollout-2026-09-03T00-00-00-sess-tui.jsonl'),
  );
  expect(session.meta.originator).toBe('codex-tui');
  expect(adapter?.ui({ session, env: {} })).toBe('terminal');

  const envRes = run(['--agent', 'codex', 'env'], { cwd: repoRoot, home });
  expect(envRes.status, envRes.stderr).toBe(0);
  expect(envRes.stdout).toMatch(/^ui:\s+terminal$/m);

  const graphRes = run(['--agent', 'codex', 'graph', '-n', '3'], { cwd: repoRoot, home });
  expect(graphRes.status, graphRes.stderr).toBe(0);
  expect(graphRes.stdout).toMatch(/^session /);
});

test('codex ui(): originator Codex Desktop -> desktop; graph auto is STILL ASCII', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-desktop');
  repoRoot = initRepo(repoRoot);
  writeCodexSession(home, { cwd: repoRoot, sessionId: 'sess-desktop', originator: 'Codex Desktop' });

  const adapter = byId('codex');
  const session = parseCodexSession(
    path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '09',
      '03',
      'rollout-2026-09-03T00-00-00-sess-desktop.jsonl',
    ),
  );
  expect(adapter?.ui({ session, env: {} })).toBe('desktop');

  const envRes = run(['--agent', 'codex', 'env'], { cwd: repoRoot, home });
  expect(envRes.stdout).toMatch(/^ui:\s+desktop$/m);

  // The whole point of the "one layout for every host" decision: auto never
  // switches to mermaid, even when ui() says desktop.
  const graphRes = run(['--agent', 'codex', 'graph', '-n', '3'], { cwd: repoRoot, home });
  expect(graphRes.status, graphRes.stderr).toBe(0);
  expect(graphRes.stdout).toMatch(/^session /);
  expect(!graphRes.stdout.includes('```mermaid')).toBeTruthy();

  const explicitMermaid = run(['--agent', 'codex', 'graph', '--format', 'mermaid'], { cwd: repoRoot, home });
  expect(explicitMermaid.stdout).toMatch(/```mermaid/);
});

test('codex ui(): unrecognized originator -> unknown', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-unknown');
  repoRoot = initRepo(repoRoot);
  writeCodexSession(home, { cwd: repoRoot, sessionId: 'sess-unknown', originator: 'codex_cli_rs' });
  const adapter = byId('codex');
  const session = parseCodexSession(
    path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '09',
      '03',
      'rollout-2026-09-03T00-00-00-sess-unknown.jsonl',
    ),
  );
  expect(adapter?.ui({ session, env: {} })).toBe('unknown');
});

// ------------------------------------------------------------- claude ui()

test('claude ui(): CLAUDE_CODE_ENTRYPOINT=cli -> terminal; unset -> unknown', () => {
  const adapter = byId('claude');
  expect(adapter?.ui({ session: null, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } })).toBe('terminal');
  expect(adapter?.ui({ session: null, env: {} })).toBe('unknown');
  expect(adapter?.ui({ session: null, env: { CLAUDE_CODE_ENTRYPOINT: 'something-else' } })).toBe('unknown');
});

// ------------------------------------------------------------- cursor ui()

test('cursor ui(): always unknown (no signal yet)', () => {
  const adapter = byId('cursor');
  expect(adapter?.ui({ session: null, env: {} })).toBe('unknown');
});

// ------------------------------------------------------------- --fenced

test('graph --fenced wraps ASCII output in a ```text fence; without it, no fence', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-fenced');
  repoRoot = initRepo(repoRoot);
  writeCodexSession(home, { cwd: repoRoot, sessionId: 'sess-fenced', originator: 'codex-tui' });

  const fenced = run(['--agent', 'codex', 'graph', '--fenced'], { cwd: repoRoot, home });
  expect(fenced.status, fenced.stderr).toBe(0);
  expect(fenced.stdout.startsWith('```text\n')).toBeTruthy();
  expect(fenced.stdout.trimEnd().endsWith('```')).toBeTruthy();

  const plain = run(['--agent', 'codex', 'graph'], { cwd: repoRoot, home });
  expect(plain.status, plain.stderr).toBe(0);
  expect(!plain.stdout.includes('```')).toBeTruthy();
});

test('mermaid: the id list is wrapped in its own ```text fence, separate from the ```mermaid block', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-mermaid-fence');
  repoRoot = initRepo(repoRoot);
  writeCodexSession(home, { cwd: repoRoot, sessionId: 'sess-mermaid', originator: 'codex-tui' });

  const res = run(['--agent', 'codex', 'mermaid'], { cwd: repoRoot, home });
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/```mermaid\n[\s\S]*?\n```\n/);
  expect(res.stdout).toMatch(/```text\n[\s\S]*?\n```\n?$/);
});

// ------------------------------------------------------------- skill commands

test('codex parser: a $name mention on its own line is a command, prompt shown as "$name"', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-skillcmd');
  repoRoot = initRepo(repoRoot);
  const p = writeCodexSession(home, {
    cwd: repoRoot,
    sessionId: 'sess-skillcmd',
    originator: 'codex-tui',
    extraUserMessages: ['$promptlog tree -n 5'],
  });
  const session = parseCodexSession(p);
  const skillTurn = session.turns.find((t) => t.prompt === '$promptlog');
  expect(skillTurn, 'expected a turn with prompt "$promptlog"').toBeTruthy();
  expect(skillTurn?.isCommand).toBe(true);
});

test('codex parser: a <skill ...> tag is a command, prompt shown with the skill name', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-skilltag');
  repoRoot = initRepo(repoRoot);
  const p = writeCodexSession(home, {
    cwd: repoRoot,
    sessionId: 'sess-skilltag',
    originator: 'codex-tui',
    extraUserMessages: [
      '<skill name="promptlog">tree -n 5</skill>',
      '<skill>plain tag with no name attr</skill>',
    ],
  });
  const session = parseCodexSession(p);
  const named = session.turns.find((t) => t.prompt === '$promptlog');
  expect(named, 'expected a turn with prompt "$promptlog"').toBeTruthy();
  expect(named?.isCommand).toBe(true);

  const unnamed = session.turns.find((t) => t.prompt.startsWith('<skill>') && t.prompt !== '$promptlog');
  expect(unnamed, 'expected a turn for the nameless <skill> tag').toBeTruthy();
  expect(unnamed?.isCommand).toBe(true);
});

test('codex parser: an ordinary prompt is never mistaken for a skill command', () => {
  const home = tmpDir();
  let repoRoot = path.join(home, 'work', 'repo-normalprompt');
  repoRoot = initRepo(repoRoot);
  const p = writeCodexSession(home, {
    cwd: repoRoot,
    sessionId: 'sess-normal',
    originator: 'codex-tui',
    extraUserMessages: ['please fix the $HOME variable handling in config.sh'],
  });
  const session = parseCodexSession(p);
  const turn = session.turns.find((t) => t.prompt.includes('$HOME'));
  expect(turn).toBeTruthy();
  expect(turn?.isCommand).toBe(false);
});

test('codex desktop skill shapes are commands: markdown-link mention and <skill><name> block', () => {
  expect(skillCommandName('[$promptlog](/Users/x/.codex/skills/promptlog/SKILL.md)&#x20;')).toBe(
    '$promptlog',
  );
  expect(
    skillCommandName('<skill>\n<name>promptlog</name>\n<path>/x/SKILL.md</path>\n---\nname: promptlog'),
  ).toBe('$promptlog');
  expect(skillCommandName('Can you please draw a graph for me?')).toBe(null);
});
