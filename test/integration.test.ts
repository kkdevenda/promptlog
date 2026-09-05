/**
 * End-to-end, exactly the list in DESIGN.md "Testing bar":
 *
 *   temp git repo, HOME pointed at a temp dir holding a synthetic Claude
 *   transcript whose cwd is the repo, CLAUDE_CODE_SESSION_ID set, then
 *   `promptlog init` and a real `git commit`, asserting: trailers present,
 *   session doc written and staged in the same commit, index has the line,
 *   README contains gitGraph, `promptlog show <sha>` prints the prompt, a
 *   second commit in the same turn appends a sha to the same record with no
 *   duplicate, `git commit --amend` triggers the post-rewrite remap, a chained
 *   legacy hook runs, and a failing promptlog does not block the commit.
 *
 * Nothing here may touch the real ~/.gitconfig or ~/.promptlog: HOME,
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are all redirected into the temp dir.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { slug } from '../src/agents/claude/locate';
import { installHooks } from '../src/core/commands/hooks';
import * as recall from '../src/core/commands/recall';
import { canonicalPath } from '../src/core/fsutil';
import type { SessionDoc, TurnRecord } from '../src/core/records';
import type { IndexHeader } from '../src/core/storeIndex';
import * as storeIndex from '../src/core/storeIndex';
import type { Ctx } from '../src/core/util';
import { diag, rmTree, tmpDir } from './helpers';

const REPO = path.resolve(__dirname, '..');
const PROMPTLOG = path.join(REPO, 'bin', 'promptlog.js');
const SESSION_ID = 'c86e0429-3e3b-4f17-8262-35a6f0c85599';
const SID8 = SESSION_ID.slice(0, 8);

// -------------------------------------------------------------- scaffolding

/**
 * Copy `src` (a file or a directory) to `dest`, one file at a time via
 * `fs.mkdirSync`/`fs.copyFileSync` rather than a single `fs.cpSync(...,
 * {recursive:true})` call: kept explicit (and symlink-free - never followed,
 * never copied) for the awkward-checkout-path test below, where a directory
 * copy needs to be traceable file by file rather than trusted as one opaque
 * step.
 */
function copyEntry(src: string, dest: string): void {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyEntry(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function mkuuid(n: number): string {
  const hex = String(n).padStart(4, '0');
  return `${hex}aaaa-bbbb-cccc-dddd-${hex}eeeeeeee`;
}

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

/**
 * A synthetic Claude transcript with the same record shapes as the real ones:
 * a caveat record that must be skipped, two real prompts, assistant messages
 * carrying usage and tool_use blocks, and a compaction marker.
 *
 * The tool calls carry REAL payloads - `Write` its content, `Edit` its
 * old/new strings - because attribution links a turn only when it can be
 * shown to have written a staged hunk (PLAN-v0.3.md §3.1): turn 1 writes
 * `hello.txt` as `hello\n`, turn 2 appends `world of promptlog attribution`,
 * which is exactly what the two commits below stage. (A one-word line would
 * not do: a single short line is not specific enough to be evidence.)
 *
 * Both turns are still "running" (their last assistant record is in the
 * future) so that a second commit falls inside the same window, which is what
 * the append-a-sha assertion needs.
 */
function writeTranscript(
  dir: string,
  repoDir: string,
  { sessionId = SESSION_ID }: { sessionId?: string } = {},
): { file: string; projectDir: string; turnUuids: string[] } {
  const projectDir = path.join(dir, '.claude', 'projects', slug(repoDir));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);

  const base = {
    isSidechain: false,
    cwd: repoDir,
    sessionId,
    version: '2.1.257',
    gitBranch: 'main',
    userType: 'external',
  };
  const userRec = (
    uuid: string,
    parentUuid: string | null,
    content: string,
    tsMs: number,
    extra: Record<string, unknown> = {},
  ) => ({
    ...base,
    parentUuid,
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: iso(tsMs),
    ...extra,
  });
  const asstRec = (
    uuid: string,
    parentUuid: string,
    msgId: string,
    text: string,
    tsMs: number,
    tools: Array<{ name: string; input: Record<string, unknown> }> = [],
  ) => ({
    ...base,
    parentUuid,
    type: 'assistant',
    message: {
      model: 'claude-fable-5-1',
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...tools.map((t, i) => ({
          type: 'tool_use',
          id: `toolu_${msgId}_${i}`,
          name: t.name,
          input: t.input,
        })),
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 1200,
        cache_read_input_tokens: 900000,
        cache_creation_input_tokens: 3000,
      },
    },
    uuid,
    timestamp: iso(tsMs),
  });

  const records: unknown[] = [
    { type: 'mode', mode: 'normal', sessionId },
    // Skipped: local-command caveat + isMeta.
    userRec(mkuuid(1), null, '<local-command-caveat>Caveat: ignore me.</local-command-caveat>', -600000, {
      isMeta: true,
    }),
    // Skipped: a system reminder is not a typed prompt.
    userRec(mkuuid(2), mkuuid(1), '<system-reminder>not a prompt</system-reminder>', -599000),
    // Turn 1.
    userRec(mkuuid(3), mkuuid(2), 'write hello.txt with a greeting', -300000),
    asstRec(mkuuid(4), mkuuid(3), 'msg_int_001', 'Wrote the file.', 600000, [
      { name: 'Write', input: { file_path: path.join(repoDir, 'hello.txt'), content: 'hello\n' } },
    ]),
    // Defensive: compaction markers must be skipped, never seen locally.
    { type: 'summary', summary: 'compacted', leafUuid: mkuuid(4), sessionId },
    // Excluded by the relevance filter: a real prompt, but every file it
    // touched lives in another checkout. Deliberately NOT last, because the
    // last turn is the active turn and is exempt from that filter.
    userRec(mkuuid(9), mkuuid(4), 'rename the widget in the other project', -290000),
    asstRec(mkuuid(10), mkuuid(9), 'msg_int_004', 'Renamed.', 640000, [
      {
        name: 'Edit',
        input: {
          file_path: path.join(dir, 'other-checkout', 'widget.js'),
          old_string: 'const widget',
          new_string: 'const gadget',
        },
      },
    ]),
    // Excluded: a slash command is not a prompt about the code.
    userRec(
      mkuuid(7),
      mkuuid(10),
      '<command-name>/model</command-name>\n<command-message>model</command-message>',
      -280000,
    ),
    asstRec(mkuuid(8), mkuuid(7), 'msg_int_003', 'Switched model.', 630000, []),
    // Turn 2, the active turn.
    userRec(mkuuid(5), mkuuid(8), 'now add a second line', -270000),
    asstRec(mkuuid(6), mkuuid(5), 'msg_int_002', 'Added it.', 620000, [
      {
        name: 'Edit',
        input: {
          file_path: path.join(repoDir, 'hello.txt'),
          old_string: 'hello\n',
          new_string: 'hello\nworld of promptlog attribution\n',
        },
      },
    ]),
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return { file, projectDir, turnUuids: [mkuuid(3), mkuuid(5)] };
}

interface Sandbox {
  home: string;
  repoDir: string;
  env: NodeJS.ProcessEnv;
}

function sandbox(): Sandbox {
  const home = tmpDir('promptlog-e2e-');
  const repoDir = tmpDir('repo-', home);
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
    CLAUDE_CODE_SESSION_ID: SESSION_ID,
    NO_COLOR: '1',
  };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  fs.writeFileSync(
    env.GIT_CONFIG_GLOBAL as string,
    '[user]\n\tname = Test\n\temail = test@example.com\n',
    'utf8',
  );
  return { home, repoDir, env };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  { input }: { input?: string } = {},
): RunResult {
  const r: SpawnSyncReturns<string> = spawnSync('git', args, { cwd, env, input, encoding: 'utf8' });
  // A spawn failure (git not even found - e.g. PATH is missing its
  // directory) leaves `status` null and `stderr` empty: the informative part
  // is `r.error`, so fold it in rather than reporting a blank stderr.
  const stderr = r.stderr || (r.error ? String(r.error.stack || r.error) : '');
  return { code: r.status, stdout: r.stdout || '', stderr };
}

function gitOk(env: NodeJS.ProcessEnv, cwd: string, args: string[], opts?: { input?: string }): string {
  const r = git(env, cwd, args, opts);
  expect(r.code, `git ${args.join(' ')} failed (cwd=${cwd}): ${r.stderr}`).toBe(0);
  return r.stdout;
}

function promptlog(env: NodeJS.ProcessEnv, cwd: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [PROMPTLOG, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

interface IndexRow {
  gid: string;
  agent: string;
  session: string;
  ts: string;
  id: string;
  first: string;
  files: string[];
  commits: string[];
  attributedFiles: number;
  durationS: number;
  out: number;
  in: number;
}

/** Skips the `_promptlog_index` header line (PLAN-v0.3.md §1). */
function readIndex(repoDir: string): IndexRow[] {
  const p = path.join(repoDir, '.promptlog', 'index.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r): r is IndexRow => !('_promptlog_index' in r));
}

function readIndexHeader(repoDir: string): IndexHeader {
  const p = path.join(repoDir, '.promptlog', 'index.jsonl');
  const first = fs.readFileSync(p, 'utf8').split('\n')[0] as string;
  return JSON.parse(first);
}

/** Commit entries are `{sha, role, files}` now (PLAN-v0.3.md §3.5). */
function shas(rec: TurnRecord | undefined): string[] {
  return (rec?.commits ?? []).map((e) => e.sha);
}

function roleFor(rec: TurnRecord | undefined, sha: string): string | null {
  const e = (rec?.commits ?? []).find((c) => c.sha === sha);
  return e ? e.role : null;
}

function sessionDoc(repoDir: string): SessionDoc {
  const p = path.join(repoDir, '.promptlog', 'sessions', `claude-${SID8}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * `promptlog show <sha>` goes through the CLI's view layer, which merges the
 * transcript and repo sides. When that wiring did not print `hello.txt` (a
 * fresh checkout with no live transcript for this fixture, say) we still
 * verify the store handler that owns the repo half, calling it in-process.
 */
async function showSha(env: NodeJS.ProcessEnv, repoDir: string, sha: string): Promise<string> {
  const cli = promptlog(env, repoDir, ['show', sha, '--no-color']);
  if (cli.code === 0 && cli.stdout.includes('hello.txt')) return cli.stdout;
  const chunks: string[] = [];
  const ctx: Ctx = {
    cwd: repoDir,
    stdout: {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    stderr: process.stderr,
    env,
  };
  const code = await recall.show({ values: { 'no-color': true }, positionals: [sha] }, ctx);
  expect(code, `show ${sha} failed`).toBe(0);
  return chunks.join('') + cli.stdout;
}

// --------------------------------------------------------------- the test

test('per-repo install: commit, trailers, records, README, amend remap, chaining', async () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(git(env, repoDir, ['config', '--get', 'core.hooksPath']).code, 'core.hooksPath must be unset').toBe(
    1,
  );

  // A pre-existing post-commit hook that init has to rename and chain to.
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const witness = path.join(home, 'legacy-ran');
  fs.writeFileSync(path.join(hooksDir, 'post-commit'), `#!/bin/sh\necho ran >> "${witness}"\n`, 'utf8');
  fs.chmodSync(path.join(hooksDir, 'post-commit'), 0o755);

  // ---- init
  const init = promptlog(env, repoDir, ['init']);
  expect(init.code, `init failed: ${init.stderr}`).toBe(0);
  expect(fs.existsSync(path.join(repoDir, '.promptlog', 'config.json'))).toBe(true);
  expect(fs.existsSync(path.join(hooksDir, 'post-commit.legacy')), 'existing hook renamed to .legacy').toBe(
    true,
  );
  for (const name of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    const p = path.join(hooksDir, name);
    expect(fs.existsSync(p), `${name} installed`).toBe(true);
    // Windows has no execute-bit concept: chmod is a no-op there, and git
    // invokes the hook through its shebang line regardless of the mode bits.
    if (process.platform !== 'win32') {
      expect(fs.statSync(p).mode & 0o111, `${name} executable`).toBeTruthy();
    }
    expect(fs.readFileSync(p, 'utf8')).toMatch(/promptlog git hook dispatcher/);
  }
  expect(git(env, repoDir, ['config', '--get', 'promptlog.enabled']).stdout.trim()).toBe('true');
  const gitattrs = fs.readFileSync(path.join(repoDir, '.gitattributes'), 'utf8');
  expect(gitattrs, 'the index is no longer committed at all').not.toMatch(/index\.jsonl merge=union/);
  expect(gitattrs).toMatch(/\.promptlog\/sessions\/\*\.json merge=promptlog\b/);
  expect(gitattrs).toMatch(/\.promptlog\/README\.md merge=promptlog-readme/);
  expect(
    git(env, repoDir, ['config', '--get', 'merge.promptlog.driver']).code,
    'session merge driver registered',
  ).toBe(0);
  expect(
    git(env, repoDir, ['config', '--get', 'merge.promptlog-readme.driver']).code,
    'README merge driver registered',
  ).toBe(0);
  expect(fs.readFileSync(path.join(repoDir, '.promptlog', '.gitignore'), 'utf8')).toMatch(/^index\.jsonl$/m);

  // ---- first commit
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'hello\n', 'utf8');
  gitOk(env, repoDir, ['add', 'hello.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'add hello.txt']);
  const sha1 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();

  // trailers present, one per prompt
  const msg1 = gitOk(env, repoDir, ['log', '-1', '--format=%B']);
  const trailers = gitOk(env, repoDir, ['interpret-trailers', '--parse'], { input: msg1 })
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'))
    .map((l) => l.split(':').slice(1).join(':').trim());
  expect(trailers.length, `expected two trailers, got ${JSON.stringify(msg1)}`).toBe(2);
  for (const gid of trailers) expect(gid).toMatch(new RegExp(`^claude:${SID8}:[0-9a-f]{7}$`));

  // the session doc was staged into that very commit
  const tracked = gitOk(env, repoDir, ['show', '--pretty=format:', '--name-only', sha1])
    .split('\n')
    .map((s) => s.trim());
  expect(tracked, `session doc in commit: ${tracked}`).toContain(`.promptlog/sessions/claude-${SID8}.json`);
  expect(tracked, `index must never be committed: ${tracked}`).not.toContain('.promptlog/index.jsonl');
  expect(gitOk(env, repoDir, ['ls-files', '.promptlog/index.jsonl']).trim(), 'index is not tracked').toBe('');
  expect(
    readIndexHeader(repoDir).head,
    'the warm-cache header already matches HEAD after the hooks ran',
  ).toBe(sha1);

  // Slash commands and work done in another directory are never linked.
  expect(msg1).not.toMatch(/\/model/);
  const doc0 = sessionDoc(repoDir);
  const prompts0 = Object.values(doc0.turns).map((r) => r.prompt);
  expect(
    prompts0.some((t) => t.includes('<command-name>')),
    `no slash commands: ${prompts0}`,
  ).toBe(false);
  expect(
    prompts0.some((t) => t.includes('other project')),
    `no other-checkout turns: ${prompts0}`,
  ).toBe(false);
  expect(Object.values(doc0.turns).some((r) => r.isCommand)).toBe(false);

  // index + README
  const idx = readIndex(repoDir);
  expect(idx.length).toBe(2);
  expect(
    idx.some((r) => r.first === 'write hello.txt with a greeting'),
    JSON.stringify(idx),
  ).toBe(true);
  expect(idx.map((r) => r.gid).sort()).toEqual(trailers.slice().sort());
  const readme = fs.readFileSync(path.join(repoDir, '.promptlog', 'README.md'), 'utf8');
  expect(readme).toMatch(/gitGraph/);
  expect(readme).toMatch(/\| prompt \| time \| duration \| tokens \| first line \| commits \|/);

  // post-commit wrote the sha back into the records, and the legacy hook ran
  const doc1 = sessionDoc(repoDir);
  for (const gid of trailers) {
    expect(doc1.turns[gid], `record for ${gid}`).toBeTruthy();
    expect(shas(doc1.turns[gid]), `sha recorded for ${gid}`).toEqual([sha1]);
  }
  expect(fs.existsSync(witness), 'chained legacy post-commit hook ran').toBe(true);

  // README links the commit in a host-agnostic way
  const readme2 = fs.readFileSync(path.join(repoDir, '.promptlog', 'README.md'), 'utf8');
  expect(readme2.includes(`../../commit/${sha1}`), 'README links the commit').toBe(true);

  // `promptlog show <sha>` shows every prompt of that commit
  const shown = await showSha(env, repoDir, sha1);
  expect(shown).toMatch(/write hello\.txt with a greeting/);
  expect(shown).toMatch(/now add a second line/);
  expect(shown, 'show prints local YYYY-MM-DD HH:MM, not UTC ISO').toMatch(
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}/,
  );
  expect(shown, 'no UTC ISO timestamps').not.toMatch(/\d{2}:\d{2}:\d{2}\.\d+Z/);

  // ---- second commit inside the same turn: the sha is appended, not duplicated
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'hello\nworld of promptlog attribution\n', 'utf8');
  gitOk(env, repoDir, ['add', 'hello.txt']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'second line']);
  const sha2 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  expect(sha1).not.toBe(sha2);

  const doc2 = sessionDoc(repoDir);
  // The turn that drove both commits is the active one (it issued them, and
  // its Edit produced the second one's hunk); turn 1 wrote only the first
  // file, so it is a contributor to the first commit alone. That is the point
  // of evidence-based attribution: many commits, one prompt, but only where
  // the prompt actually did the work.
  const activeGid = trailers.find((g) => shas(doc2.turns[g]).length === 2);
  const active = activeGid ? doc2.turns[activeGid] : undefined;
  expect(
    active,
    `one record carries both shas: ${JSON.stringify(trailers.map((g) => shas(doc2.turns[g])))}`,
  ).toBeTruthy();
  expect(shas(active), 'both shas, set-unioned').toEqual([sha1, sha2].sort());
  expect(new Set(shas(active)).size, 'no duplicates').toBe(shas(active).length);
  expect(roleFor(active, sha2), 'it wrote the hunk and issued the commit').toBe('both');
  const firstOnlyGid = trailers.find((g) => shas(doc2.turns[g]).length === 1);
  const firstOnly = firstOnlyGid ? doc2.turns[firstOnlyGid] : undefined;
  expect(shas(firstOnly), 'the earlier turn keeps only the commit it wrote').toEqual([sha1]);
  expect(
    Object.keys((firstOnly as TurnRecord).commits[0]?.files ?? {}),
    'with its per-file evidence',
  ).toEqual(['hello.txt']);
  expect(
    (firstOnly as TurnRecord).commits[0]?.files['hello.txt'],
    'a Write is matched by the staged blob hash',
  ).toEqual({
    hunks: 1,
    matched: 1,
    confidence: 'write',
  });
  expect(Object.keys(doc2.turns).length, 'still two records, no duplicate turns').toBe(2);
  expect(readIndex(repoDir).length).toBe(2);

  // ---- amend: post-rewrite remaps the old sha to the new one
  gitOk(env, repoDir, ['commit', '-q', '--amend', '-m', 'second line, reworded']);
  const sha3 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  expect(sha2).not.toBe(sha3);
  const doc3 = sessionDoc(repoDir);
  const activeGid3 = trailers.find((g) => shas(doc3.turns[g]).length === 2) as string;
  const commits3 = shas(doc3.turns[activeGid3]);
  expect(commits3, `remapped to the new sha: ${commits3}`).toContain(sha3);
  expect(commits3, `old sha dropped: ${commits3}`).not.toContain(sha2);
  expect(commits3, 'the untouched sha survives').toContain(sha1);

  // ---- fail open: an unreadable transcript must not block a commit
  const { file } = writeTranscript(home, repoDir);
  fs.chmodSync(file, 0o000);
  onTestFinished(() => {
    try {
      fs.chmodSync(file, 0o644);
    } catch {
      /* ignore */
    }
  });
  fs.writeFileSync(path.join(repoDir, 'third.txt'), 'third\n', 'utf8');
  gitOk(env, repoDir, ['add', 'third.txt']);
  const broken = git(env, repoDir, ['commit', '-m', 'commit with an unreadable transcript']);
  expect(broken.code, `commit must not be blocked: ${broken.stderr}`).toBe(0);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%s']).trim()).toBe(
    'commit with an unreadable transcript',
  );
});

test('global install: --global sandboxes to a temp HOME and hooks still fire', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  const init = promptlog(env, repoDir, ['init', '--global']);
  expect(init.code, `init --global failed: ${init.stderr}`).toBe(0);

  const hookDir = path.join(home, '.promptlog', 'hooks');
  expect(gitOk(env, repoDir, ['config', '--global', '--get', 'core.hooksPath']).trim()).toBe(hookDir);
  // The real ~/.gitconfig and ~/.promptlog were never touched. Read the
  // value back through git itself (`--path`, so a relative value or a `~`
  // would be expanded the same way git expands it) rather than grepping the
  // raw config file: git escapes a backslash as `\\` in the ini format, so a
  // Windows path's separators come back doubled in the literal text and a
  // naive containment check never matches. `canonicalPath` on both sides
  // absorbs the one difference that is left, a `realpath`-only one.
  const configuredHooksPath = gitOk(env, repoDir, [
    'config',
    '--global',
    '--path',
    '--get',
    'core.hooksPath',
  ]).trim();
  expect(canonicalPath(configuredHooksPath)).toBe(canonicalPath(hookDir));
  expect(
    fs.existsSync(path.join(repoDir, '.git', 'hooks', 'prepare-commit-msg')),
    'no per-repo install',
  ).toBe(false);
  for (const name of ['prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    expect(fs.existsSync(path.join(hookDir, name)), `${name} in the global hook dir`).toBe(true);
  }

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'first commit under a global hooksPath']);
  const msg = gitOk(env, repoDir, ['log', '-1', '--format=%B']);
  expect(msg, `trailers under global hooks: ${JSON.stringify(msg)}`).toMatch(
    new RegExp(`Prompt-Id: claude:${SID8}:`),
  );
  // `a.txt` is nobody's edit, so only the committer turn is linked: one
  // record, not one per prompt in the window.
  expect(readIndex(repoDir).length).toBe(1);
  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const rec = sessionDoc(repoDir).turns[readIndex(repoDir)[0]?.gid as string];
  expect(shas(rec)).toEqual([sha]);
  expect(roleFor(rec, sha), 'it committed, it did not write a.txt').toBe('committer');
  expect((rec as TurnRecord).commits[0]?.files, 'and claims no files').toEqual({});
});

test('disable stops the hooks writing anything', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  expect(promptlog(env, repoDir, ['disable']).code).toBe(0);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'no promptlog here']);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%B'])).not.toMatch(/Prompt-Id/);
  expect(readIndex(repoDir).length).toBe(0);
});

test('sync / trailers / reindex / review work without committing', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  const tr = promptlog(env, repoDir, ['trailers']);
  expect(tr.code, tr.stderr).toBe(0);
  expect(tr.stdout.split('\n').filter(Boolean).length, tr.stdout).toBe(2);
  expect(tr.stdout).toMatch(/^Prompt-Id: claude:/);

  const sy = promptlog(env, repoDir, ['sync']);
  expect(sy.code, sy.stderr).toBe(0);
  expect(readIndex(repoDir).length).toBe(2);
  // Nothing was committed and nothing carries a sha yet.
  expect(git(env, repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']).code).toBe(1);
  for (const r of readIndex(repoDir)) expect(r.commits).toEqual([]);

  const rv = promptlog(env, repoDir, ['review']);
  expect(rv.code, rv.stderr).toBe(0);
  expect(rv.stdout).toMatch(/write hello\.txt with a greeting/);

  // reindex backfills shas from the git log trailers alone.
  gitOk(env, repoDir, ['add', '.']);
  const gid = readIndex(repoDir)[0]?.gid as string;
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', `manual\n\nPrompt-Id: ${gid}\n`]);
  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const ri = promptlog(env, repoDir, ['reindex']);
  expect(ri.code, ri.stderr).toBe(0);
  expect(shas(sessionDoc(repoDir).turns[gid]), 'rebuilt from the git log trailers').toEqual([sha]);
});

test('dispatcher runs once with a relative core.hooksPath, and the depth guard stops re-entry', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  // A pre-existing hook that counts its own runs; init renames it to .legacy
  // and the dispatcher chains to it exactly once per commit.
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const marker = path.join(home, 'runs');
  fs.writeFileSync(path.join(hooksDir, 'post-commit'), `#!/bin/sh\necho run >> "${marker}"\n`, 'utf8');
  fs.chmodSync(path.join(hooksDir, 'post-commit'), 0o755);

  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  // A RELATIVE hooks path: git now invokes the hook by a relative path, so the
  // dispatcher's self-check cannot be a plain string compare against
  // "$git_dir/hooks/<name>" or it chains to itself.
  gitOk(env, repoDir, ['config', 'core.hooksPath', '.git/hooks']);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'relative hooks path']);

  const runs = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length;
  expect(runs, `the dispatcher must not chain to itself (ran ${runs}x)`).toBe(1);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%B'])).toMatch(/Prompt-Id: claude:/);

  // The depth guard suppresses promptlog's OWN work but must never suppress
  // chaining: the user's hooks still run, exactly once, at any depth.
  fs.writeFileSync(marker, '', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'b\n', 'utf8');
  gitOk(env, repoDir, ['add', 'b.txt']);
  const nested = { ...env, PROMPTLOG_DISPATCH_DEPTH: '1' };
  gitOk(nested, repoDir, ['commit', '-q', '-m', 'already inside a dispatcher']);
  expect(
    fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length,
    'the chained hook still runs at depth >= 1',
  ).toBe(1);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%B']), 'but promptlog itself does nothing').not.toMatch(
    /Prompt-Id/,
  );
});

test.skipIf(process.platform === 'win32')(
  'an inherited stdin writer does not stall the commit (dispatcher reads stdin only when the hook takes it)',
  () => {
    // `mkfifo` has no reliable equivalent in Git for Windows' bash, and
    // `/bin/sh` does not exist on win32 at all: there is no portable way to
    // build the named-pipe timing rig this test needs there.
    const { home, repoDir, env } = sandbox();
    onTestFinished(() => rmTree(home));

    writeTranscript(home, repoDir);
    gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
    expect(promptlog(env, repoDir, ['init']).code).toBe(0);

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
    gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);

    // Give the commit a stdin whose writer stays alive for 3 s. A hook that
    // slurps stdin unconditionally blocks on `cat` until that writer closes.
    // A plain `sleep 3 | git commit` would not measure this: the shell waits for
    // every member of the pipeline, so it always takes 3 s. A fifo lets us time
    // `git commit` on its own.
    const script = [
      'set -e',
      'rm -f pl.fifo',
      'mkfifo pl.fifo',
      '( sleep 3 ) > pl.fifo 2>/dev/null &',
      'git commit -q -m "piped stdin" < pl.fifo',
      'rm -f pl.fifo',
    ].join('\n');
    const t0 = Date.now();
    const r = spawnSync('/bin/sh', ['-c', script], { cwd: repoDir, env, encoding: 'utf8' });
    const elapsed = Date.now() - t0;
    expect(r.status, `commit failed: ${r.stderr}`).toBe(0);
    expect(elapsed, `commit must not wait for the pipe writer (took ${elapsed}ms)`).toBeLessThan(1500);
    expect(gitOk(env, repoDir, ['log', '-1', '--format=%B'])).toMatch(/Prompt-Id: claude:/);

    // post-rewrite genuinely needs stdin, and still gets it.
    const sha1 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
    gitOk(env, repoDir, ['commit', '-q', '--amend', '-m', 'piped stdin, reworded']);
    const sha2 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
    const commits = shas(Object.values(sessionDoc(repoDir).turns)[0]);
    expect(commits.includes(sha2) && !commits.includes(sha1), `post-rewrite still ran: ${commits}`).toBe(
      true,
    );
  },
);

test('re-running init rotates, never deletes, a hook installed after us', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const marker = path.join(home, 'chain');
  const hook = (tag: string) => `#!/bin/sh\necho ${tag} >> "${marker}"\n`;

  // An original hook, then promptlog, then the user installs husky, then
  // promptlog init runs again (upgrade, or a second `init`).
  fs.writeFileSync(path.join(hooksDir, 'post-commit'), hook('original'), 'utf8');
  fs.chmodSync(path.join(hooksDir, 'post-commit'), 0o755);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  expect(fs.readFileSync(path.join(hooksDir, 'post-commit.legacy'), 'utf8')).toBe(hook('original'));

  fs.writeFileSync(path.join(hooksDir, 'post-commit'), hook('husky'), 'utf8');
  fs.chmodSync(path.join(hooksDir, 'post-commit'), 0o755);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  // Neither user hook was destroyed, and both still run - exactly once each.
  expect(fs.readFileSync(path.join(hooksDir, 'post-commit.legacy'), 'utf8')).toBe(hook('original'));
  expect(fs.readFileSync(path.join(hooksDir, 'post-commit.legacy.1'), 'utf8')).toBe(hook('husky'));
  expect(fs.readFileSync(path.join(hooksDir, 'post-commit'), 'utf8')).toMatch(
    /promptlog git hook dispatcher/,
  );

  // A third init must not rotate our own dispatcher into a .legacy slot.
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  expect(
    fs.existsSync(path.join(hooksDir, 'post-commit.legacy.2')),
    'our own hook is overwritten, not rotated',
  ).toBe(false);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'chain both legacy hooks']);
  expect(fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)).toEqual(['original', 'husky']);
});

test('an OLD sh dispatcher is rotated/overwritten correctly on re-init', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // A pre-upgrade install: the old shell dispatcher, with a chain dir baked
  // in from an earlier core.hooksPath takeover.
  const oldChainDir = path.join(home, 'old-chain-hooks');
  const oldSh = [
    '#!/bin/sh',
    '# promptlog git hook dispatcher.',
    "PROMPTLOG_JS='/some/old/checkout/promptlog.js'",
    `PROMPTLOG_CHAIN_DIR='${oldChainDir}'`,
    'exit 0',
    '',
  ].join('\n');
  for (const name of ['pre-commit', 'prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    fs.writeFileSync(path.join(hooksDir, name), oldSh, 'utf8');
    fs.chmodSync(path.join(hooksDir, name), 0o755);
  }

  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  for (const name of ['pre-commit', 'prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    const file = path.join(hooksDir, name);
    // Overwritten in place, not rotated: the shared marker phrase recognizes
    // it as OUR (old-format) dispatcher.
    expect(fs.existsSync(`${file}.legacy`), `${name}.legacy must not exist`).toBe(false);
    const body = fs.readFileSync(file, 'utf8');
    expect(body, `${name} is the new Node format`).toMatch(/^#!\/usr\/bin\/env node/);
    expect(body).toMatch(/promptlog git hook dispatcher/);
    // The chain dir baked into the OLD sh dispatcher is carried forward.
    expect(body, `${name} carries forward the old chain dir`).toContain(chainDirLiteral(oldChainDir));
  }

  const msg = commitFile(env, repoDir, 'a.txt', 'upgraded from the old sh dispatcher');
  expect(msg).toMatch(new RegExp(`Prompt-Id: claude:${SID8}:`));
});

test('promptlog.amend=true leaves no stale sha behind', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  gitOk(env, repoDir, ['config', 'promptlog.amend', 'true']);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);
  // Not gitOk: the post-commit hook's `promptlog:` stderr lines are the one
  // thing that can say WHY the amend below did not happen (e.g. the hook
  // budget ran out before it got there), and git itself still exits 0
  // whatever that hook did (promptlog fails open) - so capture them here
  // rather than losing them to a passing exit-code assertion.
  const commit = git(env, repoDir, ['commit', '-q', '-m', 'amend mode']);
  expect(commit.code, `git commit failed (cwd=${repoDir}): ${commit.stderr}`).toBe(0);

  const head = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  for (const [gid, rec] of Object.entries(sessionDoc(repoDir).turns)) {
    expect(
      shas(rec),
      `${gid} must point at the amended HEAD, not the pre-amend sha: ${JSON.stringify(rec.commits)}\n` +
        `post-commit hook stderr:\n${commit.stderr}`,
    ).toEqual([head]);
  }
  // The index agrees, and every recorded sha is a real commit.
  for (const row of readIndex(repoDir)) {
    for (const sha of row.commits) {
      expect(git(env, repoDir, ['cat-file', '-e', `${sha}^{commit}`]).code, `${sha} exists`).toBe(0);
    }
  }
});

test('a pending gid list never leaks into another commit', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'first']);

  const pending = path.join(repoDir, '.git', 'promptlog-pending');
  expect(fs.existsSync(pending), 'consumed by prepare-commit-msg').toBe(false);

  // Forge a pending file computed against a DIFFERENT head, as an aborted or
  // interrupted commit would leave behind, then commit with --no-verify (which
  // skips pre-commit, so prepare-commit-msg is the only thing that sees it).
  fs.writeFileSync(
    pending,
    JSON.stringify({ at: Date.now(), head: 'f'.repeat(40), gids: ['claude:deadbeef:9999999'] }),
    'utf8',
  );
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'b\n', 'utf8');
  gitOk(env, repoDir, ['add', 'b.txt']);
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'second']);

  const msg = gitOk(env, repoDir, ['log', '-1', '--format=%B']);
  expect(msg, 'a stale pending list must be rejected by its head key').not.toMatch(/9999999/);
  expect(fs.existsSync(pending), 'and always consumed').toBe(false);
});

test('amend widens the window instead of emptying it', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  // A first commit with no promptlog involvement, so HEAD^ exists.
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
  gitOk(env, repoDir, ['add', 'base.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'base']);

  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'work']);
  const trailersBefore = gitOk(env, repoDir, ['log', '-1', '--format=%B'])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  // `a.txt` matches no edit, so the committer turn is the only link.
  expect(trailersBefore.length).toBe(1);

  // Amending must keep those trailers: with `since` = HEAD's own time the
  // window is empty and they would all be dropped. `--amend -m` is the hard
  // case: it reports source "message" with no sha, exactly like a plain
  // `commit -m`, and it REPLACES the message, so the trailers are not in the
  // message file either.
  gitOk(env, repoDir, ['commit', '-q', '--amend', '-m', 'work, reworded']);
  const trailersAfter = gitOk(env, repoDir, ['log', '-1', '--format=%B'])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  expect(trailersAfter.sort(), 'amend -m keeps every trailer').toEqual(trailersBefore.slice().sort());

  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  for (const rec of Object.values(sessionDoc(repoDir).turns)) {
    expect(shas(rec), `record follows the amended sha: ${shas(rec)}`).toContain(sha);
  }

  // `--amend --no-edit` reports source "commit" with the literal "HEAD".
  gitOk(env, repoDir, ['commit', '-q', '--amend', '--no-edit']);
  const afterNoEdit = gitOk(env, repoDir, ['log', '-1', '--format=%B'])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  expect(afterNoEdit.sort(), 'amend --no-edit keeps every trailer').toEqual(trailersBefore.slice().sort());

  // `-C <commit>` names ANOTHER commit: its message and trailers are reused
  // verbatim and promptlog must not touch them.
  const base = gitOk(env, repoDir, ['rev-parse', 'HEAD~1']).trim();
  fs.writeFileSync(path.join(repoDir, 'c.txt'), 'c\n', 'utf8');
  gitOk(env, repoDir, ['add', 'c.txt']);
  gitOk(env, repoDir, ['commit', '-q', '-C', base]);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%s']).trim()).toBe('base');
  const baseTrailers = gitOk(env, repoDir, ['log', '-1', '--format=%B', base])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  const reused = gitOk(env, repoDir, ['log', '-1', '--format=%B'])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  expect(reused, 'a -C message is reused verbatim: promptlog adds nothing of its own').toEqual(baseTrailers);
});

test('pathspec commits are skipped and an aborted commit is carried into the next one', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
  gitOk(env, repoDir, ['add', 'seed.txt', '.gitattributes']);
  // A normal commit, so the store starts out committed with nothing staged.
  // (Unstaged drift IS expected afterwards: post-commit writes the sha into
  // the records, which with promptlog.amend=false lands in the next commit.)
  gitOk(env, repoDir, ['commit', '-q', '-m', 'seed']);
  const staged = () => gitOk(env, repoDir, ['diff', '--cached', '--name-only', '--', '.promptlog']).trim();
  expect(staged(), 'nothing staged after a normal commit').toBe('');

  // ---- a pathspec commit builds a temp index: stage nothing, add nothing.
  // (`git commit -- <path>` needs a tracked path, so modify the seed file.)
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n', 'utf8');
  gitOk(env, repoDir, ['commit', '-q', '-m', 'pathspec commit', '--', 'seed.txt']);
  const pathspecFiles = gitOk(env, repoDir, ['show', '--pretty=format:', '--name-only', 'HEAD'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(pathspecFiles, 'only the named path is committed').toEqual(['seed.txt']);
  expect(gitOk(env, repoDir, ['log', '-1', '--format=%B'])).not.toMatch(/Prompt-Id/);
  expect(staged(), 'a pathspec commit must stage nothing into the real index').toBe('');

  // ---- an aborted commit: pre-commit already wrote and staged the records.
  fs.writeFileSync(path.join(repoDir, 'q.txt'), 'q\n', 'utf8');
  gitOk(env, repoDir, ['add', 'q.txt']);
  const aborted = git({ ...env, GIT_EDITOR: 'false' }, repoDir, ['commit']);
  expect(aborted.code, 'the commit really was aborted').not.toBe(0);
  expect(staged(), 'pre-commit had already staged the records').not.toBe('');
  expect(
    Object.values(sessionDoc(repoDir).turns).length,
    'records were written by pre-commit',
  ).toBeGreaterThan(0);

  // The NEXT commit still links them, so the abort loses nothing.
  gitOk(env, repoDir, ['commit', '-q', '-m', 'after the abort']);
  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const after = Object.values(sessionDoc(repoDir).turns);
  expect(after.length).toBeGreaterThan(0);
  for (const rec of after) {
    expect(shas(rec), `linked to the commit after the abort: ${shas(rec)}`).toContain(sha);
  }
  expect(staged(), 'and nothing is left staged').toBe('');
});

test('records orphaned by an aborted FIRST commit are carried into the next one', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
  gitOk(env, repoDir, ['add', 'a.txt', '.gitattributes']);

  // Abort the very first commit: pre-commit has written and staged records
  // that no commit will ever reference, and post-commit never runs.
  const aborted = git({ ...env, GIT_EDITOR: 'false' }, repoDir, ['commit']);
  expect(aborted.code, 'the commit really was aborted').not.toBe(0);
  const orphans = Object.values(sessionDoc(repoDir).turns);
  expect(orphans.length, 'records exist').toBeGreaterThan(0);
  expect(
    orphans.every((r) => r.commits.length === 0),
    `truly orphaned: ${JSON.stringify(orphans.map((r) => r.commits))}`,
  ).toBe(true);

  // The next commit adopts them: same records, now with a sha and a trailer.
  gitOk(env, repoDir, ['commit', '-q', '-m', 'first commit, second attempt']);
  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const adopted = sessionDoc(repoDir).turns;
  expect(Object.keys(adopted).length, 'no duplicate records').toBe(orphans.length);
  for (const [gid, rec] of Object.entries(adopted)) {
    expect(shas(rec), `${gid} adopted: ${JSON.stringify(rec.commits)}`).toEqual([sha]);
  }
  const trailers = gitOk(env, repoDir, ['log', '-1', '--format=%B'])
    .split('\n')
    .filter((l) => l.startsWith('Prompt-Id:'));
  expect(trailers.length, 'every adopted record got a trailer').toBe(Object.keys(adopted).length);
});

/**
 * A transcript whose last turn HAS assistant text - the realistic case, since
 * agents narrate between tool calls, so the parser's `responsePending` is
 * false. Active-ness must therefore come from how the session was identified,
 * not from "has the agent said anything yet".
 *
 * The turn touches no files, so the relevance filter keeps it.
 */
function writeActiveTranscript(
  dir: string,
  repoDir: string,
  {
    sessionId = SESSION_ID,
    otherCheckout = null,
  }: { sessionId?: string; otherCheckout?: string | null } = {},
): { file: string; base: Record<string, unknown>; gidSuffix: string } {
  const projectDir = path.join(dir, '.claude', 'projects', slug(repoDir));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  const base = {
    isSidechain: false,
    cwd: repoDir,
    sessionId,
    version: '2.1.257',
    gitBranch: 'main',
    userType: 'external',
  };
  const records: unknown[] = [
    { type: 'mode', mode: 'normal', sessionId },
    {
      ...base,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'commit this for me, three times' },
      uuid: mkuuid(21),
      timestamp: iso(-120000),
    },
    // Mid-turn narration between tool calls: text exists, the turn is NOT over.
    {
      ...base,
      parentUuid: mkuuid(21),
      type: 'assistant',
      uuid: mkuuid(22),
      timestamp: iso(-110000),
      message: {
        model: 'claude-fable-5-1',
        id: 'msg_active_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me commit that.' },
          // Every file this turn touched is in ANOTHER checkout. The relevance
          // filter would drop it, but the active turn is exempt: the commit is
          // being issued from inside this very turn.
          ...(otherCheckout
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_other',
                  name: 'Edit',
                  input: { file_path: path.join(otherCheckout, 'other-checkout', 'thing.js') },
                },
              ]
            : []),
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 40,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    },
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return { file, base, gidSuffix: mkuuid(21).slice(0, 7) };
}

test('rapid successive commits all carry the active turn (env-identified session)', async () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  const { file, base, gidSuffix } = writeActiveTranscript(home, repoDir, { otherCheckout: home });
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  // The parser sees assistant text, so responsePending is false: proof that
  // "has assistant text" cannot be the in-progress signal.
  const parsed = JSON.parse(promptlog(env, repoDir, ['json']).stdout);
  const lastParsed = parsed.turns[parsed.turns.length - 1];
  expect(lastParsed.response_pending, 'the parser considers it answered').toBe(false);
  expect(
    lastParsed.files.map((f: string) => path.basename(f)),
    'and every file it touched is outside this repo',
  ).toEqual(['thing.js']);

  const gid = `claude:${SID8}:${gidSuffix}`;
  const trailersOf = () =>
    gitOk(env, repoDir, ['log', '-1', '--format=%B'])
      .split('\n')
      .filter((l) => l.startsWith('Prompt-Id:'));

  // Three commits back to back. Before the fix the first carried the turn and
  // every later one carried nothing: the first commit's committer date became
  // `since`, and the turn's stale window end fell before it.
  const allShas: string[] = [];
  for (const [i, name] of ['one', 'two', 'three'].entries()) {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `${name}\n`, 'utf8');
    gitOk(env, repoDir, ['add', '-A']);
    gitOk(env, repoDir, ['commit', '-q', '-m', name]);
    allShas.push(gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim());
    expect(trailersOf(), `commit "${name}" must carry the active turn`).toEqual([`Prompt-Id: ${gid}`]);
  }

  // One record accumulating all three shas: many commits, one prompt.
  const turns = sessionDoc(repoDir).turns;
  expect(Object.keys(turns), 'no duplicate records').toEqual([gid]);
  expect(shas(turns[gid]), `all three shas: ${shas(turns[gid])}`).toEqual(allShas.slice().sort());
  expect(readIndex(repoDir).length).toBe(1);

  // The active turn's response is NOT stored: the narration is not the answer.
  expect(turns[gid]?.response, 'no mid-turn narration stored as the response').toBe(null);
  expect(turns[gid]?.responsePending, 'pending is derived from active-ness').toBe(true);
  expect(turns[gid]?.origin.responseHash).toBe(null);

  // The turn finishes: append its final assistant text. Once the session is no
  // longer identified from the env var and the transcript predates the last
  // commit, the turn is no longer active and `sync` backfills the response.
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ...base,
      parentUuid: mkuuid(22),
      type: 'assistant',
      uuid: mkuuid(23),
      timestamp: iso(-100000),
      message: {
        model: 'claude-fable-5-1',
        id: 'msg_active_2',
        type: 'message',
        role: 'assistant',
        // By the time it finishes, the turn has also touched this repo, so it
        // passes the relevance filter on its own once it stops being active.
        content: [
          { type: 'text', text: 'Committed all three.' },
          {
            type: 'tool_use',
            id: 'toolu_here',
            name: 'Edit',
            input: { file_path: path.join(repoDir, 'f0.txt') },
          },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 90,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    })}\n`,
    'utf8',
  );
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(file, old, old);
  const plainEnv = { ...env };
  delete plainEnv.CLAUDE_CODE_SESSION_ID;

  // `--all` widens the window to the whole session (the turn itself ended
  // before the last commit), and neither active-ness signal applies: not
  // env-identified, and the transcript predates that commit.
  const sy = promptlog(plainEnv, repoDir, ['sync', '--all', '--session', file]);
  expect(sy.code, sy.stderr).toBe(0);
  const after = sessionDoc(repoDir).turns[gid] as TurnRecord;
  expect(after.response, 'the response is backfilled').toBe('Committed all three.');
  expect(after.responsePending).toBe(false);
  expect(after.origin.responseHash, 'and hashed').toBeTruthy();
  // The backfill never loses the commit links.
  expect(shas(after)).toEqual(allShas.slice().sort());
});

test('a pathspec commit leaves .promptlog untouched, even with a stale pending file', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
  gitOk(env, repoDir, ['add', '-A']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'seed']);
  // Settle the post-commit sha write so the tree is genuinely clean. promptlog
  // has to be off while we do it, or each settling commit writes records of its
  // own (--no-verify skips pre-commit but not prepare-commit-msg).
  expect(promptlog(env, repoDir, ['disable']).code).toBe(0);
  gitOk(env, repoDir, ['add', '-A']);
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'settle']);
  expect(promptlog(env, repoDir, ['enable']).code).toBe(0);
  gitOk(env, repoDir, ['add', '-A']);
  if (gitOk(env, repoDir, ['status', '--porcelain']).trim()) {
    expect(promptlog(env, repoDir, ['disable']).code).toBe(0);
    gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'settle 2']);
    expect(promptlog(env, repoDir, ['enable']).code).toBe(0);
  }
  expect(
    gitOk(env, repoDir, ['status', '--porcelain', '--', '.promptlog']).trim(),
    'the store starts clean',
  ).toBe('');

  // A leftover pending file makes prepare-commit-msg take its non-fallback
  // path, which used to bypass the temp-index check entirely.
  fs.writeFileSync(
    path.join(repoDir, '.git', 'promptlog-pending'),
    JSON.stringify({
      at: Date.now(),
      head: gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim(),
      gids: ['claude:deadbeef:1234567'],
    }),
    'utf8',
  );

  fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed changed\n', 'utf8');
  gitOk(env, repoDir, ['commit', '-q', '-m', 'pathspec', '--', 'seed.txt']);

  const status = gitOk(env, repoDir, ['status', '--porcelain', '--', '.promptlog']).trim();
  expect(status, `a pathspec commit must not touch .promptlog, got: ${status}`).toBe('');
  expect(
    gitOk(env, repoDir, ['show', '--pretty=format:', '--name-only', 'HEAD'])
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
    'only the named path is committed',
  ).toEqual(['seed.txt']);
  expect(
    gitOk(env, repoDir, ['log', '-1', '--format=%B']),
    'and no trailer is added for records that were never staged',
  ).not.toMatch(/Prompt-Id/);
});

test('git commit -am gets its trailers (index.lock is not a partial commit)', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'seed\n', 'utf8');
  gitOk(env, repoDir, ['add', 'hello.txt', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'seed']);

  // `git commit -a` points GIT_INDEX_FILE at $GIT_DIR/index.lock and renames
  // it into place. Treating that as a temporary index (as a pathspec commit's
  // next-index-*.lock really is) cost every `commit -am` its trailers AND its
  // records.
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'hello\n', 'utf8');
  gitOk(env, repoDir, ['commit', '-qam', 'commit -am with no explicit add']);

  const msg = gitOk(env, repoDir, ['log', '-1', '--format=%B']);
  expect(msg, `trailers for commit -am: ${JSON.stringify(msg)}`).toMatch(
    new RegExp(`Prompt-Id: claude:${SID8}:`),
  );
  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const tracked = gitOk(env, repoDir, ['show', '--pretty=format:', '--name-only', sha])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(tracked, `the records land in that very commit: ${tracked}`).toContain(
    `.promptlog/sessions/claude-${SID8}.json`,
  );
  const rec = Object.values(sessionDoc(repoDir).turns).find((r) => shas(r).includes(sha));
  expect(rec, 'and carry the sha').toBeTruthy();
});

test("a commit never stages the user's own .gitattributes edits", () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  // Commit init's own .gitattributes lines first, so the file is clean.
  gitOk(env, repoDir, ['add', '-A']);
  gitOk(env, repoDir, ['commit', '-q', '--no-verify', '-m', 'seed']);

  // The user starts an unrelated .gitattributes change and does NOT stage it.
  const attrs = path.join(repoDir, '.gitattributes');
  fs.appendFileSync(attrs, '*.psd binary\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'hello\n', 'utf8');
  gitOk(env, repoDir, ['add', 'hello.txt']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'unrelated work']);

  const sha = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const tracked = gitOk(env, repoDir, ['show', '--pretty=format:', '--name-only', sha])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(
    tracked,
    `promptlog changed nothing in .gitattributes, so it must not stage it: ${tracked}`,
  ).not.toContain('.gitattributes');
  expect(
    gitOk(env, repoDir, ['status', '--porcelain', '--', '.gitattributes']),
    "the edit is still the user's, unstaged",
  ).toMatch(/^ M/);
});

test('the trailer scan is cached and stays correct across a rewrite', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'hello\n', 'utf8');
  gitOk(env, repoDir, ['add', '-A']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'first']);

  const cache = path.join(repoDir, '.promptlog', '.cache', 'trailers.json');
  expect(fs.existsSync(cache), 'the scan is cached after a commit').toBe(true);
  expect(
    git(env, repoDir, ['check-ignore', '.promptlog/.cache/trailers.json']).code,
    'and the cache is gitignored, so it can never be committed',
  ).toBe(0);

  const sha1 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const first = storeIndex.trailerIndex(repoDir);
  expect(first?.cached, 'refs unchanged: no git log at all').toBe(true);
  const gid = Object.keys(sessionDoc(repoDir).turns)[0] as string;
  expect((first?.byGid.get(gid) ?? []).includes(sha1), 'and it knows this commit').toBe(true);

  // A new commit moves the ref forward: incremental scan, same answer.
  fs.writeFileSync(path.join(repoDir, 'second.txt'), 'second\n', 'utf8');
  gitOk(env, repoDir, ['add', '-A']);
  gitOk(env, repoDir, ['commit', '-q', '-m', 'second']);
  const sha2 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const second = storeIndex.trailerIndex(repoDir);
  const allShasIn = (scan: NonNullable<typeof second>) => Array.from(scan.byGid.values()).flat();
  expect(allShasIn(second as NonNullable<typeof second>), 'the cached half survives').toContain(sha1);
  expect(
    allShasIn(second as NonNullable<typeof second>),
    'the new commit is scanned incrementally',
  ).toContain(sha2);

  // An amend REWRITES the head: the cached shas are no longer all reachable,
  // so the scan must fall back to a full one and drop the old sha.
  gitOk(env, repoDir, ['commit', '-q', '--amend', '-m', 'second, reworded']);
  const sha3 = gitOk(env, repoDir, ['rev-parse', 'HEAD']).trim();
  const third = storeIndex.trailerIndex(repoDir);
  const shasNow = Array.from((third as NonNullable<typeof third>).byGid.values()).flat();
  expect(shasNow, `the new sha is there: ${shasNow}`).toContain(sha3);
  expect(shasNow, `the rewritten sha is gone: ${shasNow}`).not.toContain(sha2);

  // A corrupt cache costs one full scan, never a wrong answer.
  fs.writeFileSync(cache, 'not json', 'utf8');
  const fourth = storeIndex.trailerIndex(repoDir);
  expect(fourth?.cached).toBe(false);
  expect(Array.from((fourth as NonNullable<typeof fourth>).byGid.values()).flat()).toContain(sha3);
});

// ------------------------------------------------- hook paths and quoting

/** Lines a marker hook appended, one per run. */
function runsOf(marker: string): string[] {
  return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [];
}

/**
 * The literal source snippet a generated hook file bakes `chainDir` as (see
 * `hookBody()` in `src/core/commands/hooks.ts`): the `const chainDir = ...;`
 * line, JSON-stringified.
 */
function chainDirLiteral(chainDir: string): string {
  return `const chainDir = ${JSON.stringify(chainDir)};`;
}

/** The literal source snippet a generated hook file bakes the entry point
 * path as: the `const bakedPath = ...;` line. */
function requireLiteral(entryPath: string): string {
  return `const bakedPath = ${JSON.stringify(entryPath)};`;
}

function writeMarkerHook(file: string, marker: string, tag = 'ran'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho ${tag} >> "${marker}"\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function commitFile(env: NodeJS.ProcessEnv, repoDir: string, name: string, subject: string): string {
  fs.writeFileSync(path.join(repoDir, name), `${name}\n`, 'utf8');
  gitOk(env, repoDir, ['add', name]);
  if (fs.existsSync(path.join(repoDir, '.gitattributes'))) gitOk(env, repoDir, ['add', '.gitattributes']);
  gitOk(env, repoDir, ['commit', '-q', '-m', subject]);
  return gitOk(env, repoDir, ['log', '-1', '--format=%B']);
}

test('a checkout path with an apostrophe, a space and a non-ASCII char still yields valid, working hooks', () => {
  const { home, env } = sandbox();
  onTestFinished(() => rmTree(home));

  // The baked entry point is promptlog's OWN entry point, so the checkout
  // itself has to live at the awkward path: copy the zero-dependency tree
  // (the bin shim plus the packed skill it points at) there and run init from
  // the copy. The repo gets an awkward path too.
  const odd = path.join(home, "o'brien café x");
  const checkout = path.join(odd, 'promptlog');
  fs.mkdirSync(checkout, { recursive: true });
  for (const part of ['bin', path.join('skills', 'promptlog', 'scripts'), 'package.json']) {
    copyEntry(path.join(REPO, part), path.join(checkout, part));
  }

  // The copy must be COMPLETE before `init` ever runs from it - a partial
  // copy (e.g. a path-length limit silently dropping a deep file on
  // Windows) shows up there only as `require`'s own unhelpful "Cannot find
  // module", with nothing to say why. Check the two files `bin/promptlog.js`
  // actually needs and list the whole tree when either is missing.
  const binEntry = path.join(checkout, 'bin', 'promptlog.js');
  const bundledEntry = path.join(checkout, 'skills', 'promptlog', 'scripts', 'promptlog.js');
  const listCheckout = (): string => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else out.push(full);
      }
    };
    walk(checkout);
    return out.join('\n');
  };
  expect(fs.existsSync(binEntry), `bin/promptlog.js missing after copy:\n${listCheckout()}`).toBe(true);
  expect(
    fs.existsSync(bundledEntry),
    `skills/promptlog/scripts/promptlog.js missing after copy:\n${listCheckout()}`,
  ).toBe(true);

  const repoDir = tmpDir('repo-', odd);
  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  const init = spawnSync(process.execPath, [binEntry, 'init'], {
    cwd: repoDir,
    env,
    encoding: 'utf8',
  });
  expect(init.status, `init failed (stdout=${JSON.stringify(init.stdout)}): ${init.stderr}`).toBe(0);

  const hooksDir = path.join(repoDir, '.git', 'hooks');
  // node resolves the running module's real path (macOS: /var -> /private/var).
  const expectEntry = path.join(fs.realpathSync(checkout), 'skills', 'promptlog', 'scripts', 'promptlog.js');
  for (const name of ['pre-commit', 'prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    const file = path.join(hooksDir, name);
    const lint = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    expect(lint.status, `${name} is not valid JS: ${lint.stderr}`).toBe(0);
    const body = fs.readFileSync(file, 'utf8');
    expect(body, `${name} bakes the entry point`).toContain(requireLiteral(expectEntry));
    expect(body, `${name} bakes an empty chain dir`).toContain(chainDirLiteral(''));
  }

  const msg = commitFile(env, repoDir, 'a.txt', 'commit from an awkward path');
  expect(msg, `trailers present: ${JSON.stringify(msg)}`).toMatch(new RegExp(`Prompt-Id: claude:${SID8}:`));
  expect(
    fs.existsSync(path.join(repoDir, '.promptlog', 'sessions', `claude-${SID8}.json`)),
    'record written',
  ).toBe(true);
});

test('doctor warns when a hook file’s baked promptlog.js path is missing', async () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  // Simulate a moved / uninstalled promptlog: the baked path is gone. The
  // hook file fails open (DESIGN.md "Hooks", "Missing baked path") rather
  // than throwing, but a moved checkout is still worth surfacing proactively
  // - `doctor` is what does that.
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  const gone = path.join(home, "no such dir 'here'", 'promptlog.js');
  for (const name of ['pre-commit', 'prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    const file = path.join(hooksDir, name);
    const body = fs.readFileSync(file, 'utf8').replace(/^const bakedPath = .*;\s*$/m, requireLiteral(gone));
    fs.writeFileSync(file, body, 'utf8');
    expect(spawnSync(process.execPath, ['--check', file]).status, `${name} still valid JS`).toBe(0);
  }

  const doc = promptlog(env, repoDir, ['doctor', '--json']);
  expect(doc.code, doc.stderr).toBe(0);
  const info = JSON.parse(doc.stdout) as { hookWarnings: string[] };
  expect(info.hookWarnings.length, JSON.stringify(info.hookWarnings)).toBe(4);
  for (const w of info.hookWarnings) expect(w).toContain('baked promptlog.js is missing');
});

test('generated hook body: an empty PATH still fails open, warns once, exits 0', () => {
  // Unit-level version of the scenario below, isolated from git and the
  // rest of `init`: `hookBody()` (src/core/commands/hooks.ts) itself, run
  // with nothing on PATH at all, must never propagate a non-zero status -
  // that is what used to happen on Windows when the PATH-search fallback
  // was a shell spawn of a command that does not exist (see the comment on
  // `hookBody` for the "not recognized as an internal or external command"
  // failure mode this replaced).
  const dir = tmpDir('hookbody-');
  const installed = installHooks(dir, { chainDir: null });
  const file = installed.find((p) => p.endsWith('pre-commit')) as string;
  const gone = path.join(dir, "no such dir 'here'", 'promptlog.js');
  const body = fs.readFileSync(file, 'utf8').replace(/^const bakedPath = .*;\s*$/m, requireLiteral(gone));
  fs.writeFileSync(file, body, 'utf8');
  expect(spawnSync(process.execPath, ['--check', file]).status, 'still valid JS').toBe(0);

  const r = spawnSync(process.execPath, [file, 'irrelevant-msgfile'], {
    encoding: 'utf8',
    env: { PATH: '', PATHEXT: '' },
  });
  expect(r.status, `stdout=${r.stdout} stderr=${r.stderr}`).toBe(0);
  expect(r.stderr).toContain('promptlog: hook skipped');
  expect(r.stderr).toContain('is missing and no promptlog on PATH');
});

test('a dispatcher whose baked promptlog.js no longer exists still lets the commit through', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);

  // Simulate a moved / uninstalled promptlog: the baked path is gone, and
  // PATH holds no `promptlog` either - the fallback in "Missing baked path"
  // has nothing to fall back to, so the hook must warn once and get out of
  // the way rather than abort the commit.
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  const gone = path.join(home, "no such dir 'here'", 'promptlog.js');
  for (const name of ['pre-commit', 'prepare-commit-msg', 'post-commit', 'post-rewrite']) {
    const file = path.join(hooksDir, name);
    const body = fs.readFileSync(file, 'utf8').replace(/^const bakedPath = .*;\s*$/m, requireLiteral(gone));
    fs.writeFileSync(file, body, 'utf8');
    expect(spawnSync(process.execPath, ['--check', file]).status, `${name} still valid JS`).toBe(0);
  }
  // A PATH with node but without any globally installed `promptlog` (a dev
  // machine's node bin dir usually has one linked), so the PATH fallback
  // cannot mask the missing baked path.
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  // Only the promptlog shim must disappear from PATH - not git itself. On
  // POSIX, /usr/bin and /bin are where git always lives; on Windows there is
  // no such fixed location, so keep whatever entries of the REAL PATH point
  // into a Git install (Git for Windows needs its own bin/cmd directory, and
  // often a sibling DLL directory, just to start up at all).
  const pathDirs =
    process.platform === 'win32'
      ? [
          bin,
          ...String(env.PATH ?? '')
            .split(path.delimiter)
            .filter((p) => /git/i.test(p)),
        ]
      : [bin, '/usr/bin', '/bin'];
  const bare: NodeJS.ProcessEnv = { ...env, PATH: pathDirs.join(path.delimiter) };
  const msg = commitFile(bare, repoDir, 'a.txt', 'promptlog is gone');
  expect(msg, 'nothing recorded').not.toMatch(/Prompt-Id/);
  expect(gitOk(bare, repoDir, ['log', '-1', '--format=%s']).trim()).toBe('promptlog is gone');
});

test('local init under a LOCAL relative core.hooksPath takes it over and chains the previous hooks once', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const marker = path.join(home, 'custom-ran');
  writeMarkerHook(path.join(repoDir, 'custom-hooks', 'pre-commit'), marker);
  gitOk(env, repoDir, ['config', '--local', 'core.hooksPath', 'custom-hooks']);

  const init = promptlog(env, repoDir, ['init']);
  expect(init.code, init.stderr).toBe(0);
  // The path this message names is printed with the host's own separator
  // (git itself writes `/`-only paths into hooksPath, our own message does
  // not): normalise before matching so the regex's literal `/`s hold on
  // Windows too.
  expect(init.stdout.split(path.sep).join('/')).toMatch(
    /core\.hooksPath was .*custom-hooks; this repo now uses .*\.git\/hooks and chains/,
  );
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  expect(gitOk(env, repoDir, ['config', '--local', 'core.hooksPath']).trim()).toBe(hooksDir);
  expect(
    fs
      .readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8')
      .includes(chainDirLiteral(path.join(repoDir, 'custom-hooks'))),
    'previous dir baked in',
  ).toBe(true);
  // The previous directory is untouched.
  expect(fs.readdirSync(path.join(repoDir, 'custom-hooks'))).toEqual(['pre-commit']);

  let msg = commitFile(env, repoDir, 'a.txt', 'both run');
  expect(msg, `promptlog ran: ${JSON.stringify(msg)}`).toMatch(new RegExp(`Prompt-Id: claude:${SID8}:`));
  expect(runsOf(marker), `previous hook ran exactly once\n${diag(repoDir)}`).toEqual(['ran']);

  // Idempotent: a second init neither rotates our dispatcher nor doubles the chain.
  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  expect(
    fs.existsSync(path.join(hooksDir, 'pre-commit.legacy')),
    'no .legacy rotation of our own dispatcher',
  ).toBe(false);
  expect(gitOk(env, repoDir, ['config', '--local', 'core.hooksPath']).trim()).toBe(hooksDir);
  fs.writeFileSync(marker, '', 'utf8');
  msg = commitFile(env, repoDir, 'b.txt', 'still both, still once');
  expect(msg).toMatch(/Prompt-Id: claude:/);
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);
});

test('local init under a GLOBAL absolute core.hooksPath chains it and leaves the global config alone', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const marker = path.join(home, 'global-ran');
  const globalHooks = path.join(home, 'my-hooks');
  writeMarkerHook(path.join(globalHooks, 'pre-commit'), marker);
  gitOk(env, repoDir, ['config', '--global', 'core.hooksPath', globalHooks]);
  const globalBefore = fs.readFileSync(env.GIT_CONFIG_GLOBAL as string, 'utf8');

  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  expect(gitOk(env, repoDir, ['config', '--local', 'core.hooksPath']).trim()).toBe(hooksDir);
  expect(fs.readFileSync(env.GIT_CONFIG_GLOBAL as string, 'utf8'), 'global config untouched').toBe(
    globalBefore,
  );
  expect(gitOk(env, repoDir, ['config', '--global', 'core.hooksPath']).trim()).toBe(globalHooks);

  const msg = commitFile(env, repoDir, 'a.txt', 'chain the global hooks');
  expect(msg).toMatch(/Prompt-Id: claude:/);
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);

  expect(promptlog(env, repoDir, ['init']).code, 'idempotent').toBe(0);
  expect(fs.existsSync(path.join(hooksDir, 'pre-commit.legacy'))).toBe(false);
  fs.writeFileSync(marker, '', 'utf8');
  commitFile(env, repoDir, 'b.txt', 'again');
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);
});

test('init --global with an existing global core.hooksPath chains it rather than clobbering it', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const marker = path.join(home, 'old-global-ran');
  const oldHooks = path.join(home, 'old-hooks');
  writeMarkerHook(path.join(oldHooks, 'pre-commit'), marker);
  const oldBody = fs.readFileSync(path.join(oldHooks, 'pre-commit'), 'utf8');
  gitOk(env, repoDir, ['config', '--global', 'core.hooksPath', oldHooks]);

  const init = promptlog(env, repoDir, ['init', '--global']);
  expect(init.code, init.stderr).toBe(0);
  // Normalise before matching: see the LOCAL relative test above.
  expect(init.stdout.split(path.sep).join('/')).toMatch(
    /core\.hooksPath was .*old-hooks; git now uses .*\.promptlog\/hooks and chains/,
  );
  const hookDir = path.join(home, '.promptlog', 'hooks');
  expect(gitOk(env, repoDir, ['config', '--global', 'core.hooksPath']).trim()).toBe(hookDir);
  expect(fs.readdirSync(oldHooks), 'old dir untouched').toEqual(['pre-commit']);
  expect(fs.readFileSync(path.join(oldHooks, 'pre-commit'), 'utf8')).toBe(oldBody);
  expect(fs.readFileSync(path.join(hookDir, 'pre-commit'), 'utf8').includes(chainDirLiteral(oldHooks))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(repoDir, '.git', 'hooks', 'pre-commit')), 'nothing written per-repo').toBe(
    false,
  );

  let msg = commitFile(env, repoDir, 'a.txt', 'global chain');
  expect(msg).toMatch(/Prompt-Id: claude:/);
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);

  // Idempotent: the second run must not chain ~/.promptlog/hooks to itself
  // and must keep chaining the old directory.
  expect(promptlog(env, repoDir, ['init', '--global']).code).toBe(0);
  expect(
    fs.readFileSync(path.join(hookDir, 'pre-commit'), 'utf8').includes(chainDirLiteral(oldHooks)),
    'still chains the original directory after a re-run',
  ).toBe(true);
  fs.writeFileSync(marker, '', 'utf8');
  msg = commitFile(env, repoDir, 'b.txt', 'again');
  expect(msg).toMatch(/Prompt-Id: claude:/);
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);

  // A per-repo init on top of a global install has nothing to add.
  const local = promptlog(env, repoDir, ['init']);
  expect(local.code).toBe(0);
  expect(local.stdout.split(path.sep).join('/')).toMatch(
    /hooks already active via .*\.promptlog\/hooks \(core\.hooksPath\); nothing to install/,
  );
  expect(fs.existsSync(path.join(repoDir, '.git', 'hooks', 'pre-commit')), 'still nothing per-repo').toBe(
    false,
  );
  expect(git(env, repoDir, ['config', '--local', 'core.hooksPath']).code, 'no local hooksPath set').toBe(1);
  fs.writeFileSync(marker, '', 'utf8');
  msg = commitFile(env, repoDir, 'c.txt', 'once, not twice');
  expect((msg.match(/Prompt-Id:/g) || []).length, `promptlog ran once: ${JSON.stringify(msg)}`).toBe(1);
  expect(runsOf(marker), diag(repoDir)).toEqual(['ran']);
});

test('husky-shaped hooksPath (.husky/_) runs the husky hook exactly once per commit', () => {
  const { home, repoDir, env } = sandbox();
  onTestFinished(() => rmTree(home));

  writeTranscript(home, repoDir);
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);
  const marker = path.join(home, 'husky-ran');
  // husky v9: core.hooksPath=.husky/_, whose shim runs ../<name>.
  const shim = path.join(repoDir, '.husky', '_', 'pre-commit');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  // The shim tags its own run so the assertion below can tell "reached
  // .husky/pre-commit through the shim, once" from "chained it directly".
  fs.writeFileSync(
    shim,
    `#!/bin/sh\necho shim >> "${marker}"\nexec "$(dirname "$0")/../pre-commit" "$@"\n`,
    'utf8',
  );
  fs.chmodSync(shim, 0o755);
  writeMarkerHook(path.join(repoDir, '.husky', 'pre-commit'), marker, 'husky');
  gitOk(env, repoDir, ['config', '--local', 'core.hooksPath', '.husky/_']);

  expect(promptlog(env, repoDir, ['init']).code).toBe(0);
  expect(gitOk(env, repoDir, ['config', '--local', 'core.hooksPath']).trim()).toBe(
    path.join(repoDir, '.git', 'hooks'),
  );

  const msg = commitFile(env, repoDir, 'a.txt', 'husky once');
  expect(msg).toMatch(/Prompt-Id: claude:/);
  expect(
    runsOf(marker),
    `husky hook must run exactly once, via its shim: ${runsOf(marker)}\n${diag(repoDir)}`,
  ).toEqual(['shim', 'husky']);

  expect(promptlog(env, repoDir, ['init']).code, 'idempotent').toBe(0);
  fs.writeFileSync(marker, '', 'utf8');
  commitFile(env, repoDir, 'b.txt', 'husky once again');
  expect(runsOf(marker), diag(repoDir)).toEqual(['shim', 'husky']);
});
