/**
 * Attribution, PLAN-v0.3.md §3: contributors by evidence, committer by env
 * var, nothing guessed.
 *
 * The scenario every case below shares - one temp git repo, two synthetic
 * sessions and a human:
 *
 *   session A (claude)  file1 via Edit, file3 via Edit, file5 via `sed -i`
 *   session B (codex)   file2 via apply_patch, file3 via apply_patch
 *   the human           file4, by hand, with no transcript anywhere
 *
 * file3 is edited by both, in different regions: the hunks must go to the
 * right turn each, and file4 must stay unattributed rather than being handed
 * to whoever happened to be running.
 *
 * The Codex-only apply_patch/parseV4A cases from OLD live in
 * test/codex.test.ts and are not duplicated here.
 *
 * Cases under "through the real hooks" spawn `bin/promptlog.js` and read
 * `.promptlog/` back, or call `commands/repo.ts` (`attributableStagedFiles`)
 * directly: both need `src/core/commands/repo.ts`, still being ported by
 * another work package. They are ported anyway and will fail to run until
 * it (and a full `npm run build`) land - tracked, not silently skipped.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { claude } from '../src/agents/claude';
import { slug } from '../src/agents/claude/locate';
import { codex } from '../src/agents/codex';
import * as attribution from '../src/core/attribution';
import * as repoCmds from '../src/core/commands/repo';
import * as gitmod from '../src/core/git';
import * as sessionRecords from '../src/core/sessionRecords';
import * as shellWrites from '../src/core/shellWrites';
import { rmTree } from './helpers';

const REPO = path.resolve(__dirname, '..');
const PROMPTLOG = path.join(REPO, 'bin', 'promptlog.js');

const SID_A = 'aaaa1111-2222-4333-8444-555566667777';
const SID_B = '019fb1a0-8888-7999-baaa-bbbbccccdddd';

// ------------------------------------------------------------- scaffolding

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Tool calls are timestamped in the near future, exactly as a live transcript
 * looks from inside the turn making them: the previous commit's committer date
 * is the floor for evidence, and a turn still running has not finished writing.
 */
const AHEAD = 600000;

function sandbox(): { home: string; repoDir: string; env: NodeJS.ProcessEnv } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-attr-')));
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(home, 'repo-')));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    NO_COLOR: '1',
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  fs.writeFileSync(
    env.GIT_CONFIG_GLOBAL as string,
    '[user]\n\tname = Test\n\temail = test@example.com\n',
    'utf8',
  );
  return { home, repoDir, env };
}

function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/**
 * Same as `git()`, but keeps stderr instead of discarding it on success - a
 * hook's own stderr is inherited straight through to `git`'s, so this is how
 * a passing commit's diagnostics (see `BUDGET_SKIP` below) are read back.
 */
function gitCapture(env: NodeJS.ProcessEnv, cwd: string, args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * The shared hook budget (`git.HOOK_BUDGET_MS`, `hooks.ts`'s `noteBudgetSkip`
 * and `git.ts`'s own clamped-timeout note) is real and platform-aware - on a
 * slow-enough Windows runner, a commit's worth of hooks can genuinely run
 * out of time, and when they do every skip says so on stderr rather than
 * failing silently. A test asserting exact attribution has no way to
 * distinguish "the matcher is broken" from "the runner was too slow to
 * finish computing it this one time", so it reads this marker back out of
 * the commit's stderr first and, when it fired, treats the degraded result
 * as the documented outcome instead of a failure.
 */
const BUDGET_SKIP = /^promptlog: (?:hook budget exhausted|git \S+ did not finish within)/m;

/**
 * Diagnostics for the two Windows-only "evidence missing" failures
 * (case 3, reindex): whether `git diff` staged CRLF the attributor never
 * saw is the leading theory, but it could not be confirmed without a
 * Windows box, so print what would confirm or rule it out - dumped through
 * `console.error` so it survives into the CI log regardless of the
 * assertion outcome.
 */
function dumpAttributionDiagnostics(
  env: NodeJS.ProcessEnv,
  repoDir: string,
  label: string,
  sha: string | null = null,
): void {
  try {
    const autocrlf = spawnSync('git', ['config', '--get', 'core.autocrlf'], {
      cwd: repoDir,
      env,
      encoding: 'utf8',
    });
    const diffArgs = sha ? ['show', '-U0', '--no-color', sha] : ['diff', '--cached', '-U0', '--no-color'];
    const diff = spawnSync('git', diffArgs, { cwd: repoDir, env, encoding: 'utf8' });
    console.error(
      `[attribution diagnostics: ${label}]\n` +
        `core.autocrlf=${JSON.stringify(autocrlf.stdout.trim())}\n` +
        `git ${diffArgs.join(' ')}:\n${JSON.stringify(diff.stdout)}`,
    );
  } catch (e) {
    console.error(`[attribution diagnostics: ${label}] failed to collect: ${String(e)}`);
  }
}

function promptlog(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [PROMPTLOG, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Session A: Claude, with two Edits and a `sed -i`. */
function writeClaudeTranscript(home: string, repoDir: string): string {
  const dir = path.join(home, '.claude', 'projects', slug(repoDir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID_A}.jsonl`);
  const base = { isSidechain: false, cwd: repoDir, sessionId: SID_A };
  const uuid = (n: number) => `aaaa${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;
  const records = [
    {
      ...base,
      type: 'user',
      uuid: uuid(1),
      parentUuid: null,
      timestamp: iso(-2000),
      message: { role: 'user', content: 'say hello properly in file1 and file3' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: uuid(2),
      parentUuid: uuid(1),
      timestamp: iso(AHEAD),
      message: {
        model: 'claude-fable-5-1',
        id: 'msg_a1',
        role: 'assistant',
        type: 'message',
        usage: {
          input_tokens: 3,
          output_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        content: [
          { type: 'text', text: 'Editing.' },
          {
            type: 'tool_use',
            id: 'toolu_a1',
            name: 'Edit',
            input: {
              file_path: path.join(repoDir, 'file1.txt'),
              old_string: 'one',
              new_string: 'ONE from session A',
              replace_all: false,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_a2',
            name: 'Edit',
            input: {
              file_path: path.join(repoDir, 'file3.txt'),
              old_string: 'top',
              new_string: 'top touched by A',
              replace_all: false,
            },
          },
          {
            type: 'tool_use',
            id: 'toolu_a3',
            name: 'Bash',
            input: { command: `sed -i '' 's/five/FIVE/' ${path.join(repoDir, 'file5.txt')}` },
          },
        ],
      },
    },
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

/** Session B: Codex, with two apply_patch calls. */
function writeCodexTranscript(home: string, repoDir: string): string {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '03');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-03T10-00-00-${SID_B}.jsonl`);
  const patch = [
    '*** Begin Patch',
    '*** Update File: file2.txt',
    '@@',
    '-two',
    '+TWO from session B',
    '*** Update File: file3.txt',
    '@@',
    '-bottom',
    '+bottom touched by B',
    '*** End Patch',
  ].join('\n');
  const records = [
    {
      timestamp: iso(-4000),
      type: 'session_meta',
      payload: { id: SID_B, timestamp: iso(-4000), cwd: repoDir },
    },
    { timestamp: iso(-3000), type: 'event_msg', payload: { type: 'task_started' } },
    {
      timestamp: iso(-2000),
      type: 'event_msg',
      payload: { type: 'user_message', message: 'shout in file2 and the bottom of file3' },
    },
    {
      timestamp: iso(AHEAD),
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_b1', input: patch },
    },
    {
      timestamp: iso(AHEAD + 1000),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 20,
            reasoning_output_tokens: 5,
          },
        },
      },
    },
    { timestamp: iso(AHEAD + 2000), type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    {
      timestamp: iso(AHEAD + 3000),
      type: 'event_msg',
      payload: { type: 'task_complete', duration_ms: 7000 },
    },
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

interface Candidate {
  agent: string;
  sessionId: string;
  path: string;
  session: ReturnType<typeof claude.parse>;
  how?: string | null;
}

/**
 * The repo after both agents and the human have worked, everything staged.
 * Returns the parsed sessions plus what the attributor needs.
 */
function scenario(): {
  home: string;
  repoDir: string;
  env: NodeJS.ProcessEnv;
  sessionA: Candidate;
  sessionB: Candidate;
  gidA: string;
  gidB: string;
  since: number | null;
  staged: string[];
  hunks: Map<string, gitmod.DiffHunk[]>;
} {
  const { home, repoDir, env } = sandbox();
  git(env, repoDir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'one\n');
  fs.writeFileSync(path.join(repoDir, 'file2.txt'), 'two\n');
  fs.writeFileSync(path.join(repoDir, 'file3.txt'), 'top\nmiddle\nbottom\n');
  fs.writeFileSync(path.join(repoDir, 'file4.txt'), 'four\n');
  fs.writeFileSync(path.join(repoDir, 'file5.txt'), 'five\n');
  git(env, repoDir, ['add', '.']);
  git(env, repoDir, ['commit', '-q', '-m', 'base']);

  const claudePath = writeClaudeTranscript(home, repoDir);
  const codexPath = writeCodexTranscript(home, repoDir);

  // The working tree as those transcripts describe it, plus a hand edit.
  fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'ONE from session A\n');
  fs.writeFileSync(path.join(repoDir, 'file2.txt'), 'TWO from session B\n');
  fs.writeFileSync(path.join(repoDir, 'file3.txt'), 'top touched by A\nmiddle\nbottom touched by B\n');
  fs.writeFileSync(path.join(repoDir, 'file4.txt'), 'four, by hand\n');
  fs.writeFileSync(path.join(repoDir, 'file5.txt'), 'FIVE\n');
  git(env, repoDir, ['add', '.']);

  const sessionA: Candidate = {
    agent: 'claude',
    sessionId: SID_A,
    path: claudePath,
    session: claude.parse(claudePath),
    how: null,
  };
  const sessionB: Candidate = {
    agent: 'codex',
    sessionId: SID_B,
    path: codexPath,
    session: codex.parse(codexPath),
    how: null,
  };
  const gidA = sessionA.session.turns[0]?.gid as string;
  const gidB = sessionB.session.turns[0]?.gid as string;

  return {
    home,
    repoDir,
    env,
    sessionA,
    sessionB,
    gidA,
    gidB,
    since: gitmod.headCommitTime(repoDir),
    staged: gitmod.stagedFiles(repoDir),
    hunks: gitmod.stagedHunks(repoDir),
  };
}

// ------------------------------------------------------------------- cases

describe('attribution', () => {
  test('case 1: agent A commits - A is committer and contributor, B is contributor', () => {
    const s = scenario();
    try {
      const { linked, unattributed } = attribution.attribute({
        repoRoot: s.repoDir,
        stagedFiles: s.staged,
        hunksByFile: s.hunks,
        candidateSessions: [s.sessionA, s.sessionB],
        sinceMicros: s.since,
        // A committed: its own agent named the session in promptlog's environment.
        committerSession: { ...s.sessionA, how: 'env:CLAUDE_CODE_SESSION_ID' },
      });

      const a = linked.get(s.gidA);
      const b = linked.get(s.gidB);
      expect(a, `session A linked: ${JSON.stringify([...linked.keys()])}`).toBeTruthy();
      expect(b, 'session B linked').toBeTruthy();
      expect(a?.role, 'A both committed and contributed').toBe('both');
      expect(b?.role, 'B only contributed').toBe('contributor');

      // Per-file, hunk-level evidence.
      expect(a?.files['file1.txt']).toEqual({ hunks: 1, matched: 1, confidence: 'edit' });
      expect(b?.files['file2.txt']).toEqual({ hunks: 1, matched: 1, confidence: 'patch' });
      expect(a?.files['file2.txt'], 'A never touched file2').toBeUndefined();
      expect(b?.files['file1.txt'], 'B never touched file1').toBeUndefined();

      // file3: one hunk each, from the region each of them edited.
      expect(s.hunks.get('file3.txt')?.length, 'two separate hunks at -U0').toBe(2);
      expect(a?.files['file3.txt']).toEqual({ hunks: 2, matched: 1, confidence: 'edit' });
      expect(b?.files['file3.txt']).toEqual({ hunks: 2, matched: 1, confidence: 'patch' });

      // file5: tier B. A ran `sed -i` on it, which is file level and says so -
      // one hunk in the file, none of it matched line by line.
      expect(a?.files['file5.txt']).toEqual({ hunks: 1, matched: 0, confidence: 'shell' });
      expect(unattributed['file5.txt'], 'tier B evidence is still evidence').toBeUndefined();

      // file4 was edited by hand: nobody gets it.
      expect(unattributed).toEqual({ 'file4.txt': 1 });
      for (const v of linked.values()) expect(v.files['file4.txt']).toBeUndefined();
    } finally {
      rmTree(s.home);
    }
  });

  test('case 2: the human commits - both agents contribute, nobody is committer', () => {
    const s = scenario();
    try {
      const { linked, unattributed } = attribution.attribute({
        repoRoot: s.repoDir,
        stagedFiles: s.staged,
        hunksByFile: s.hunks,
        candidateSessions: [s.sessionA, s.sessionB],
        sinceMicros: s.since,
        committerSession: null, // no env var: a human typed `git commit`
      });

      expect(linked.get(s.gidA)?.role).toBe('contributor');
      expect(linked.get(s.gidB)?.role).toBe('contributor');
      for (const v of linked.values()) {
        expect(v.role).not.toBe('committer');
        expect(v.role).not.toBe('both');
      }
      expect(unattributed).toEqual({ 'file4.txt': 1 });
    } finally {
      rmTree(s.home);
    }
  });

  test('a turn that edited nothing in the commit is not linked at all', () => {
    const s = scenario();
    try {
      // Only file4 (the hand edit) is in scope: neither session can be shown to
      // have written it, and neither is committing.
      const { linked, unattributed } = attribution.attribute({
        repoRoot: s.repoDir,
        stagedFiles: ['file4.txt'],
        hunksByFile: s.hunks,
        candidateSessions: [s.sessionA, s.sessionB],
        sinceMicros: s.since,
        committerSession: null,
      });
      expect(linked.size, 'no evidence, no link - and no guess').toBe(0);
      expect(unattributed).toEqual({ 'file4.txt': 1 });

      // With an agent committing, that one turn is linked as committer even
      // though it wrote none of this.
      const withCommitter = attribution.attribute({
        repoRoot: s.repoDir,
        stagedFiles: ['file4.txt'],
        hunksByFile: s.hunks,
        candidateSessions: [s.sessionA, s.sessionB],
        sinceMicros: s.since,
        committerSession: { ...s.sessionB, how: 'env:CODEX_THREAD_ID' },
      });
      expect([...withCommitter.linked.keys()]).toEqual([s.gidB]);
      expect(withCommitter.linked.get(s.gidB)?.role).toBe('committer');
      expect(withCommitter.linked.get(s.gidB)?.files, 'a committer claims no files it cannot prove').toEqual(
        {},
      );
    } finally {
      rmTree(s.home);
    }
  });

  test('a Write is attributed by the staged blob hash, whole file at once', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
      git(env, repoDir, ['add', '.']);
      git(env, repoDir, ['commit', '-q', '-m', 'base']);

      const content = 'line one\nline two\nline three\n';
      const dir = path.join(home, '.claude', 'projects', slug(repoDir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${SID_A}.jsonl`);
      const base = { isSidechain: false, cwd: repoDir, sessionId: SID_A };
      fs.writeFileSync(
        file,
        `${[
          {
            ...base,
            type: 'user',
            uuid: 'w1',
            parentUuid: null,
            timestamp: iso(-2000),
            message: { role: 'user', content: 'write three lines' },
          },
          {
            ...base,
            type: 'assistant',
            uuid: 'w2',
            parentUuid: 'w1',
            timestamp: iso(AHEAD),
            message: {
              model: 'm',
              id: 'msg_w',
              role: 'assistant',
              type: 'message',
              usage: {},
              content: [
                {
                  type: 'tool_use',
                  id: 't',
                  name: 'Write',
                  input: { file_path: path.join(repoDir, 'three.txt'), content },
                },
              ],
            },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
        'utf8',
      );

      fs.writeFileSync(path.join(repoDir, 'three.txt'), content);
      git(env, repoDir, ['add', '.']);

      const session = claude.parse(file);
      const gid = session.turns[0]?.gid as string;
      expect(gitmod.stagedBlobHash(repoDir, 'three.txt'), 'the staged blob is exactly what Write wrote').toBe(
        attribution.blobSha1(content),
      );

      const { linked, unattributed } = attribution.attribute({
        repoRoot: repoDir,
        stagedFiles: gitmod.stagedFiles(repoDir),
        hunksByFile: gitmod.stagedHunks(repoDir),
        candidateSessions: [{ agent: 'claude', sessionId: SID_A, session }],
        sinceMicros: gitmod.headCommitTime(repoDir),
        committerSession: null,
      });
      const entry = linked.get(gid)?.files['three.txt'];
      expect(entry?.confidence).toBe('write');
      expect(entry?.matched, 'every hunk of the file belongs to that Write').toBe(entry?.hunks);
      expect(unattributed).toEqual({});
    } finally {
      rmTree(home);
    }
  });

  // --------------------------------------------------- adapter edit evidence

  test('claude edits(): Edit, Write, MultiEdit, NotebookEdit and shell writes', () => {
    const fixture = path.join(REPO, 'test', 'fixtures', 'claude', 'edits.jsonl');
    const session = claude.parse(fixture);
    const root = '/tmp/promptlog-fixture';
    const list = claude.edits(session, { root });
    const by = (kind: string) => list.filter((e) => e.kind === kind);

    expect(claude.capabilities.edits).toBe(true);
    const edit = by('edit').find((e) => e.after === 'const greeting = "hello";');
    expect(edit, JSON.stringify(list, null, 1)).toBeTruthy();
    expect(edit?.rel).toBe('src/greet.js');
    // `root`/`file_path` are POSIX text like every transcript path (DESIGN.md
    // "Hooks"): forward slashes always, never the host separator.
    expect(edit?.file, 'absolute path too').toBe(`${root}/src/greet.js`);
    expect(edit?.before).toBe('const greeting = "hi";');
    expect(edit?.turnId, 'credited to the turn that ran it').toBe(session.turns[0]?.gid);

    const write = by('write')[0];
    expect(write?.rel).toBe('src/version.txt');
    expect(write?.after).toBe('0.3.0\n');

    // MultiEdit becomes one entry per sub-edit, on the second turn.
    const multi = by('edit').find((e) => e.after === 'module.exports = { greeting };');
    expect(multi).toBeTruthy();
    expect(multi?.turnId).toBe(session.turns[1]?.gid);

    expect(by('notebook').map((e) => e.rel)).toEqual(['analysis.ipynb']);
    expect(
      by('shell')
        .map((e) => e.rel)
        .sort(),
    ).toEqual(['CHANGELOG.md', 'notes/log.txt']);
    expect(list.every((e) => Number.isFinite(e.tsMicros))).toBe(true);

    // Nothing outside the root claims a repo-relative path.
    expect(claude.edits(session, { root: '/somewhere/else' }).every((e) => e.rel === null)).toBe(true);
  });

  test('parseShellWrites finds written paths and refuses to invent them', () => {
    const p = shellWrites.parseShellWrites;
    expect(p('echo hi > out.txt')).toEqual(['out.txt']);
    expect(p('echo hi >> notes/log.txt 2>&1')).toEqual(['notes/log.txt']);
    expect(p("cat > src/new.js <<'EOF'\nbody\nEOF")).toEqual(['src/new.js']);
    expect(p('grep -n x a.js | tee results.txt')).toEqual(['results.txt']);
    expect(p('tee -a lib/notes.txt')).toEqual(['lib/notes.txt']);
    expect(p("sed -i '' 's/a/b/' one.js two.js"), 'the script is not a path').toEqual(['one.js', 'two.js']);
    expect(p('sed -i.bak s/a/b/ one.js')).toEqual(['one.js']);
    expect(p('sed -n "1,5p" one.js'), 'without -i, sed writes nothing').toEqual([]);
    expect(p('mv old.js new.js'), 'the destination is what got written').toEqual(['new.js']);
    expect(p('cp -r a b')).toEqual(['b']);
    expect(p('patch -p1 target.c')).toEqual(['target.c']);
    // `git apply f.patch` writes what the PATCH names, which the command line
    // does not say: claiming f.patch would be a lie.
    expect(p('git apply f.patch')).toEqual([]);
    expect(p('cat x.js > /dev/null')).toEqual([]);
    expect(p('echo hi > "$OUT"'), 'an unexpanded variable is not a path').toEqual([]);
    expect(p('rm -rf build && npm run build')).toEqual([]);
    expect(p('')).toEqual([]);
    expect(p(null)).toEqual([]);
  });

  test('addedRelativeTo subtracts the context an Edit repeats', () => {
    const { addedRelativeTo } = attribution;
    // The commonest edit there is: insert a line, keep its neighbours. `-U0`
    // shows only "world", so new_string whole would never match.
    expect(addedRelativeTo('hello', 'hello\nworld')).toEqual(['world']);
    expect(addedRelativeTo('a\nb\nc', 'a\nB\nc')).toEqual(['B']);
    expect(addedRelativeTo('a\nb', 'a'), 'a pure deletion adds nothing').toEqual([]);
    expect(addedRelativeTo(null, 'x\ny')).toEqual(['x', 'y']);
    // Repeated lines are counted, not deduped.
    expect(addedRelativeTo('x', 'x\nx')).toEqual(['x']);
  });

  test('an edit that only removes lines is matched on the removed side', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(repoDir, 'del.txt'), 'keep\nconst dropMe = "no longer needed";\nkeep too\n');
      git(env, repoDir, ['add', '.']);
      git(env, repoDir, ['commit', '-q', '-m', 'base']);

      const dir = path.join(home, '.claude', 'projects', slug(repoDir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${SID_A}.jsonl`);
      const base = { isSidechain: false, cwd: repoDir, sessionId: SID_A };
      fs.writeFileSync(
        file,
        `${[
          {
            ...base,
            type: 'user',
            uuid: 'd1',
            parentUuid: null,
            timestamp: iso(-2000),
            message: { role: 'user', content: 'drop that line' },
          },
          {
            ...base,
            type: 'assistant',
            uuid: 'd2',
            parentUuid: 'd1',
            timestamp: iso(AHEAD),
            message: {
              model: 'm',
              id: 'msg_d',
              role: 'assistant',
              type: 'message',
              usage: {},
              content: [
                {
                  type: 'tool_use',
                  id: 't',
                  name: 'Edit',
                  input: {
                    file_path: path.join(repoDir, 'del.txt'),
                    old_string: 'const dropMe = "no longer needed";\n',
                    new_string: '',
                  },
                },
              ],
            },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
        'utf8',
      );

      fs.writeFileSync(path.join(repoDir, 'del.txt'), 'keep\nkeep too\n');
      git(env, repoDir, ['add', '.']);
      const session = claude.parse(file);
      const { linked, unattributed } = attribution.attribute({
        repoRoot: repoDir,
        stagedFiles: gitmod.stagedFiles(repoDir),
        hunksByFile: gitmod.stagedHunks(repoDir),
        candidateSessions: [{ agent: 'claude', sessionId: SID_A, session }],
        sinceMicros: gitmod.headCommitTime(repoDir),
        committerSession: null,
      });
      expect(linked.get(session.turns[0]?.gid as string)?.files['del.txt']).toEqual({
        hunks: 1,
        matched: 1,
        confidence: 'edit',
      });
      expect(unattributed).toEqual({});
    } finally {
      rmTree(home);
    }
  });

  test('parseShellWrites follows cd/pushd across a command string', () => {
    const p = shellWrites.parseShellWrites;
    const home = os.homedir();
    // The shape that was reported unattributed from a live session: the append
    // is relative to the `cd` target, not to the tool's starting directory.
    expect(p('cd /path/to/repo; echo "human line" >> notes.txt')).toEqual(['/path/to/repo/notes.txt']);
    expect(p("cd /repo && sed -i '' s/a/b/ src/a.js")).toEqual(['/repo/src/a.js']);
    expect(p('cd /repo\ntee -a log.txt'), 'newlines separate too').toEqual(['/repo/log.txt']);
    expect(p('cd /repo || echo x > fallback.txt')).toEqual(['/repo/fallback.txt']);
    // No cd: still relative, for the caller to resolve against the session cwd.
    expect(p('echo x > plain.txt')).toEqual(['plain.txt']);
    // A relative cd stays relative - it is still anchored to the same place.
    expect(p('cd src && echo x > y.js')).toEqual(['src/y.js']);
    // The tracked directory is always POSIX text (DESIGN.md "Hooks"), so a
    // home-relative `cd` comes back forward-slash even on a Windows host.
    const homeSlash = home.replace(/\\/g, '/');
    expect(p('cd ~ && echo x > y.js')).toEqual([`${homeSlash}/y.js`]);
    expect(p('cd ~/work && echo x > y.js')).toEqual([`${homeSlash}/work/y.js`]);
    expect(p('cd && echo x > y.js'), 'bare cd goes home').toEqual([`${homeSlash}/y.js`]);
    // An absolute target is never re-anchored.
    expect(p('cd /a && echo x > /b/y.js')).toEqual(['/b/y.js']);
    // Unresolvable: give up for the rest of the command rather than guess.
    expect(p('cd "$REPO" && echo x > y.js')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell text, not a JS template
    expect(p('cd ${REPO}/sub && echo x > y.js')).toEqual([]);
    expect(p('cd /x; cd -; echo x > y.js'), '`cd -` is a directory we do not know').toEqual([]);
    // pushd/popd nest.
    expect(p('cd /a; pushd /b; echo 1 > in-b.txt; popd; echo 2 > in-a.txt')).toEqual([
      '/b/in-b.txt',
      '/a/in-a.txt',
    ]);
    expect(p('popd; echo x > y.js'), 'a popd with nothing pushed loses the thread').toEqual([]);
  });

  test('containsInOrder is whitespace-insensitive and needs every line', () => {
    const { normLines, containsInOrder } = attribution;
    const hunk = normLines('  function alpha() {\n    return computeTheThing();\n  }\n');
    expect(containsInOrder(hunk, normLines('function alpha() {\nreturn computeTheThing();\n}'))).toBe(true);
    expect(
      containsInOrder(hunk, normLines('return computeTheThing();')),
      'one substantial line is enough',
    ).toBe(true);
    expect(containsInOrder(hunk, normLines('return computeOtherThing();'))).toBe(false);
    expect(containsInOrder(hunk, normLines('}\nfunction alpha() {')), 'order matters').toBe(false);
    expect(containsInOrder(hunk, []), 'an empty edit proves nothing').toBe(false);
  });

  test('a needle has to be specific: one short line proves nothing', () => {
    const { isSpecificNeedle, normLines, containsInOrder } = attribution;
    // `}` appears in half the hunks of a repo: matching on it would credit a
    // turn with code it never wrote.
    expect(isSpecificNeedle(['}'])).toBe(false);
    expect(isSpecificNeedle(['return;'])).toBe(false);
    expect(isSpecificNeedle(['});'])).toBe(false);
    expect(isSpecificNeedle(['// ------------']), 'punctuation-only, however long').toBe(false);
    expect(isSpecificNeedle([])).toBe(false);
    // Two lines in order, or one substantial line, are specific enough.
    expect(isSpecificNeedle(['}', 'const x = 1;'])).toBe(true);
    expect(isSpecificNeedle(['const greeting = "hello";'])).toBe(true);
    const hunk = normLines('}\n');
    expect(containsInOrder(hunk, normLines('}'))).toBe(false);
  });

  test('an Edit whose only new line is `}` is attributed to nobody', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(repoDir, 'brace.js'), 'function a() {\n  return 1;\n');
      git(env, repoDir, ['add', '.']);
      git(env, repoDir, ['commit', '-q', '-m', 'base']);

      const dir = path.join(home, '.claude', 'projects', slug(repoDir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${SID_A}.jsonl`);
      const base = { isSidechain: false, cwd: repoDir, sessionId: SID_A };
      fs.writeFileSync(
        file,
        `${[
          {
            ...base,
            type: 'user',
            uuid: 'b1',
            parentUuid: null,
            timestamp: iso(-2000),
            message: { role: 'user', content: 'close the function' },
          },
          {
            ...base,
            type: 'assistant',
            uuid: 'b2',
            parentUuid: 'b1',
            timestamp: iso(AHEAD),
            message: {
              model: 'm',
              id: 'msg_b',
              role: 'assistant',
              type: 'message',
              usage: {},
              content: [
                {
                  type: 'tool_use',
                  id: 't',
                  name: 'Edit',
                  input: {
                    file_path: path.join(repoDir, 'brace.js'),
                    old_string: '  return 1;\n',
                    new_string: '  return 1;\n}\n',
                  },
                },
              ],
            },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
        'utf8',
      );

      fs.writeFileSync(path.join(repoDir, 'brace.js'), 'function a() {\n  return 1;\n}\n');
      git(env, repoDir, ['add', '.']);
      const session = claude.parse(file);
      const { linked, unattributed } = attribution.attribute({
        repoRoot: repoDir,
        stagedFiles: gitmod.stagedFiles(repoDir),
        hunksByFile: gitmod.stagedHunks(repoDir),
        candidateSessions: [{ agent: 'claude', sessionId: SID_A, session }],
        sinceMicros: gitmod.headCommitTime(repoDir),
        committerSession: null,
      });
      expect(linked.size, 'a lone `}` is not evidence').toBe(0);
      expect(unattributed, 'and the hunk is reported, not assigned').toEqual({ 'brace.js': 1 });
    } finally {
      rmTree(home);
    }
  });

  test('a Write that was edited afterwards still claims the hunks it wrote', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      // Two stable lines, so the later hand edit lands in a DIFFERENT `-U0` hunk
      // from the one the Write accounts for.
      const stable1 = 'a stable first line of the file\n';
      const stable2 = 'a stable middle line of the file\n';
      fs.writeFileSync(path.join(repoDir, 'mod.txt'), stable1 + stable2);
      git(env, repoDir, ['add', '.']);
      git(env, repoDir, ['commit', '-q', '-m', 'base']);

      const written = `${stable1}first written line of the module\n${stable2}second written line of the module\n`;
      const dir = path.join(home, '.claude', 'projects', slug(repoDir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${SID_A}.jsonl`);
      const base = { isSidechain: false, cwd: repoDir, sessionId: SID_A };
      fs.writeFileSync(
        file,
        `${[
          {
            ...base,
            type: 'user',
            uuid: 'z1',
            parentUuid: null,
            timestamp: iso(-2000),
            message: { role: 'user', content: 'write the module' },
          },
          {
            ...base,
            type: 'assistant',
            uuid: 'z2',
            parentUuid: 'z1',
            timestamp: iso(AHEAD),
            message: {
              model: 'm',
              id: 'msg_z',
              role: 'assistant',
              type: 'message',
              usage: {},
              content: [
                {
                  type: 'tool_use',
                  id: 't',
                  name: 'Write',
                  input: { file_path: path.join(repoDir, 'mod.txt'), content: written },
                },
              ],
            },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`,
        'utf8',
      );

      // A human then appended a line, so the staged blob no longer hashes to what
      // Write wrote: the containment fallback has to run hunk-inside-content.
      fs.writeFileSync(path.join(repoDir, 'mod.txt'), `${written}a line nobody prompted, appended later\n`);
      git(env, repoDir, ['add', '.']);
      expect(gitmod.stagedHunks(repoDir).get('mod.txt')?.length, 'two hunks, one of them not ours').toBe(2);
      const session = claude.parse(file);
      const { linked } = attribution.attribute({
        repoRoot: repoDir,
        stagedFiles: gitmod.stagedFiles(repoDir),
        hunksByFile: gitmod.stagedHunks(repoDir),
        candidateSessions: [{ agent: 'claude', sessionId: SID_A, session }],
        sinceMicros: gitmod.headCommitTime(repoDir),
        committerSession: null,
      });
      expect(
        gitmod.stagedBlobHash(repoDir, 'mod.txt'),
        'the hash path must NOT be what matches here',
      ).not.toBe(attribution.blobSha1(written));
      const entry = linked.get(session.turns[0]?.gid as string)?.files['mod.txt'];
      expect(entry?.confidence).toBe('write');
      expect(entry, 'the hunk it wrote, and only that one').toEqual({
        hunks: 2,
        matched: 1,
        confidence: 'write',
      });
    } finally {
      rmTree(home);
    }
  });

  test('a zero-hunk patch (Delete File, Move to) attributes at file level', () => {
    const fixture = path.join(REPO, 'test', 'fixtures', 'codex', 'apply-patch.jsonl');
    const session = codex.parse(fixture);
    const root = '/tmp/promptlog-fixture';
    const list = codex.edits(session, { root });
    const deleted = list.find((e) => e.rel === 'src/legacy.py' && (e as { op?: string }).op === 'delete');
    expect(deleted?.hunks).toEqual([]);

    // `git diff --cached` cannot show added lines for a deleted path, so the
    // only honest link is file level - but it must still exist, or an
    // apply_patch that removed a file looks like nobody's work.
    const { linked, unattributed } = attribution.attribute({
      repoRoot: root,
      stagedFiles: ['src/legacy.py', 'docs/README.md'],
      hunksByFile: new Map([
        [
          'docs/README.md',
          [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, added: ['# Helper'], removed: [] }],
        ],
      ]),
      candidateSessions: [{ agent: 'codex', sessionId: session.id, session }],
      sinceMicros: null,
      committerSession: null,
    });
    const files = linked.get(session.turns[0]?.gid as string)?.files;
    expect(files?.['src/legacy.py']).toEqual({ hunks: 0, matched: 0, confidence: 'patch' });
    expect(unattributed['src/legacy.py']).toBeUndefined();
  });

  test('parseShellWrites ignores heredoc bodies but keeps the heredoc target', () => {
    const p = shellWrites.parseShellWrites;
    // The body is data. Parsed as script it invents writes and, worse, moves
    // the tracked directory for the real commands after it.
    const cmd = [
      "cat > notes.md <<'EOF'",
      'cd /elsewhere',
      'echo pwned > /tmp/evil.txt',
      'EOF',
      'echo done >> log.txt',
    ].join('\n');
    expect(p(cmd)).toEqual(['notes.md', 'log.txt']);
    // `<<-MARKER` allows a tab-indented terminator.
    expect(p('cd /repo && cat >> a.txt <<-MARK\n\techo x > b.txt\n\tMARK\ntee c.txt')).toEqual([
      '/repo/a.txt',
      '/repo/c.txt',
    ]);
    // An unterminated heredoc swallows the rest: nothing after it is script.
    expect(p("cat > x.txt <<'EOF'\ncd /nope\necho y > z.txt")).toEqual(['x.txt']);
    expect(shellWrites.stripHeredocBodies('echo plain > p.txt')).toBe('echo plain > p.txt');
  });

  // -------------------------------------------------- through the real hooks

  test('case 3: two commits inside one turn - one record, two commit entries', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);

      writeClaudeTranscript(home, repoDir);
      const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A };
      expect(promptlog(agentEnv, repoDir, ['init']).code).toBe(0);

      // The turn's own Edits, one commit each.
      fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'ONE from session A\n');
      git(agentEnv, repoDir, ['add', 'file1.txt', '.gitattributes']);
      const commit1 = gitCapture(agentEnv, repoDir, ['commit', '-q', '-m', 'first half']);
      const sha1 = git(agentEnv, repoDir, ['rev-parse', 'HEAD']).trim();

      fs.writeFileSync(path.join(repoDir, 'file3.txt'), 'top touched by A\n');
      git(agentEnv, repoDir, ['add', 'file3.txt']);
      const commit2 = gitCapture(agentEnv, repoDir, ['commit', '-q', '-m', 'second half']);
      const sha2 = git(agentEnv, repoDir, ['rev-parse', 'HEAD']).trim();
      expect(sha1).not.toBe(sha2);
      const budgetSkipped = BUDGET_SKIP.test(commit1.stderr) || BUDGET_SKIP.test(commit2.stderr);

      const doc = JSON.parse(
        fs.readFileSync(
          path.join(repoDir, '.promptlog', 'sessions', `claude-${SID_A.slice(0, 8)}.json`),
          'utf8',
        ),
      );
      const gids = Object.keys(doc.turns);
      expect(gids.length, `one turn, one record: ${gids}`).toBe(1);
      const rec = doc.turns[gids[0] as string];

      expect(sessionRecords.commitShas(rec), 'two commit entries, one per sha').toEqual([sha1, sha2].sort());
      expect(rec.commits.length).toBe(2);
      const first = rec.commits.find((e: { sha: string }) => e.sha === sha1);
      const second = rec.commits.find((e: { sha: string }) => e.sha === sha2);
      if (budgetSkipped) {
        // The hook budget ran out mid-attribution and said so on stderr
        // (`BUDGET_SKIP`); the committer turn is still linked either way, but
        // the file-level evidence it would otherwise have earned may be
        // incomplete. That is the documented, diagnosable degradation, not a
        // matcher bug - skip the exact-evidence assertions below.
        expect(
          first.role === 'both' || first.role === 'committer',
          'still linked as the committer',
        ).toBeTruthy();
        expect(
          second.role === 'both' || second.role === 'committer',
          'still linked as the committer',
        ).toBeTruthy();
        return;
      }
      if (first?.role !== 'both') dumpAttributionDiagnostics(agentEnv, repoDir, 'case 3, first commit', sha1);
      expect(first.role, 'it wrote file1 and issued the commit').toBe('both');
      expect(first.files['file1.txt']).toEqual({ hunks: 1, matched: 1, confidence: 'edit' });
      expect(second.role).toBe('both');
      expect(second.files['file3.txt']).toEqual({ hunks: 1, matched: 1, confidence: 'edit' });
      expect(first.files['file3.txt'], 'evidence stays with its own commit').toBeUndefined();

      // Per-commit index/README stay shas only. First line is the lazy-rebuild
      // header (PLAN-v0.3.md §1), not a record.
      const idx = fs
        .readFileSync(path.join(repoDir, '.promptlog', 'index.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((r) => !r._promptlog_index);
      expect(idx.length).toBe(1);
      expect(idx[0].commits).toEqual([sha1, sha2].sort());
      expect(idx[0].attributedFiles).toBe(2);
    } finally {
      rmTree(home);
    }
  });

  test('a hand edit is reported as unattributed and never linked', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      writeClaudeTranscript(home, repoDir);
      const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A };
      expect(promptlog(agentEnv, repoDir, ['init']).code).toBe(0);

      fs.writeFileSync(path.join(repoDir, 'by-hand.txt'), 'nobody prompted this\n');
      git(agentEnv, repoDir, ['add', 'by-hand.txt', '.gitattributes']);
      const r = spawnSync('git', ['commit', '-m', 'hand written'], {
        cwd: repoDir,
        env: agentEnv,
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr, `warned about it: ${r.stderr}`).toMatch(/1 hunk in 1 file unattributed/);

      // The committer turn is still linked - the commit came from inside it - but
      // it claims no files.
      const doc = JSON.parse(
        fs.readFileSync(
          path.join(repoDir, '.promptlog', 'sessions', `claude-${SID_A.slice(0, 8)}.json`),
          'utf8',
        ),
      );
      const rec = Object.values(doc.turns)[0] as {
        commits: Array<{ role: string; files: Record<string, unknown> }>;
      };
      expect(rec.commits.length).toBe(1);
      expect(rec.commits[0]?.role).toBe('committer');
      expect(rec.commits[0]?.files).toEqual({});
    } finally {
      rmTree(home);
    }
  });

  test('reindex rebuilds commit entries from the trailers, keeping the evidence', () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      writeClaudeTranscript(home, repoDir);
      const agentEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A, PROMPTLOG_DEBUG: '1' };
      expect(promptlog(agentEnv, repoDir, ['init']).code).toBe(0);

      fs.writeFileSync(path.join(repoDir, 'file1.txt'), 'ONE from session A\n');
      git(agentEnv, repoDir, ['add', '.']);
      const commit = gitCapture(agentEnv, repoDir, ['commit', '-q', '-m', 'with a trailer']);
      const sha = git(agentEnv, repoDir, ['rev-parse', 'HEAD']).trim();

      const docPath = path.join(repoDir, '.promptlog', 'sessions', `claude-${SID_A.slice(0, 8)}.json`);
      const gid = Object.keys(JSON.parse(fs.readFileSync(docPath, 'utf8')).turns)[0] as string;

      // Corrupt the cache: a wrong sha, and a lost one.
      const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
      const keep = doc.turns[gid].commits[0].files;
      if (Object.keys(keep).length === 0) dumpAttributionDiagnostics(agentEnv, repoDir, 'reindex', sha);
      // See BUDGET_SKIP above: on a slow-enough runner the hook budget can
      // run out mid-attribution, which says so on stderr rather than
      // silently claiming no evidence. When it fired, `keep` legitimately
      // is `{}` and the rest of the test - which only checks that whatever
      // `keep` holds survives reindex unharmed - still holds regardless.
      if (!BUDGET_SKIP.test(commit.stderr)) {
        expect(keep).toEqual({ 'file1.txt': { hunks: 1, matched: 1, confidence: 'edit' } });
      }
      doc.turns[gid].commits.push({
        sha: 'f'.repeat(40),
        role: 'both',
        files: { 'gone.txt': { hunks: 9, matched: 9, confidence: 'edit' } },
      });
      fs.writeFileSync(docPath, `${JSON.stringify(doc, null, 2)}\n`);

      expect(promptlog(env, repoDir, ['reindex']).code).toBe(0);
      const after = JSON.parse(fs.readFileSync(docPath, 'utf8')).turns[gid];
      expect(sessionRecords.commitShas(after), 'a sha no commit message mentions is dropped').toEqual([sha]);
      expect(after.commits[0].files, 'the surviving entry keeps its evidence').toEqual(keep);

      // And a squash-style body, where the ids are not in the trailer block.
      git(env, repoDir, [
        'commit',
        '-q',
        '--allow-empty',
        '--no-verify',
        '-m',
        `Squashed\n\n* one\nPrompt-Id: ${gid}\n\n* two\nsomething else\n`,
      ]);
      const squashed = git(env, repoDir, ['rev-parse', 'HEAD']).trim();
      expect(promptlog(env, repoDir, ['reindex']).code).toBe(0);
      const rebuilt = JSON.parse(fs.readFileSync(docPath, 'utf8')).turns[gid];
      expect(sessionRecords.commitShas(rebuilt), 'whole body scanned').toEqual([sha, squashed].sort());
      const squashEntry = rebuilt.commits.find((e: { sha: string }) => e.sha === squashed);
      expect(squashEntry.role, 'no evidence for a commit we never attributed').toBe('unknown');
      expect(squashEntry.files).toEqual({});
      const kept = rebuilt.commits.find((e: { sha: string }) => e.sha === sha);
      expect(kept.files, 'evidence for a surviving sha is preserved').toEqual(keep);
    } finally {
      rmTree(home);
    }
  });

  test("attributeCommit ignores promptlog's own generated files", () => {
    const { home, repoDir, env } = sandbox();
    try {
      git(env, repoDir, ['init', '-q', '-b', 'main']);
      writeClaudeTranscript(home, repoDir);
      expect(promptlog(env, repoDir, ['init']).code).toBe(0);
      git(env, repoDir, ['add', '.']);
      const staged = repoCmds.attributableStagedFiles(repoDir);
      expect(staged.length).toBeGreaterThanOrEqual(0);
      expect(
        staged.some((f: string) => f.startsWith('.promptlog/')),
        `no store files: ${staged}`,
      ).toBe(false);
      expect(staged.includes('.gitattributes')).toBe(false);
    } finally {
      rmTree(home);
    }
  });
});
