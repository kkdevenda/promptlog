/**
 * Multi-person, DESIGN.md "Multi-person":
 *
 *   - `index.jsonl` is never committed, and is rebuilt lazily from a header
 *     (HEAD sha + a hash of the sessions listing).
 *   - session documents merge structurally via the `merge=promptlog` driver,
 *     so the same session committed on two branches unions cleanly instead
 *     of text-conflicting.
 *   - `.promptlog/README.md` merges via `merge=promptlog-readme`.
 *   - a squash merge folds trailers into the commit body; `reindex` still
 *     finds them (whole-body scan, not just the trailer block).
 *
 * Every scenario uses real git and a temp HOME (never the developer's own
 * ~/.gitconfig or ~/.promptlog).
 *
 * Most of the scenarios below spawn the built CLI (bin/promptlog.js);
 * `npm run build` runs first. `mergeSessionDocs` itself needs neither.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import * as merge from '../src/core/merge';
import type { SessionDoc, TurnRecord } from '../src/core/records';

const REPO = path.resolve(__dirname, '..');
const PROMPTLOG = path.join(REPO, 'bin', 'promptlog.js');

// ------------------------------------------------------------- scaffolding

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function mkuuid(n: number): string {
  const hex = String(n).padStart(4, '0');
  return `${hex}aaaa-bbbb-cccc-dddd-${hex}eeeeeeee`;
}

function slug(cwd: string): string {
  return cwd.split(path.sep).join('-');
}

/** A fresh, isolated HOME + git identity. Does not create a repo. */
function sandbox(tag: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `promptlog-mp-${tag}-`)));
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
    // Never let git open an editor under a TTY test runner (e.g. a squash
    // commit with no -m/-F would otherwise block the whole suite).
    GIT_EDITOR: 'true',
    EDITOR: 'true',
  };
  env.CLAUDE_CODE_SESSION_ID = undefined;
  env.CODEX_THREAD_ID = undefined;
  env.CODEX_SESSION_ID = undefined;
  fs.writeFileSync(
    env.GIT_CONFIG_GLOBAL as string,
    '[user]\n\tname = Test\n\temail = test@example.com\n',
    'utf8',
  );
  return { home, env };
}

function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function gitOk(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  const r = git(env, cwd, args);
  expect(r.code).toBe(0);
  return r.stdout;
}

function promptlog(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [PROMPTLOG, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function promptlogOk(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  const r = promptlog(env, cwd, args);
  expect(r.code).toBe(0);
  return r.stdout;
}

/**
 * `post-commit` always leaves `.promptlog/` dirty (it writes the sha it just
 * learned into the record and README, but does not commit that itself; see
 * DESIGN.md "records orphaned by an aborted commit... carried into the next
 * one"): a real user's next commit absorbs it, or `promptlog amend` folds it
 * back in. Neither is convenient mid-test when the very next step is a
 * branch switch or a merge, so settle it with one commit that runs at
 * dispatch depth >= 1 - the same guard the dispatcher itself uses for
 * re-entrancy - so it bypasses promptlog entirely rather than looping.
 */
function settle(env: NodeJS.ProcessEnv, repoDir: string): void {
  if (!git(env, repoDir, ['status', '--porcelain', '--', '.promptlog']).stdout.trim()) return;
  gitOk(env, repoDir, ['add', '-A', '--', '.promptlog']);
  const settleEnv = { ...env, PROMPTLOG_DISPATCH_DEPTH: '1' };
  gitOk(settleEnv, repoDir, ['commit', '-q', '-m', 'settle store']);
}

/**
 * A minimal synthetic Claude transcript with ONE still-running turn: no
 * finished assistant text, so (per DESIGN.md "The active turn") it is the
 * active turn of `sessionId` for as long as the env var names it - every
 * commit made under that env links it with `role: committer`, whatever file
 * is actually staged. That is exactly what these scenarios need: a stable,
 * predictable gid to track across branches/clones without depending on
 * evidence-based hunk matching.
 */
function writeCommitterTranscript(home: string, repoDir: string, sessionId: string) {
  const dir = path.join(home, '.claude', 'projects', slug(repoDir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const base = {
    isSidechain: false,
    cwd: repoDir,
    sessionId,
    version: '2.1.257',
    gitBranch: 'main',
    userType: 'external',
  };
  const records = [
    { type: 'mode', mode: 'normal', sessionId },
    {
      ...base,
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'keep committing my work' },
      uuid: mkuuid(1),
      timestamp: iso(-60000),
    },
  ];
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return { file, gidSuffix: mkuuid(1).slice(0, 7) };
}

function sessionDoc(repoDir: string, sessionId: string): SessionDoc {
  const p = path.join(repoDir, '.promptlog', 'sessions', `claude-${sessionId.slice(0, 8)}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function shas(rec: TurnRecord | undefined): string[] {
  return (rec?.commits ?? []).map((e) => e.sha).sort();
}

/** First line of index.jsonl, the lazy-rebuild header. */
function readIndexHeader(repoDir: string): { head: string | null } {
  const p = path.join(repoDir, '.promptlog', 'index.jsonl');
  const first = fs.readFileSync(p, 'utf8').split('\n')[0];
  return JSON.parse(first ?? '');
}

const SID_A = 'a1a1a1a1-2222-4333-8444-555566667777';
const SID_B = 'b2b2b2b2-2222-4333-8444-555566667777';

// --------------------------------------------------------------- (a)

test('two clones of one origin: independent sessions push/pull with no conflict, index lazily rebuilt on next show', () => {
  const seed = sandbox('seed-a');
  const origin = path.join(seed.home, 'origin.git');
  gitOk(seed.env, seed.home, ['init', '-q', '--bare', '-b', 'main', origin]);

  // Seed the origin with one commit so both clones check out `main`.
  const seedRepo = path.join(seed.home, 'seed');
  gitOk(seed.env, seed.home, ['clone', '-q', origin, seedRepo]);
  fs.writeFileSync(path.join(seedRepo, 'README.md'), 'seed\n', 'utf8');
  gitOk(seed.env, seedRepo, ['add', '.']);
  gitOk(seed.env, seedRepo, ['commit', '-q', '-m', 'seed']);
  gitOk(seed.env, seedRepo, ['push', '-q', '-u', 'origin', 'main']);

  // Both clones are made BEFORE either one pushes, so their two commits below
  // genuinely diverge from the same base instead of one being a fast-forward
  // of the other.
  const a = sandbox('clone-a');
  const repoA = path.join(a.home, 'repo');
  gitOk(a.env, a.home, ['clone', '-q', origin, repoA]);

  const b = sandbox('clone-b');
  const repoB = path.join(b.home, 'repo');
  gitOk(b.env, b.home, ['clone', '-q', origin, repoB]);

  try {
    // ---- clone A: its own session, its own commit, pushed first.
    writeCommitterTranscript(a.home, repoA, SID_A);
    const envA = { ...a.env, CLAUDE_CODE_SESSION_ID: SID_A };
    expect(promptlog(envA, repoA, ['init']).code).toBe(0);
    fs.writeFileSync(path.join(repoA, 'a.txt'), 'from A\n', 'utf8');
    gitOk(envA, repoA, ['add', 'a.txt', '.gitattributes']);
    gitOk(envA, repoA, ['commit', '-q', '-m', 'work from clone A']);
    settle(envA, repoA);
    const gidA = `claude:${SID_A.slice(0, 8)}:${mkuuid(1).slice(0, 7)}`;
    expect(sessionDoc(repoA, SID_A).turns[gidA]).toBeTruthy(); // clone A recorded its own turn
    gitOk(envA, repoA, ['push', '-q', 'origin', 'main']);

    // ---- clone B: its own DIFFERENT session, cloned before A's push landed.
    writeCommitterTranscript(b.home, repoB, SID_B);
    const envB = { ...b.env, CLAUDE_CODE_SESSION_ID: SID_B };
    expect(promptlog(envB, repoB, ['init']).code).toBe(0);
    fs.writeFileSync(path.join(repoB, 'b.txt'), 'from B\n', 'utf8');
    gitOk(envB, repoB, ['add', 'b.txt', '.gitattributes']);
    gitOk(envB, repoB, ['commit', '-q', '-m', 'work from clone B']);
    settle(envB, repoB);

    // B's push is behind (A already pushed): pull (merge) first, then push.
    expect(git(envB, repoB, ['push', 'origin', 'main']).code).not.toBe(0);
    const pull = git(envB, repoB, ['pull', '--no-rebase', '--no-edit', '-q', 'origin', 'main']);
    expect(pull.code).toBe(0);
    expect(git(envB, repoB, ['status', '--porcelain']).stdout.trim()).toBe(''); // merge left a clean tree
    gitOk(envB, repoB, ['push', '-q', 'origin', 'main']);

    // Both sessions' records survive the merge in clone B, index never tracked.
    expect(sessionDoc(repoB, SID_A).turns[gidA]).toBeTruthy(); // B's merge kept A's session doc
    const gidB = `claude:${SID_B.slice(0, 8)}:${mkuuid(1).slice(0, 7)}`;
    expect(sessionDoc(repoB, SID_B).turns[gidB]).toBeTruthy(); // B kept its own session doc too
    expect(gitOk(envB, repoB, ['ls-files', '.promptlog/index.jsonl']).trim()).toBe('');

    // ---- back in clone A: pull B's merge commit, then `show` lazily rebuilds
    // the index (its header no longer matches the new HEAD).
    const staleHeader = readIndexHeader(repoA);
    gitOk(envA, repoA, ['pull', '--no-rebase', '--no-edit', '-q', 'origin', 'main']);
    const newHead = gitOk(envA, repoA, ['rev-parse', 'HEAD']).trim();
    expect(staleHeader.head).not.toBe(newHead); // the pulled HEAD moved past the stale cached header

    const shown = promptlog(envA, repoA, ['show', gidB, '--no-color']);
    expect(shown.code).toBe(0);
    const freshHeader = readIndexHeader(repoA);
    expect(freshHeader.head).toBe(newHead); // rebuilt by `show` to match the new HEAD
  } finally {
    fs.rmSync(seed.home, { recursive: true, force: true });
    fs.rmSync(a.home, { recursive: true, force: true });
    fs.rmSync(b.home, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- (b)

test('the same session committed on two branches merges via the driver, unioning both shas; README merges too', () => {
  const { home, env } = sandbox('branches');
  const repoDir = path.join(home, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  try {
    writeCommitterTranscript(home, repoDir, SID_A);
    const sEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A };
    expect(promptlog(sEnv, repoDir, ['init']).code).toBe(0);
    const gid = `claude:${SID_A.slice(0, 8)}:${mkuuid(1).slice(0, 7)}`;
    const roleOf = (rec: TurnRecord, sha: string) => rec.commits.find((e) => e.sha === sha)?.role;

    // Driver registered, so a merge on this repo will actually use it.
    expect(git(env, repoDir, ['config', '--get', 'merge.promptlog.driver']).code).toBe(0);
    expect(git(env, repoDir, ['config', '--get', 'merge.promptlog-readme.driver']).code).toBe(0);

    fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'base.txt', '.gitattributes']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'base']);
    const shaBase = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();
    expect(shas(sessionDoc(repoDir, SID_A).turns[gid])).toEqual([shaBase]);
    settle(sEnv, repoDir);

    gitOk(sEnv, repoDir, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'feature.txt']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'on feature']);
    const shaFeature = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();
    expect(shas(sessionDoc(repoDir, SID_A).turns[gid])).toEqual([shaBase, shaFeature].sort());
    const featureRec = sessionDoc(repoDir, SID_A).turns[gid];
    if (!featureRec) throw new Error('expected a record');
    expect(roleOf(featureRec, shaFeature)).toBe('committer');
    settle(sEnv, repoDir);

    gitOk(sEnv, repoDir, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repoDir, 'main.txt'), 'main\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'main.txt']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'on main']);
    const shaMain = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();
    // `feature`'s branch ref is still reachable, so `reindex`'s `git log --all`
    // scan already discovers its gid trailer from here too - but with no
    // local evidence for it, `role: 'unknown'`. That divergence (main says
    // 'unknown', feature's own copy says 'committer') is exactly what makes
    // the two branches' blobs differ byte-for-byte, so the merge below
    // cannot be a no-op and genuinely exercises the driver.
    expect(shas(sessionDoc(repoDir, SID_A).turns[gid])).toEqual([shaBase, shaFeature, shaMain].sort());
    const mainRec = sessionDoc(repoDir, SID_A).turns[gid];
    if (!mainRec) throw new Error('expected a record');
    expect(roleOf(mainRec, shaFeature)).toBe('unknown');
    settle(sEnv, repoDir);

    // The merge itself: our own hooks skip a merge commit (MERGE_HEAD is
    // set), so only the merge DRIVERS run.
    const merged = git(sEnv, repoDir, ['merge', '--no-edit', '-q', 'feature']);
    expect(merged.code).toBe(0);
    expect(git(sEnv, repoDir, ['status', '--porcelain']).stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(repoDir, '.promptlog', 'README.md'), 'utf8')).not.toMatch(
      /<{7}|={7}|>{7}/,
    );

    const mergedRec = sessionDoc(repoDir, SID_A).turns[gid];
    if (!mergedRec) throw new Error('expected a record');
    expect(shas(mergedRec).includes(shaFeature)).toBeTruthy();
    expect(shas(mergedRec).includes(shaMain)).toBeTruthy();
    expect(new Set(shas(mergedRec)).size).toBe(shas(mergedRec).length);
    expect(roleOf(mergedRec, shaFeature)).toBe('committer'); // driver kept feature's real evidence
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('mergeSessionDocs unions turns by gid, widens role, and keeps the file evidence with the higher match count', () => {
  const ours = {
    version: 1,
    agent: 'claude',
    sessionId: 'abc12345',
    turns: {
      'claude:abc12345:1111111': {
        id: '1111111',
        response: null,
        responsePending: true,
        redactions: [],
        commits: [
          {
            sha: 'a'.repeat(40),
            role: 'contributor',
            files: { 'x.js': { hunks: 2, matched: 1, confidence: 'edit' } },
          },
        ],
      },
      'claude:abc12345:2222222': { id: '2222222', response: 'ours only', commits: [] },
    },
    // The rest of TurnRecord's fields are not read by mergeTurnRecord / mergeSessionDocs.
  } as unknown as Partial<SessionDoc>;
  const theirs = {
    version: 1,
    agent: 'claude',
    sessionId: 'abc12345',
    turns: {
      'claude:abc12345:1111111': {
        id: '1111111',
        response: 'finished, from theirs',
        responsePending: false,
        redactions: [],
        commits: [
          {
            sha: 'a'.repeat(40),
            role: 'committer',
            files: { 'x.js': { hunks: 2, matched: 2, confidence: 'edit' } },
          },
          { sha: 'b'.repeat(40), role: 'contributor', files: {} },
        ],
      },
      'claude:abc12345:3333333': { id: '3333333', response: null, commits: [] },
    },
  } as unknown as Partial<SessionDoc>;
  const merged = merge.mergeSessionDocs(null, ours, theirs);
  const turns = merged.turns ?? {};
  expect(Object.keys(turns).sort()).toEqual([
    'claude:abc12345:1111111',
    'claude:abc12345:2222222',
    'claude:abc12345:3333333',
  ]); // union of turns by gid
  expect(turns['claude:abc12345:2222222']?.response).toBe('ours only'); // ours-only turn survives
  expect(turns['claude:abc12345:3333333']?.id).toBe('3333333'); // theirs-only turn survives

  const t1 = turns['claude:abc12345:1111111'];
  if (!t1) throw new Error('expected a merged record');
  expect(t1.commits.length).toBe(2); // union by sha
  const shaA = t1.commits.find((e) => e.sha === 'a'.repeat(40));
  expect(shaA?.role).toBe('both'); // 'contributor' + 'committer' widens to 'both'
  expect(shaA?.files['x.js']).toEqual({ hunks: 2, matched: 2, confidence: 'edit' }); // more matched hunks wins
  const shaB = t1.commits.find((e) => e.sha === 'b'.repeat(40));
  expect(shaB?.role).toBe('contributor'); // theirs-only sha carries its own role
  expect(t1.response).toBe('finished, from theirs'); // a non-null response is never dropped for a null one
});

// --------------------------------------------------------------- (c)

test('a squash merge folds trailers into the commit body; reindex still attributes both gids to it', () => {
  const { home, env } = sandbox('squash');
  const repoDir = path.join(home, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  try {
    writeCommitterTranscript(home, repoDir, SID_A);
    const sEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A };
    expect(promptlog(sEnv, repoDir, ['init']).code).toBe(0);
    const gid = `claude:${SID_A.slice(0, 8)}:${mkuuid(1).slice(0, 7)}`;

    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'seed.txt', '.gitattributes']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'seed']);
    settle(sEnv, repoDir);

    gitOk(sEnv, repoDir, ['checkout', '-q', '-b', 'feat']);
    // Two commits on the branch: since the same turn is active for both,
    // only one gid links to each - but both commits belong to the branch
    // that gets squashed, which is what exercises the "trailers moved into
    // the body" path.
    fs.writeFileSync(path.join(repoDir, 'one.txt'), 'one\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'one.txt']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'feat one']);
    const shaOne = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();

    fs.writeFileSync(path.join(repoDir, 'two.txt'), 'two\n', 'utf8');
    gitOk(sEnv, repoDir, ['add', 'two.txt']);
    gitOk(sEnv, repoDir, ['commit', '-q', '-m', 'feat two']);
    const shaTwo = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();
    expect(shaOne).not.toBe(shaTwo);
    settle(sEnv, repoDir);

    gitOk(sEnv, repoDir, ['checkout', '-q', 'main']);
    gitOk(sEnv, repoDir, ['merge', '-q', '--squash', 'feat']);
    // `git merge --squash` stages the tree changes and writes .git/SQUASH_MSG,
    // concatenating the squashed commits' own messages (Prompt-Id lines and
    // all) into the body of the eventual commit - our own prepare-commit-msg
    // explicitly does nothing for a squash (source === 'squash'), so
    // whatever trailers land in the message are git's doing, not ours.
    // Commit with -F on that file explicitly: without -m/-F git would open
    // an editor when the test runner has a TTY.
    const squashMsgPath = gitOk(sEnv, repoDir, ['rev-parse', '--git-path', 'SQUASH_MSG']).trim();
    expect(fs.existsSync(path.resolve(repoDir, squashMsgPath))).toBeTruthy();
    gitOk(sEnv, repoDir, ['commit', '-q', '--no-verify', '-F', squashMsgPath]);
    const shaSquash = gitOk(sEnv, repoDir, ['rev-parse', 'HEAD']).trim();
    const squashMsg = gitOk(sEnv, repoDir, ['log', '-1', '--format=%B']);
    expect(squashMsg).toMatch(new RegExp(`Prompt-Id: ${gid}`));

    // Real usage deletes the squashed-away branch; once its ref is gone,
    // `feat one`/`feat two` are unreachable and `git log --all` (which
    // `reindex` scans) can no longer see their trailers - only the squash
    // commit's folded-into-the-body copy remains.
    gitOk(sEnv, repoDir, ['branch', '-D', 'feat']);
    const ri = promptlogOk(sEnv, repoDir, ['reindex']);
    expect(ri).toMatch(/rebuilt from trailers/);
    const rec = sessionDoc(repoDir, SID_A).turns[gid];
    expect(shas(rec).includes(shaSquash)).toBeTruthy();
    expect(!shas(rec).includes(shaOne) && !shas(rec).includes(shaTwo)).toBeTruthy();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------- (d)

test('index.jsonl is never tracked after init, across several commits', () => {
  const { home, env } = sandbox('untracked');
  const repoDir = path.join(home, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  gitOk(env, repoDir, ['init', '-q', '-b', 'main']);

  try {
    writeCommitterTranscript(home, repoDir, SID_A);
    const sEnv = { ...env, CLAUDE_CODE_SESSION_ID: SID_A };
    expect(promptlog(sEnv, repoDir, ['init']).code).toBe(0);
    expect(gitOk(sEnv, repoDir, ['ls-files', '.promptlog/index.jsonl']).trim()).toBe('');

    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `${i}\n`, 'utf8');
      gitOk(sEnv, repoDir, ['add', '-A']);
      gitOk(sEnv, repoDir, ['commit', '-q', '-m', `commit ${i}`]);
      expect(gitOk(sEnv, repoDir, ['ls-files', '.promptlog/index.jsonl']).trim()).toBe('');
      expect(
        git(sEnv, repoDir, ['status', '--porcelain', '--', '.promptlog/index.jsonl']).stdout.trim(),
      ).toBe('');
    }
    expect(fs.existsSync(path.join(repoDir, '.promptlog', 'index.jsonl'))).toBeTruthy();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
