/**
 * `promptlog status` / `promptlog statusline` (see docs/DESIGN.md "Agent
 * surfaces", README.md "Status line"). `renderStatus` itself is
 * agent-neutral; the statusline tests exercise the whole path including the
 * Claude-only `parseStatusInput` hook, via a synthetic Claude statusLine
 * payload and a temp HOME so nothing here touches the real machine.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parseClaudeSession } from '../src/agents/claude/parser';
import { renderStatus, statusStats } from '../src/core/renderStatus';
import { Colors } from '../src/core/util';

const REPO = path.resolve(__dirname, '..');
const PROMPTLOG = path.join(REPO, 'bin', 'promptlog.js');
const BRANCH_FIXTURE = path.join(__dirname, 'fixtures', 'claude', 'branch.jsonl');

function loadBranchSession() {
  return parseClaudeSession(BRANCH_FIXTURE);
}

function slug(cwd: string): string {
  return cwd.split(path.sep).join('-');
}

function runStatusline({ input, cwd, home }: { input: string; cwd: string; home: string }) {
  return spawnSync(process.execPath, [PROMPTLOG, 'statusline'], {
    cwd,
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
    },
  });
}

// -------------------------------------------------------------- renderStatus

test('renderStatus: one line, no trailing newline, matches the documented shape', () => {
  const session = loadBranchSession();
  const out = renderStatus(session, { colors: new Colors(false) });

  expect(out.includes('\n')).toBe(false); // renderStatus must return a single line
  expect(out).toMatch(/^\u{1F333} \d+ prompts · active .+ · ↑\S+ ↓\S+ · \u{1F527}\d+$/u);

  const stats = statusStats(session);
  expect(stats.prompts).toBe(session.turns.length);
  expect(out.includes(`${stats.prompts} prompts`)).toBeTruthy();
});

test('renderStatus: --json shape carries prompts/commands/activeS/spanS/out/in/tools/lastPrompt', () => {
  const session = loadBranchSession();
  const stats = statusStats(session);
  for (const key of [
    'prompts',
    'commands',
    'activeS',
    'spanS',
    'out',
    'in',
    'tools',
    'lastPrompt',
  ] as const) {
    expect(Object.hasOwn(stats, key)).toBeTruthy();
  }
  expect(typeof stats.lastPrompt).toBe('string');
  expect((stats.lastPrompt ?? '').length <= 60).toBeTruthy();
});

// -------------------------------------------------------------- statusline
//
// These spawn the built CLI (bin/promptlog.js); `npm run build` runs first.

test('statusline: synthetic Claude statusLine JSON resolves the fixture transcript via a temp HOME', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-status-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });

  const sessionId = 'status-fixture-session';
  const projectDir = path.join(home, '.claude', 'projects', slug(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(BRANCH_FIXTURE, path.join(projectDir, `${sessionId}.jsonl`));

  try {
    const input = JSON.stringify({ session_id: sessionId, cwd, model: { display_name: 'Test Model' } });
    const res = runStatusline({ input, cwd, home });

    expect(res.status).toBe(0);
    const expected = renderStatus(loadBranchSession(), { colors: new Colors(false) });
    expect(res.stdout.trim()).toBe(expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('statusline: input no adapter recognises (no session_id) falls back to newest-for-cwd, no error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-status-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });

  const sessionId = 'fallback-fixture-session';
  const projectDir = path.join(home, '.claude', 'projects', slug(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(BRANCH_FIXTURE, path.join(projectDir, `${sessionId}.jsonl`));

  try {
    // No `session_id` field: nothing recognises this as Claude's shape, so
    // it falls back to `status` behaviour using this JSON's own `cwd`.
    const input = JSON.stringify({ cwd, hello: 'world' });
    const res = runStatusline({ input, cwd, home });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    const expected = renderStatus(loadBranchSession(), { colors: new Colors(false) });
    expect(res.stdout.trim()).toBe(expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('statusline: garbage stdin never throws, prints nothing, exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-status-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'empty-project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  try {
    const res = runStatusline({ input: 'this is not json at all {{{', cwd, home });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
