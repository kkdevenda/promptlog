import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { slug } from '../src/agents/claude/locate';
// Ported from OLD test/git.test.js. The `attribution` and `commands/repo`
// modules these tests exercise are other work packages and do not exist yet
// in NEW; this whole file will fail to import until they land (tracked, not
// silently skipped: see the WP1 report).
import * as attribution from '../src/core/attribution';
import * as initCmds from '../src/core/commands/init';
import * as repoCmds from '../src/core/commands/repo';
import * as git from '../src/core/git';
import { rmTree, tmpDir } from './helpers';

const S = 1000000; // one second in micros

function turn(id: string, tsSec: number, durationS: number, files: string[] = []) {
  return { id, fullId: `full-${id}`, tsMicros: tsSec * S, durationS, files: new Set(files) };
}

test('formatTrailers emits one Prompt-Id line per gid and dedupes', () => {
  expect(git.formatTrailers([])).toBe('');
  expect(
    git.formatTrailers(['claude:c86e0429:5043cd5', 'claude:c86e0429:0eeb962', 'claude:c86e0429:5043cd5']),
  ).toBe('Prompt-Id: claude:c86e0429:5043cd5\nPrompt-Id: claude:c86e0429:0eeb962\n');
});

test('parseTrailers reads Prompt-Id out of a commit message', () => {
  const msg = [
    'store: write records at commit time',
    '',
    'Body paragraph that mentions Prompt-Id: not-a-trailer inline.',
    '',
    'Prompt-Id: claude:c86e0429:5043cd5',
    'Prompt-Id: claude:c86e0429:0eeb962',
    'Co-Authored-By: Someone <a@b.c>',
    '',
  ].join('\n');
  const got = git.parseTrailers(msg);
  expect(got).toEqual(['claude:c86e0429:5043cd5', 'claude:c86e0429:0eeb962']);
});

test('parseTrailers returns [] for a message with none', () => {
  expect(git.parseTrailers('just a subject\n')).toEqual([]);
  expect(git.parseTrailers('')).toEqual([]);
});

test('appendTrailers adds a separated block and never duplicates', () => {
  const msg = 'subject line\n';
  const once = git.appendTrailers(msg, ['claude:aaaaaaaa:1234567']);
  expect(once).toMatch(/subject line\n\nPrompt-Id: claude:aaaaaaaa:1234567\n$/);
  // Idempotent: the same gid is not added twice.
  const twice = git.appendTrailers(once, ['claude:aaaaaaaa:1234567']);
  expect(twice).toBe(once);
  // A new gid joins the existing block with no extra blank line.
  const three = git.appendTrailers(once, ['claude:aaaaaaaa:1234567', 'claude:aaaaaaaa:7654321']);
  expect(three).toMatch(/Prompt-Id: claude:aaaaaaaa:1234567\nPrompt-Id: claude:aaaaaaaa:7654321\n$/);
  expect(git.parseTrailers(three)).toEqual(['claude:aaaaaaaa:1234567', 'claude:aaaaaaaa:7654321']);
});

test('selectTurns keeps turns whose window overlaps (since, until]', () => {
  const session = {
    turns: [
      turn('old', 100, 10), // 100..110  entirely before the window
      turn('straddle', 190, 30), // 190..220  ends inside the window
      turn('inside', 260, 5), // 260..265  fully inside
      turn('future', 400, 5), // starts after `until`
    ],
  };
  const got = git.selectTurns(session, { since: 200 * S, until: 300 * S }).map((t) => t.id);
  expect(got).toEqual(['straddle', 'inside']);
});

test('selectTurns includes the in-progress turn (duration 0, still running)', () => {
  const session = { turns: [turn('running', 305, 0)] };
  const got = git.selectTurns(session, { since: 300 * S, until: 310 * S }).map((t) => t.id);
  expect(got).toEqual(['running']);
  // A zero-duration turn exactly at `since` does not overlap (end === since).
  const at = { turns: [turn('boundary', 300, 0)] };
  expect(git.selectTurns(at, { since: 300 * S, until: 310 * S })).toEqual([]);
});

test('selectTurns with since=null takes everything up to until', () => {
  const session = { turns: [turn('a', 1, 0), turn('b', 2, 0), turn('c', 9999, 0)] };
  const got = git.selectTurns(session, { since: null, until: 100 * S }).map((t) => t.id);
  expect(got).toEqual(['a', 'b']);
});

// "Highest overlap wins" (disambiguateSessions) is gone: every candidate
// session is kept and attributed by evidence instead.
test('disambiguateSessions is gone, not renamed', () => {
  expect((git as unknown as Record<string, unknown>).disambiguateSessions).toBeUndefined();
});

test('parseDiffHunks splits a -U0 diff into per-file hunks', () => {
  const diff = [
    'diff --git a/lib/a.js b/lib/a.js',
    'index 1111111..2222222 100644',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -3 +3 @@',
    '-const old = 1;',
    '+const fresh = 1;',
    '@@ -10,0 +11,2 @@',
    '+added one',
    '+added two',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+brand new',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-was here',
    '',
  ].join('\n');
  const got = git.parseDiffHunks(diff);
  expect(Array.from(got.keys()), 'a deletion has nothing to attribute').toEqual(['lib/a.js', 'new.txt']);
  const hunks = got.get('lib/a.js');
  expect(hunks?.length).toBe(2);
  expect(hunks?.[0]?.added).toEqual(['const fresh = 1;']);
  expect(hunks?.[0]?.removed).toEqual(['const old = 1;']);
  expect(hunks?.[0]?.newStart).toBe(3);
  expect(hunks?.[0]?.newLines, 'a bare "@@ -3 +3 @@" means one line').toBe(1);
  expect(hunks?.[1]?.added).toEqual(['added one', 'added two']);
  expect(got.get('new.txt')?.[0]?.added).toEqual(['brand new']);
  expect(git.parseDiffHunks('')).toEqual(new Map());
});

test('stagedHunks / stagedBlobHash read the index, with and without a HEAD', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-hunks-'));
  const env = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  const run = (args: string[]) => git.git(args, { cwd: dir, env, timeout: 20000 });
  run(['init', '-q', '-b', 'main']);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  run(['add', 'a.txt']);
  // No HEAD yet: the index is diffed against the empty tree.
  let hunks = git.stagedHunks(dir);
  expect(hunks.get('a.txt')?.[0]?.added).toEqual(['one', 'two']);
  // git's own blob id for the staged content, which is what tier A compares
  // a Write's content against.
  expect(git.stagedBlobHash(dir, 'a.txt')).toBe(attribution.blobSha1('one\ntwo\n'));
  expect(git.hashObject(dir, 'one\ntwo\n')).toBe(attribution.blobSha1('one\ntwo\n'));

  run(['commit', '-q', '-m', 'first']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  run(['add', 'a.txt']);
  hunks = git.stagedHunks(dir);
  expect(hunks.get('a.txt')?.[0]?.added, 'only the new line is a hunk at -U0').toEqual(['three']);
  expect(git.stagedBlobHash(dir, 'nope.txt')).toBeNull();
  rmTree(dir);
});

test('parseAllPromptIds scans the whole body, not just the trailer block', () => {
  // A squash merge folds the squashed messages into the body, moving the ids
  // out of the trailer block where interpret-trailers can see them.
  const msg = [
    'Squashed commit of three',
    '',
    '* one',
    'Prompt-Id: claude:aaaaaaaa:1111111',
    '',
    '* two',
    'Prompt-Id: codex:bbbbbbbb:2222222',
    '',
    'a body line mentioning Prompt-Id: not-at-line-start inline',
    '',
    'Prompt-Id: claude:aaaaaaaa:1111111',
  ].join('\n');
  expect(git.parseAllPromptIds(msg)).toEqual(['claude:aaaaaaaa:1111111', 'codex:bbbbbbbb:2222222']);
  expect(git.parseAllPromptIds('')).toEqual([]);
});

test('parseRewriteStdin maps old shas to new ones and ignores junk', () => {
  const stdin = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd',
    'not a sha pair',
    '',
  ].join('\n');
  const map = git.parseRewriteStdin(stdin);
  expect(map.size).toBe(2);
  expect(map.get('a'.repeat(40))).toBe('b'.repeat(40));
  expect(map.get('c'.repeat(40))).toBe('d'.repeat(40));
  expect(git.parseRewriteStdin('').size).toBe(0);
});

test('headCommitTime / stagedFiles / isEnabled against a real repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-git-'));
  const env = {
    ...process.env,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  const run = (args: string[], opts?: Partial<git.GitOptions>) =>
    git.git(args, { cwd: dir, env, timeout: 20000, ...opts });
  run(['init', '-q', '-b', 'main']);

  expect(git.headCommitTime(dir), 'no commits yet').toBeNull();
  expect(git.isEnabled(dir)).toBe(false);
  run(['config', 'promptlog.enabled', 'true']);
  expect(git.isEnabled(dir)).toBe(true);

  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  run(['add', 'a.txt']);
  expect(git.stagedFiles(dir)).toEqual(['a.txt']);

  run(['commit', '-q', '-m', 'first\n\nPrompt-Id: claude:deadbeef:1234567\n']);
  const t = git.headCommitTime(dir);
  expect(typeof t === 'number' && t > 1e15, `plausible epoch micros, got ${t}`).toBeTruthy();
  const sha = git.headSha(dir);
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  expect(git.parseTrailers(git.commitMessage(dir, sha as string), { cwd: dir })).toEqual([
    'claude:deadbeef:1234567',
  ]);
  expect(git.commitFiles(dir, sha as string)).toEqual(['a.txt']);

  rmTree(dir);
});

test('appendTrailers separates the block even when the subject looks like a trailer', () => {
  // "readme: initial" matches the shape of a trailer but is a subject line; if
  // we join it, `git interpret-trailers --parse` sees no trailer block at all
  // and post-commit can never find the gids again.
  const msg = git.appendTrailers('readme: initial\n', ['claude:11111111:aaaa111']);
  expect(msg).toBe('readme: initial\n\nPrompt-Id: claude:11111111:aaaa111\n');
  expect(git.parseTrailers(msg)).toEqual(['claude:11111111:aaaa111']);
});

// --- selection filters (src/core/commands/repo.ts) --------------------------

test('touchesRepo keeps in-repo and file-less turns, drops work done elsewhere', () => {
  const root = '/tmp/some/repo';
  expect(repoCmds.touchesRepo({ files: new Set<string>() }, root)).toBe(true);
  expect(repoCmds.touchesRepo({ files: new Set([`${root}/lib/a.js`]) }, root)).toBe(true);
  expect(repoCmds.touchesRepo({ files: new Set(['lib/a.js']) }, root), 'already relative').toBe(true);
  expect(repoCmds.touchesRepo({ files: new Set(['/elsewhere/lib/a.js']) }, root)).toBe(false);
  // One in-repo file among many is enough.
  expect(repoCmds.touchesRepo({ files: new Set(['/elsewhere/x.js', `${root}/y.js`]) }, root)).toBe(true);
});

test('relevantTurns drops slash commands and other-directory turns', () => {
  const root = '/tmp/some/repo';
  const t = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    fullId: `f-${id}`,
    tsMicros: 250 * S,
    durationS: 10,
    isCommand: false,
    files: new Set<string>(),
    ...over,
  });
  const session = {
    turns: [
      t('keep-talk'),
      t('keep-edit', { files: new Set([`${root}/lib/a.js`]) }),
      t('drop-cmd', { isCommand: true }),
      t('drop-elsewhere', { files: new Set(['/other/checkout/b.js']) }),
      t('drop-window', { tsMicros: 10 * S, durationS: 1 }),
    ],
  };
  const got = repoCmds
    .relevantTurns(session, { since: 200 * S, until: 300 * S, root })
    .map((x: { id: string }) => x.id);
  expect(got).toEqual(['keep-talk', 'keep-edit']);
});

test('selectTurns always keeps the active turn, however stale its window', () => {
  // The active turn's durationS reflects the last record written BEFORE the
  // previous commit, so its window is stale by construction. Rapid successive
  // commits must still carry it.
  const session = { turns: [turn('done', 100, 10), turn('active', 190, 5)] };

  // A commit at t=300 whose predecessor committed at t=300: an empty window.
  expect(
    git.selectTurns(session, { since: 300 * S, until: 300 * S, activeLast: true }).map((t) => t.id),
  ).toEqual(['active']);
  // And again a second later, and again.
  expect(
    git.selectTurns(session, { since: 301 * S, until: 301 * S, activeLast: true }).map((t) => t.id),
  ).toEqual(['active']);
  // Only the LAST turn is the active one; earlier turns still obey the window.
  expect(
    git.selectTurns(session, { since: 195 * S, until: 300 * S, activeLast: true }).map((t) => t.id),
  ).toEqual(['active']);
  expect(git.activeTurn(session)).toBe(session.turns[1]);
  expect(git.activeTurn({ turns: [] })).toBeNull();
});

test('selectTurns without activeLast falls back to plain window overlap', () => {
  const session = { turns: [turn('a', 100, 10), turn('b', 190, 5)] };
  expect(git.selectTurns(session, { since: 300 * S, until: 300 * S })).toEqual([]);
  // `responsePending` is NOT a selection signal: agents narrate mid-turn, so it
  // is false for most of a turn's life and cannot stand in for active-ness.
  const narrated = { turns: [{ ...turn('b', 190, 5), responsePending: false }] };
  expect(git.selectTurns(narrated, { since: 300 * S, until: 300 * S })).toEqual([]);
  expect(
    git.selectTurns(narrated, { since: 300 * S, until: 300 * S, activeLast: true }).map((t) => t.id),
  ).toEqual(['b']);
});

test('activeLastFor: env-identified sessions are always active, otherwise mtime decides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-active-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{}\n');
  const at = (secs: number) => {
    fs.utimesSync(file, new Date(secs * 1000), new Date(secs * 1000));
  };

  // (a) identified from an env var: active regardless of mtime or window.
  at(1000);
  expect(repoCmds.activeLastFor({ how: 'env:CLAUDE_CODE_SESSION_ID', path: file }, 5000 * S)).toBe(true);
  expect(repoCmds.activeLastFor({ how: 'env:CODEX_THREAD_ID', path: file }, 5000 * S)).toBe(true);

  // (b) otherwise the transcript must have been written at or after the
  // previous commit's committer time.
  at(5000);
  expect(repoCmds.activeLastFor({ how: 'newest-for-cwd', path: file }, 5000 * S)).toBe(true);
  at(4999);
  expect(repoCmds.activeLastFor({ how: 'newest-for-cwd', path: file }, 5000 * S)).toBe(false);

  // No previous commit: only (a) can say anything; the window is everything.
  expect(repoCmds.activeLastFor({ how: 'newest-for-cwd', path: file }, null)).toBe(false);
  expect(repoCmds.activeLastFor({ how: 'env:CLAUDE_CODE_SESSION_ID', path: file }, null)).toBe(true);

  // An unreadable transcript is not claimed to be active.
  expect(repoCmds.activeLastFor({ how: 'newest-for-cwd', path: path.join(dir, 'nope') }, 1 * S)).toBe(false);
  rmTree(dir);
});

test('candidateSessions narrows to the named agent, symmetrically', () => {
  // `--agent claude` used to narrow to claude (the registry's first adapter)
  // while `--agent codex` fell back to `['codex', 'claude']` and could answer
  // with a Claude session. Both must narrow to the agent that was named.
  const home = tmpDir('promptlog-narrow-');
  const repoDir = path.join(home, 'repo');
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  const sid = 'c86e0429-3e3b-4f17-8262-35a6f0c85599';
  const slugDir = path.join(home, '.claude', 'projects', slug(repoDir));
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(
    path.join(slugDir, `${sid}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      uuid: `${sid}-u1`,
      parentUuid: null,
      timestamp: new Date().toISOString(),
      cwd: repoDir,
      sessionId: sid,
      message: { role: 'user', content: 'hello' },
    })}\n`,
  );

  try {
    // HOME is injected through the `env` object `candidateSessions` is given
    // (which threads it to every locate/findSession call as `home` via
    // `envHome`), not by mutating the process's real environment:
    // `os.homedir()` on win32 reads USERPROFILE and ignores a reassigned
    // `process.env.HOME`.
    const env = { CLAUDE_CODE_SESSION_ID: sid, HOME: home };
    const call = (agent: string) =>
      repoCmds.candidateSessions({ cwd: repoDir, env, agent }).map((c: { agent: string }) => c.agent);

    expect(call('claude')).toEqual(['claude']);
    expect(call('codex'), 'no codex transcript exists: a codex-only query must find nothing').toEqual([]);
    expect(call('auto')).toEqual(['claude']);
    expect(repoCmds.narrowedAgentIds('codex')).toEqual(['codex']);
    expect(repoCmds.narrowedAgentIds('claude')).toEqual(['claude']);
    expect(repoCmds.narrowedAgentIds('auto').length >= 2, 'auto considers every adapter').toBeTruthy();
  } finally {
    rmTree(home);
  }
});

test('appendTrailers never splits an existing trailer paragraph', () => {
  // Joining a new block after a blank line would take Signed-off-by out of
  // the LAST paragraph, and `git interpret-trailers --parse` would stop
  // seeing it: the sign-off silently disappears from every tool that reads
  // trailers, including `git log --format=%(trailers)`.
  const signed = 'fix: the thing\n\nSigned-off-by: A <a@b.c>\nCo-Authored-By: B <b@c.d>\n';
  const out = git.appendTrailers(signed, ['claude:aaaaaaaa:1111111']);
  expect(out).toBe(
    'fix: the thing\n\nSigned-off-by: A <a@b.c>\nCo-Authored-By: B <b@c.d>\nPrompt-Id: claude:aaaaaaaa:1111111\n',
  );
  expect(
    out
      .split(/\n{2,}/)
      .pop()
      ?.split('\n')
      .filter(Boolean).length,
    'one paragraph holds all three trailers',
  ).toBe(3);
  expect(git.parseTrailers(out)).toEqual(['claude:aaaaaaaa:1111111']);
  // git itself must still see the sign-off in the trailer block.
  const parsed = git.git(['interpret-trailers', '--parse'], { input: out });
  if (parsed.ok) {
    expect(parsed.stdout).toMatch(/Signed-off-by: A <a@b\.c>/);
    expect(parsed.stdout).toMatch(/Prompt-Id: claude:aaaaaaaa:1111111/);
  }

  // A body paragraph is NOT a trailer block: a blank line still goes in.
  expect(git.appendTrailers('subject\n\nsome explanation of why\n', ['claude:aaaaaaaa:2222222'])).toBe(
    'subject\n\nsome explanation of why\n\nPrompt-Id: claude:aaaaaaaa:2222222\n',
  );
  // Nor is a lone subject that merely has the shape of one.
  expect(git.appendTrailers('readme: initial\n', ['claude:aaaaaaaa:3333333'])).toBe(
    'readme: initial\n\nPrompt-Id: claude:aaaaaaaa:3333333\n',
  );
});

test('lastParagraphIsTrailers', () => {
  const f = git.lastParagraphIsTrailers;
  expect(f('subject\n'), 'a subject is not a trailer block').toBe(false);
  expect(f('readme: initial\n')).toBe(false);
  expect(f('subject\n\nbody\n')).toBe(false);
  expect(f('subject\n\nSigned-off-by: A <a@b>\n')).toBe(true);
  expect(f('subject\n\nbody\n\nPrompt-Id: x\nSigned-off-by: A <a@b>\n')).toBe(true);
  expect(f('subject\n\nSigned-off-by: A <a@b>\nnot a trailer at all\n')).toBe(false);
  expect(f('subject\n\nAcked-by: A\n  a folded continuation\n')).toBe(true);
  expect(f('')).toBe(false);
});

test('isPartialCommit: index.lock is the real index, a temp index is not', () => {
  const dir = tmpDir('promptlog-idx-');
  const env = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  git.git(['init', '-q', '-b', 'main'], { cwd: dir, env, timeout: 20000 });
  const gitDir = path.join(dir, '.git');
  const check = (idx: string) => repoCmds.isPartialCommit({ env: { GIT_INDEX_FILE: idx } }, dir);

  expect(check(''), 'no GIT_INDEX_FILE: a plain commit').toBe(false);
  expect(check(path.join(gitDir, 'index'))).toBe(false);
  // `git commit -a` (and any commit that has to write the index) points
  // GIT_INDEX_FILE at index.lock and RENAMES it into place, so what we stage
  // there lands in this very commit.
  expect(check(path.join(gitDir, 'index.lock'))).toBe(false);
  expect(check('.git/index.lock'), 'relative to the repo root, too').toBe(false);
  // A pathspec commit builds a genuinely separate index.
  expect(check(path.join(gitDir, 'next-index-12345.lock'))).toBe(true);
  rmTree(dir);
});

test('merge-driver leaves the conflict when an input is not a session document', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-merge-')));
  const write = (name: string, text: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };
  const doc = (gid: string, prompt: string) =>
    JSON.stringify({
      version: 1,
      agent: 'claude',
      sessionId: 'sid',
      turns: { [gid]: { id: gid.split(':').pop(), prompt, commits: [] } },
    });
  const NO_BASE = path.join(dir, 'no-base.json'); // never written: simulates an absent base arg
  const run = async (base: string | null, ours: string, theirs: string) => {
    const outLines: string[] = [];
    const write2 = { write: (s: string) => outLines.push(s) } as unknown as NodeJS.WritableStream;
    const code = await initCmds.mergeDriver(
      { values: {}, positionals: ['merge-driver', base ?? NO_BASE, ours, theirs] },
      { cwd: dir, stdout: write2, stderr: write2, env: {} },
    );
    return { code, text: outLines.join('') };
  };

  // The happy path, with no base at all (an add/add merge): a real union.
  const ours1 = write('ours1.json', doc('claude:sid:aaaaaaa', 'mine'));
  const theirs1 = write('theirs1.json', doc('claude:sid:bbbbbbb', 'theirs'));
  let r = await run(path.join(dir, 'absent-base.json'), ours1, theirs1);
  expect(r.code, r.text).toBe(0);
  expect(Object.keys(JSON.parse(fs.readFileSync(ours1, 'utf8')).turns).sort()).toEqual([
    'claude:sid:aaaaaaa',
    'claude:sid:bbbbbbb',
  ]);

  // An EMPTY base blob is legitimate too (git hands one for a file created on
  // both sides), and must still merge.
  const ours2 = write('ours2.json', doc('claude:sid:aaaaaaa', 'mine'));
  const theirs2 = write('theirs2.json', doc('claude:sid:bbbbbbb', 'theirs'));
  r = await run(write('empty-base.json', ''), ours2, theirs2);
  expect(r.code, r.text).toBe(0);
  expect(Object.keys(JSON.parse(fs.readFileSync(ours2, 'utf8')).turns).length).toBe(2);

  // Corrupt OURS: exit non-zero and leave the file byte-for-byte alone, so git
  // reports a normal conflict. Falling back to `{}` here would "resolve" the
  // merge by discarding every turn on our side.
  const corrupt = '{"version": 1, "turns": {"claude:sid:aaaaaaa": {trunc';
  const ours3 = write('ours3.json', corrupt);
  r = await run(null, ours3, write('theirs3.json', doc('claude:sid:bbbbbbb', 'theirs')));
  expect(r.code, r.text).toBe(1);
  expect(r.text).toMatch(/not a readable session document/);
  expect(fs.readFileSync(ours3, 'utf8'), 'ours is untouched').toBe(corrupt);

  // Corrupt THEIRS: same, and ours keeps its own turns rather than losing them.
  const ours4 = write('ours4.json', doc('claude:sid:aaaaaaa', 'mine'));
  r = await run(null, ours4, write('theirs4.json', 'not json at all'));
  expect(r.code, r.text).toBe(1);
  expect(Object.keys(JSON.parse(fs.readFileSync(ours4, 'utf8')).turns)).toEqual(['claude:sid:aaaaaaa']);

  // A base that EXISTS but is corrupt is also a refusal, not a silent union.
  const ours5 = write('ours5.json', doc('claude:sid:aaaaaaa', 'mine'));
  r = await run(
    write('bad-base.json', '{oops'),
    ours5,
    write('theirs5.json', doc('claude:sid:bbbbbbb', 't')),
  );
  expect(r.code, r.text).toBe(1);
  expect(Object.keys(JSON.parse(fs.readFileSync(ours5, 'utf8')).turns)).toEqual(['claude:sid:aaaaaaa']);

  // A JSON array is not a session document either.
  const ours6 = write('ours6.json', '[1,2,3]');
  r = await run(null, ours6, write('theirs6.json', doc('claude:sid:bbbbbbb', 't')));
  expect(r.code, r.text).toBe(1);
  expect(fs.readFileSync(ours6, 'utf8')).toBe('[1,2,3]');

  rmTree(dir);
});
