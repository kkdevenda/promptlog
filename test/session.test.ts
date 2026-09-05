import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { slug } from '../src/agents/claude/locate';
import { findGitRoot } from '../src/core/fsutil';
import { listCandidateSessions, resolveSession } from '../src/core/session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-session-test-'));
}

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

/** Build a fake HOME with a repo (with .git) and Claude/Codex transcript
 * dirs underneath it, returning useful paths. */
function makeFixture(): { home: string; repoRoot: string } {
  const home = tmpDir();
  const repoRoot = path.join(home, 'work', 'myrepo');
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  return { home, repoRoot };
}

function claudeSlugDir(home: string, cwd: string): string {
  return path.join(home, '.claude', 'projects', slug(cwd));
}

function writeClaudeSession(
  home: string,
  { cwd, sessionId, ts, mtimeMs }: { cwd: string; sessionId: string; ts: string; mtimeMs?: number },
): string {
  const dir = claudeSlugDir(home, cwd);
  const p = path.join(dir, `${sessionId}.jsonl`);
  writeJsonl(p, [
    {
      type: 'user',
      uuid: `${sessionId}-u1`,
      parentUuid: null,
      timestamp: ts,
      cwd,
      sessionId,
      message: { role: 'user', content: 'hello' },
    },
  ]);
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

function writeCodexSession(
  home: string,
  {
    cwd,
    sessionId,
    filenameSuffix,
    ts,
    mtimeMs,
  }: { cwd: string; sessionId: string; filenameSuffix?: string; ts: string; mtimeMs?: number },
): string {
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '01', '01');
  fs.mkdirSync(dayDir, { recursive: true });
  const fname = `rollout-2026-01-01T00-00-00-${filenameSuffix || sessionId}.jsonl`;
  const p = path.join(dayDir, fname);
  writeJsonl(p, [
    { type: 'session_meta', timestamp: ts, payload: { id: sessionId, cwd, timestamp: ts } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: 'hi' } },
  ]);
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

describe('session resolution', () => {
  test('findGitRoot walks up to the nearest .git', () => {
    const { repoRoot } = makeFixture();
    const sub = path.join(repoRoot, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(repoRoot);
    expect(findGitRoot(repoRoot)).toBe(repoRoot);
  });

  test('resolveSession: explicit path', () => {
    const { home, repoRoot } = makeFixture();
    const p = writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'abc12345-full',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ session: p, cwd: repoRoot, env: {}, home });
    expect(res.how).toBe('explicit');
    expect(res.agent).toBe('claude');
    expect(res.path).toBe(p);
    expect(res.sessionId).toBe('abc12345-full');
  });

  test('resolveSession: explicit codex rollout path', () => {
    const { home, repoRoot } = makeFixture();
    const p = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'thread-xyz',
      filenameSuffix: 'thread-xyz',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ session: p, cwd: repoRoot, env: {}, home });
    expect(res.how).toBe('explicit');
    expect(res.agent).toBe('codex');
    expect(res.path).toBe(p);
    expect(res.sessionId).toBe('thread-xyz');
  });

  test('resolveSession: CLAUDE_CODE_SESSION_ID env var', () => {
    const { home, repoRoot } = makeFixture();
    const p = writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'envmatch-1',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ cwd: repoRoot, env: { CLAUDE_CODE_SESSION_ID: 'envmatch-1' }, home });
    expect(res.how).toBe('env:CLAUDE_CODE_SESSION_ID');
    expect(res.agent).toBe('claude');
    expect(res.path).toBe(p);
    expect(res.sessionId).toBe('envmatch-1');
  });

  test('resolveSession: CODEX_THREAD_ID env var matches filename suffix', () => {
    const { home, repoRoot } = makeFixture();
    const p = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'internal-id-not-used-for-match',
      filenameSuffix: 'thread-abc999',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ cwd: repoRoot, env: { CODEX_THREAD_ID: 'thread-abc999' }, home });
    expect(res.how).toBe('env:CODEX_THREAD_ID');
    expect(res.agent).toBe('codex');
    expect(res.path).toBe(p);
  });

  test('resolveSession: CODEX_SESSION_ID env var fallback', () => {
    const { home, repoRoot } = makeFixture();
    const p = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'sess-fallback-1',
      filenameSuffix: 'sess-fallback-1',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ cwd: repoRoot, env: { CODEX_SESSION_ID: 'sess-fallback-1' }, home });
    expect(res.how).toBe('env:CODEX_SESSION_ID');
    expect(res.agent).toBe('codex');
    expect(res.path).toBe(p);
  });

  test('resolveSession: newest-for-cwd falls back to newest transcript under repo root', () => {
    const { home, repoRoot } = makeFixture();
    writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'older-session',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now() - 100000,
    });
    const newer = writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'newer-session',
      ts: '2026-01-01T00:01:00Z',
      mtimeMs: Date.now(),
    });
    const res = resolveSession({ cwd: repoRoot, env: {}, home });
    expect(res.how).toBe('newest-for-cwd');
    expect(res.agent).toBe('claude');
    expect(res.path).toBe(newer);
    expect(res.sessionId).toBe('newer-session');
  });

  test('resolveSession: newest-for-cwd picks newest across both agents when auto', () => {
    const { home, repoRoot } = makeFixture();
    writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'claude-sess',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now() - 100000,
    });
    const codexP = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'codex-sess',
      filenameSuffix: 'codex-sess',
      ts: '2026-01-01T00:01:00Z',
      mtimeMs: Date.now(),
    });
    const res = resolveSession({ agent: 'auto', cwd: repoRoot, env: {}, home });
    expect(res.how).toBe('newest-for-cwd');
    expect(res.agent).toBe('codex');
    expect(res.path).toBe(codexP);
  });

  test('resolveSession: newest-for-cwd honors --agent restriction', () => {
    const { home, repoRoot } = makeFixture();
    const claudeP = writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'claude-sess',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now() - 100000,
    });
    writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'codex-sess',
      filenameSuffix: 'codex-sess',
      ts: '2026-01-01T00:01:00Z',
      mtimeMs: Date.now(),
    });
    const res = resolveSession({ agent: 'claude', cwd: repoRoot, env: {}, home });
    expect(res.agent).toBe('claude');
    expect(res.path).toBe(claudeP);
  });

  test('resolveSession: recorded cwd in a parent directory up to the git root still matches', () => {
    const { home, repoRoot } = makeFixture();
    const sub = path.join(repoRoot, 'sub', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    const p = writeClaudeSession(home, {
      cwd: repoRoot,
      sessionId: 'root-session',
      ts: '2026-01-01T00:00:00Z',
    });
    const res = resolveSession({ cwd: sub, env: {}, home });
    expect(res.how).toBe('newest-for-cwd');
    expect(res.path).toBe(p);
  });

  test('resolveSession: no session found returns nulls', () => {
    const { home, repoRoot } = makeFixture();
    const res = resolveSession({ cwd: repoRoot, env: {}, home });
    expect(res.agent).toBe(null);
    expect(res.path).toBe(null);
    expect(res.how).toBe(null);
  });

  test('listCandidateSessions: only returns sessions whose cwd is under the repo, honoring since', () => {
    const { home, repoRoot } = makeFixture();
    const inRepo = writeClaudeSession(home, {
      cwd: path.join(repoRoot, 'src'),
      sessionId: 'in-repo-session',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now(),
    });
    writeClaudeSession(home, {
      cwd: path.join(home, 'other-project'),
      sessionId: 'outside-session',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now(),
    });
    const old = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'old-codex-session',
      filenameSuffix: 'old-codex-session',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now() - 1000000,
    });
    const recentCodex = writeCodexSession(home, {
      cwd: repoRoot,
      sessionId: 'recent-codex-session',
      filenameSuffix: 'recent-codex-session',
      ts: '2026-01-01T00:00:00Z',
      mtimeMs: Date.now(),
    });

    const results = listCandidateSessions({ cwd: repoRoot, since: Date.now() - 60000, home });
    const paths = results.map((r) => r.path);
    expect(paths).toContain(inRepo);
    expect(paths).toContain(recentCodex);
    expect(paths).not.toContain(old);
    expect(results.some((r) => r.sessionId === 'outside-session')).toBe(false);
    for (const r of results) {
      expect(['claude', 'codex']).toContain(r.agent);
      expect(typeof r.mtime).toBe('number');
    }
  });
});
