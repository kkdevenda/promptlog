import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Turn } from '../src/core/model';
import * as redactModule from '../src/core/redact';
import * as renderReadmeMod from '../src/core/renderReadme';
import * as sessionRecords from '../src/core/sessionRecords';
import * as store from '../src/core/store';
import * as storeIndex from '../src/core/storeIndex';
import { rmTree, tmpDir } from './helpers';

// Assembled at runtime so no key-shaped literal sits in the repo (GitHub push protection).
const AWS_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;

const S = 1000000;

function tmpRoot(): string {
  const dir = tmpDir('promptlog-store-');
  fs.mkdirSync(path.join(dir, '.promptlog', 'sessions'), { recursive: true });
  return dir;
}

const SID = 'c86e0429-3e3b-4f17-8262-35a6f0c85599';
const GID = 'claude:c86e0429:5043cd5';

interface TurnOverrides {
  id?: string;
  fullId?: string;
  parentId?: string | null;
  sessionId?: string;
  tsMicros?: number;
  durationS?: number;
  prompt?: string;
  response?: string | null;
  responsePending?: boolean;
  isCommand?: boolean;
  outputTokens?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  thinkingTokens?: number;
  toolCalls?: number;
  toolNames?: Map<string, number>;
  files?: Set<string>;
  models?: Set<string>;
}

/** A Turn with the fields lib/store.ts reads, matching OLD's turn() fixture. */
function turn(over: TurnOverrides = {}): Turn {
  const t = new Turn({
    id: over.id ?? '5043cd5',
    fullId: over.fullId ?? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    parentId: over.parentId ?? null,
    agent: 'claude',
    sessionId: over.sessionId ?? SID,
    tsMicros: over.tsMicros ?? 1788000000 * S,
    prompt: over.prompt ?? 'add a repo store',
    response: over.response ?? null,
    responsePending: over.responsePending ?? false,
    isCommand: over.isCommand ?? false,
  });
  t.durationS = over.durationS ?? 747.23;
  t.outputTokens = over.outputTokens ?? 21600;
  t.inputTokens = over.inputTokens ?? 2;
  t.cacheReadTokens = over.cacheReadTokens ?? 1200000;
  t.cacheWriteTokens = over.cacheWriteTokens ?? 18000;
  t.thinkingTokens = over.thinkingTokens ?? 9000;
  t.toolCalls = over.toolCalls ?? 15;
  t.toolNames =
    over.toolNames ??
    new Map([
      ['Bash', 12],
      ['Agent', 3],
    ]);
  t.files = over.files ?? new Set(['lib/store.js']);
  t.models = over.models ?? new Set(['claude-fable-5-1']);
  return t;
}

function upsert(root: string, turns: Turn[], commits: sessionRecords.CommitInput[] = []) {
  return sessionRecords.upsertSession(root, {
    agent: 'claude',
    sessionId: SID,
    cwd: '/repo',
    started: '2026-09-02T10:19:46.683Z',
    originPath: path.join(os.homedir(), '.claude', 'projects', 'x', `${SID}.jsonl`),
    config: store.DEFAULT_CONFIG,
    commits,
    turns,
  });
}

test('makeGid matches the documented <agent>:<sessionId8>:<shortId> form', () => {
  expect(store.makeGid('claude', SID, '5043cd5')).toBe(GID);
  expect(store.turnGid(turn())).toBe(GID);
});

test('ensureConfig creates config.json with the documented defaults', () => {
  const root = tmpRoot();
  const cfg = store.ensureConfig(root);
  expect(cfg.version).toBe(1);
  expect(cfg.enabled).toBe(true);
  expect(cfg.responses).toBe('final');
  expect(cfg.notes).toBe(false);
  expect(cfg.readme).toBe(true);
  expect(cfg.redact).toEqual({ pasteLines: 40, pasteBytes: 4000, allow: [], deny: [], keepEmails: false });
  expect(fs.existsSync(store.configPath(root))).toBeTruthy();
  // Reading again does not clobber a user edit, and missing keys are defaulted.
  const edited: Record<string, unknown> = { ...store.readConfig(root), notes: true };
  delete edited.readme;
  store.writeConfig(root, edited);
  const back = store.readConfig(root);
  expect(back.notes).toBe(true);
  expect(back.readme).toBe(true); // missing key filled from defaults
  rmTree(root);
});

test('a session document matches the documented schema and hashes the ORIGINAL text', () => {
  const root = tmpRoot();
  const { doc, file, gids } = upsert(root, [turn({ response: 'done.' })]);
  expect(gids).toEqual([GID]);
  expect(path.basename(file)).toBe('claude-c86e0429.json');

  expect(doc.version).toBe(1);
  expect(doc.agent).toBe('claude');
  expect(doc.sessionId).toBe(SID);
  expect(doc.machine).toMatch(/^[0-9a-f]{12}$/);

  const rec = doc.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.id).toBe('5043cd5');
  expect(rec.durationS).toBe(747.2); // duration rounded to one decimal
  expect(rec.tokens).toEqual({
    output: 21600,
    input: 2,
    cacheRead: 1200000,
    cacheWrite: 18000,
    thinking: 9000,
  });
  expect(rec.toolNames).toEqual({ Bash: 12, Agent: 3 });
  expect(rec.files).toEqual(['lib/store.js']);
  expect(rec.models).toEqual(['claude-fable-5-1']);
  expect(rec.ts).toMatch(/Z$/);

  // origin.path is home-collapsed to a portable `~/` form: forward slashes on
  // every platform (DESIGN.md "Repo store"), never the host separator.
  expect(rec.origin.path.startsWith('~/.claude/')).toBeTruthy();
  expect(rec.origin.path).not.toMatch(/\\/);
  const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  expect(rec.origin.promptHash).toBe(sha('add a repo store'));
  expect(rec.origin.responseHash).toBe(sha('done.'));
  expect(rec.origin.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  rmTree(root);
});

test('upsert unions commit entries and never loses an earlier sha', () => {
  const root = tmpRoot();
  const shas = (rec: { commits: { sha: string }[] }) => rec.commits.map((e) => e.sha);
  upsert(root, [turn()], ['a'.repeat(40)]);
  upsert(root, [turn()], ['b'.repeat(40)]);
  let rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(shas(rec)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  // A sha with no evidence is still an entry, with an honest 'unknown' role.
  expect(rec.commits[0]).toEqual({ sha: 'a'.repeat(40), role: 'unknown', files: {} });

  // Re-writing the same sha does not duplicate it.
  upsert(root, [turn()], ['a'.repeat(40)]);
  rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(shas(rec)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);

  // addCommitToGids does the same for post-commit, and carries the evidence.
  const res = sessionRecords.addCommitToGids(root, [GID], 'c'.repeat(40), {
    evidence: {
      [GID]: { role: 'both', files: { 'lib/store.js': { hunks: 2, matched: 2, confidence: 'edit' } } },
    },
  });
  expect(res.changed).toBe(1);
  expect(sessionRecords.addCommitToGids(root, [GID], 'c'.repeat(40)).changed).toBe(0); // idempotent
  rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.commits.length).toBe(3);
  const c = rec.commits.find((e) => e.sha === 'c'.repeat(40));
  expect(c?.role).toBe('both');
  expect(c?.files).toEqual({ 'lib/store.js': { hunks: 2, matched: 2, confidence: 'edit' } });
  rmTree(root);
});

test('a contributor turn that also committed is recorded as both, once', () => {
  const root = tmpRoot();
  const sha = 'd'.repeat(40);
  sessionRecords.upsertSession(root, {
    agent: 'claude',
    sessionId: SID,
    cwd: '/tmp/x',
    originPath: '/tmp/x.jsonl',
    config: store.ensureConfig(root),
    turns: [turn()],
    commits: [{ sha, role: 'contributor', files: { 'a.js': { hunks: 1, matched: 1, confidence: 'edit' } } }],
  });
  sessionRecords.addCommitToGids(root, [GID], sha, { evidence: { [GID]: { role: 'committer', files: {} } } });
  const rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.commits.length).toBe(1); // one entry per sha
  expect(rec.commits[0]?.role).toBe('both');
  expect(Object.keys(rec.commits[0]?.files ?? {})).toEqual(['a.js']); // evidence survives the role merge
  rmTree(root);
});

test('upsert backfills a pending response and keeps everything else fresh', () => {
  const root = tmpRoot();
  upsert(root, [turn({ response: null, responsePending: true, outputTokens: 100 })]);
  let rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.response).toBe(null);
  expect(rec.responsePending).toBe(true);

  // The turn finished: the response arrives, the metrics are replaced.
  upsert(root, [turn({ response: 'all done', responsePending: false, outputTokens: 500 })]);
  rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.response).toBe('all done');
  expect(rec.responsePending).toBe(false);
  expect(rec.tokens.output).toBe(500); // non-commit fields are replaced by the fresh parse

  // A later parse with no response at all keeps the one we already have.
  upsert(root, [turn({ response: null, responsePending: false })]);
  rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.response).toBe('all done'); // a stored response is never dropped
  rmTree(root);
});

test('remapCommits rewrites shas for post-rewrite', () => {
  const root = tmpRoot();
  upsert(root, [turn()], ['a'.repeat(40)]);
  sessionRecords.remapCommits(root, new Map([['a'.repeat(40), 'f'.repeat(40)]]));
  const rec = sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(sessionRecords.commitShas(rec)).toEqual(['f'.repeat(40)]);
  rmTree(root);
});

test('writeAtomic leaves no partial file and no stray tmp files', () => {
  const root = tmpRoot();
  const target = path.join(root, '.promptlog', 'sessions', 'atomic.json');
  store.writeAtomic(target, '{"a":1}\n');
  store.writeAtomic(target, '{"a":2}\n');
  expect(fs.readFileSync(target, 'utf8')).toBe('{"a":2}\n');
  const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.includes('.tmp'));
  expect(leftovers).toEqual([]); // tmp file renamed away
  // The rename is atomic: at no point is a reader able to see a truncated
  // file. Emulate a crash between writes by forcing the write itself to
  // fail: a plain file in the way of the target directory makes `mkdirSync`
  // reject with ENOTDIR/EEXIST on every platform (a POSIX-only unwritable
  // path like `/proc/...` is not such a thing on Windows, where that string
  // is just an ordinary, creatable path on the current drive).
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  expect(() => store.writeAtomic(path.join(blocker, 'x.json'), 'x')).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('{"a":2}\n'); // the earlier write survives
  rmTree(root);
});

test('reindex regenerates index.jsonl from the session documents', () => {
  const root = tmpRoot();
  upsert(
    root,
    [
      turn({ id: '5043cd5', fullId: 'u1', tsMicros: 1788000000 * S }),
      turn({
        id: '0eeb962',
        fullId: 'u2',
        tsMicros: 1788001000 * S,
        prompt: 'second prompt\nmore',
        files: new Set(['lib/git.js']),
      }),
    ],
    ['a'.repeat(40)],
  );

  const res = storeIndex.reindex(root);
  expect(res.count).toBe(2);
  const lines = fs.readFileSync(store.indexPath(root), 'utf8').trim().split('\n');
  expect(lines.length).toBe(3); // header line + 2 records
  const header = JSON.parse(lines[0] ?? '');
  expect(header._promptlog_index).toBe(1);
  expect(header.head).toBe(null); // no HEAD in a repo-less tmp dir
  expect(header.sessions).toMatch(/^[0-9a-f]{64}$/);
  expect(header.builtAt).toMatch(/Z$/);
  const first = JSON.parse(lines[1] ?? '');
  expect(Object.keys(first).sort()).toEqual([
    'agent',
    'attributedFiles',
    'commits',
    'durationS',
    'files',
    'first',
    'gid',
    'id',
    'in',
    'out',
    'session',
    'ts',
  ]);
  expect(first.gid).toBe(GID);
  const second = JSON.parse(lines[2] ?? '');
  expect(second.first).toBe('second prompt'); // first line only
  expect(second.files).toEqual(['lib/git.js']);
  expect(second.commits).toEqual(['a'.repeat(40)]); // the index line carries shas only
  expect(second.attributedFiles).toBe(0); // no per-file evidence for this sha
  // Ordered by timestamp, and fully regenerated (stale lines are dropped).
  fs.writeFileSync(store.indexPath(root), 'garbage\n');
  storeIndex.reindex(root);
  expect(fs.readFileSync(store.indexPath(root), 'utf8').trim().split('\n').length).toBe(3);
  rmTree(root);
});

test('index.jsonl header freshness: fresh right after reindex, stale once a session doc changes', () => {
  const root = tmpRoot();
  upsert(root, [turn()], ['a'.repeat(40)]);
  storeIndex.reindex(root);
  expect(storeIndex.indexIsFresh(root)).toBe(true);

  // A session doc is rewritten (a new sync/commit): the sessions fingerprint
  // changes and the cached index is stale until the next reindex.
  upsert(root, [turn({ id: '0eeb962', fullId: 'u2' })]);
  expect(storeIndex.indexIsFresh(root)).toBe(false);
  const res = storeIndex.ensureIndexFresh(root);
  expect(res.rebuilt).toBe(true);
  expect(storeIndex.indexIsFresh(root)).toBe(true);
  expect(storeIndex.ensureIndexFresh(root).rebuilt).toBe(false); // no rebuild needed twice in a row

  // A missing/corrupt index is never "fresh".
  fs.writeFileSync(store.indexPath(root), 'not json at all\n');
  expect(storeIndex.indexIsFresh(root)).toBe(false);
  rmTree(root);
});

test('renderReadme writes a mermaid gitGraph and a markdown table', () => {
  const root = tmpRoot();
  upsert(
    root,
    [
      turn({ id: '5043cd5', fullId: 'u1', parentId: null, tsMicros: 1788000000 * S }),
      turn({
        id: '0eeb962',
        fullId: 'u2',
        parentId: 'u1',
        tsMicros: 1788001000 * S,
        prompt: 'second | prompt',
        durationS: 720,
      }),
    ],
    ['a'.repeat(40), 'b'.repeat(40)],
  );
  const { text } = renderReadmeMod.renderReadme(root);

  expect(text).toMatch(/```mermaid/);
  expect(text).toMatch(/gitGraph LR:/);
  expect(text).toMatch(/commit id: "5043cd5"/);
  // Commits appear as a tag suffix on the commit line, per DESIGN.md.
  expect(text).toMatch(/commit id: "0eeb962" tag: "12m · ↑\d[^"]*· 2 commits"/);

  // The table has the documented columns and linked short shas.
  expect(text).toMatch(/\| prompt \| time \| duration \| tokens \| first line \| commits \|/);
  expect(text).toMatch(/\| `claude:c86e0429:5043cd5` \|/);
  expect(text).toMatch(/\[`aaaaaaa`\]\(\.\.\/\.\.\/commit\/a{40}\)/);
  expect(text).toMatch(/second \\\| prompt/); // pipes escaped in the table
  expect(text).toMatch(/\| 2026-\d{2}-\d{2} \d{2}:\d{2}Z \|/); // compact UTC time column
  // No homepage in package.json -> plain text, never a bare placeholder URL.
  expect(text).not.toMatch(/\(https:\/\/github\.com\/\)/);
  expect(fs.existsSync(store.readmePath(root))).toBeTruthy();
  rmTree(root);
});

test('renderReadme tags a single commit in the singular and omits zero', () => {
  const root = tmpRoot();
  upsert(root, [turn({ id: 'aaa1111', fullId: 'u1' })], ['a'.repeat(40)]);
  upsert(root, [turn({ id: 'bbb2222', fullId: 'u2', tsMicros: 1788002000 * S, parentId: 'u1' })], []);
  const { text } = renderReadmeMod.renderReadme(root);
  expect(text).toMatch(/commit id: "aaa1111" tag: "[^"]*1 commit"/);
  const bbbLine = text.split('\n').find((l) => l.includes('"bbb2222"')) ?? '';
  expect(bbbLine).not.toMatch(/\d+ commits?"/); // no commit count when there are none
  rmTree(root);
});

test('initStore registers the session/README merge drivers exactly once and never the old union line', () => {
  const root = tmpRoot();
  store.initStore(root);
  store.initStore(root);
  const text = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  expect(text.split('\n').filter((l) => l.trim() === store.SESSIONS_MERGE_LINE).length).toBe(1);
  expect(text.split('\n').filter((l) => l.trim() === store.README_MERGE_LINE).length).toBe(1);
  expect(text).not.toMatch(/merge=union/); // the old index.jsonl merge=union line is never written
  expect(fs.existsSync(store.indexPath(root))).toBeTruthy();
  expect(fs.existsSync(store.sessionsDir(root))).toBeTruthy();

  // .promptlog/.gitignore keeps the index out of git entirely.
  const gi = fs.readFileSync(path.join(root, '.promptlog', '.gitignore'), 'utf8');
  expect(gi.split('\n').filter((l) => l.trim() === 'index.jsonl').length).toBe(1);
  rmTree(root);
});

test('ensureGitattributes migrates away a pre-v0.3 merge=union line', () => {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, '.gitattributes'),
    '.promptlog/index.jsonl merge=union\nsome/other.file text\n',
    'utf8',
  );
  store.ensureGitattributes(root);
  const text = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  expect(text).not.toMatch(/merge=union/);
  expect(text).toMatch(/some\/other\.file text/); // unrelated lines are preserved
  expect(text).toMatch(new RegExp(store.SESSIONS_MERGE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  expect(text).toMatch(new RegExp(store.README_MERGE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  rmTree(root);
});

test('homeCollapse / homeExpand round-trip', () => {
  const p = path.join(os.homedir(), '.claude', 'projects', 'x.jsonl');
  // Portable text: always `~/` with forward slashes, never the host
  // separator (DESIGN.md "Repo store").
  expect(store.homeCollapse(p)).toBe('~/.claude/projects/x.jsonl');
  expect(store.homeExpand(store.homeCollapse(p))).toBe(p);
});

test('README and index sanitise cell-breaking prompt text', () => {
  const root = tmpRoot();
  const nasty = 'fix `a | b` in the table\nsecond line should not appear';
  upsert(root, [turn({ id: 'ffff000', fullId: 'u1', prompt: nasty })], ['a'.repeat(40)]);

  storeIndex.reindex(root);
  const idx = JSON.parse(fs.readFileSync(store.indexPath(root), 'utf8').trim().split('\n')[1] ?? '');
  expect(idx.first).toBe('fix `a | b` in the table'); // index keeps one line only
  expect(idx.first).not.toMatch(/[\r\n]/);
  expect(idx.first).toBe(idx.first.replace(/\s+$/, '')); // no trailing whitespace

  const { text } = renderReadmeMod.renderReadme(root);
  const row = text.split('\n').find((l) => l.startsWith('| `claude:') && l.includes('ffff000')) ?? '';
  expect(row.startsWith('|') && row.endsWith('|')).toBeTruthy(); // one well-formed row
  // Six columns means exactly seven pipes, and the escaped one must not count.
  expect(row.replace(/\\\|/g, '').split('|').length - 1).toBe(7); // six columns
  expect(row).toMatch(/fix a \\\| b in the table/); // backticks stripped, pipe escaped
  expect(row).not.toMatch(/second line/); // only the first line is used
  rmTree(root);
});

test('firstLine leaves no trailing whitespace after truncation', () => {
  const padded = `${'a'.repeat(78)}   tail`;
  expect(storeIndex.firstLine(padded, 80)).toBe('a'.repeat(78));
  expect(storeIndex.firstLine('  spaced out  ')).toBe('spaced out');
});

test('redaction fails CLOSED: a throwing redactor writes nothing', () => {
  const root = tmpRoot();
  // Hijack redact() so it throws, exactly as a broken/absent redactor would.
  // Storing plaintext here would leak the very thing we promise to strip.
  const spy = vi.spyOn(redactModule, 'redact').mockImplementation(() => {
    throw new Error('boom');
  });
  try {
    let caught: unknown;
    try {
      upsert(root, [turn({ prompt: `my token is ${AWS_KEY}` })]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(sessionRecords.RedactionUnavailable);
    expect((caught as Error).message).toMatch(/redaction unavailable/);
    // Nothing at all was written: no session document, no index line.
    expect(sessionRecords.listSessionDocs(root)).toEqual([]);
    expect(fs.existsSync(store.sessionDocPath(root, 'claude', SID))).toBe(false);
    // And buildRecord alone refuses too, so no caller can sneak past it.
    expect(() =>
      sessionRecords.buildRecord(turn(), { agent: 'claude', sessionId: SID, config: store.DEFAULT_CONFIG }),
    ).toThrow(/redaction unavailable/);
  } finally {
    spy.mockRestore();
  }
  // With the real redactor back, the same write succeeds and is redacted.
  const { doc } = upsert(root, [turn({ prompt: `my token is ${AWS_KEY}` })]);
  const rec = doc.turns[GID];
  if (!rec) throw new Error('expected a record');
  expect(rec.prompt).not.toMatch(new RegExp(AWS_KEY));
  expect(rec.prompt).toMatch(/\[redacted:/);
  rmTree(root);
});

test('remapCommits prefix matching is one-directional and needs 7+ chars', () => {
  const root = tmpRoot();
  const full = 'abcdef1234567890abcdef1234567890abcdef12';
  upsert(root, [turn({ fullId: 'u1' })], [full]);

  // Too short to be unambiguous: ignored.
  sessionRecords.remapCommits(root, new Map([['abcde', 'f'.repeat(40)]]));
  expect(sessionRecords.commitShas(sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID])).toEqual([
    full,
  ]);

  // A stored value must not swallow a LONGER mapping key (the old
  // `o.startsWith(sha)` direction): 'abcdef1234567890...' does not start with
  // a 40-char key that merely shares a prefix.
  sessionRecords.remapCommits(root, new Map([['abcdef1234567890abcdef1234567890abcdefFF', 'e'.repeat(40)]]));
  expect(sessionRecords.commitShas(sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID])).toEqual([
    full,
  ]);

  // A real 7-char abbreviation of the stored sha does map.
  sessionRecords.remapCommits(root, new Map([['abcdef1', 'd'.repeat(40)]]));
  expect(sessionRecords.commitShas(sessionRecords.readSessionDoc(root, 'claude', SID)?.turns[GID])).toEqual([
    'd'.repeat(40),
  ]);
  rmTree(root);
});

test('withLock serialises mutations and breaks a stale lock', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const lock = store.lockPath(root);

  let ran = false;
  store.withLock(root, () => {
    ran = true;
    expect(fs.existsSync(lock)).toBeTruthy(); // held while running
  });
  expect(ran).toBeTruthy();
  expect(fs.existsSync(lock)).toBeFalsy(); // released afterwards

  // A lock older than 10 s is a killed hook: break it rather than hang.
  fs.writeFileSync(lock, '999999\n');
  const old = Date.now() - 60000;
  fs.utimesSync(lock, new Date(old), new Date(old));
  let ran2 = false;
  const t0 = Date.now();
  store.withLock(root, () => {
    ran2 = true;
  });
  expect(ran2).toBeTruthy(); // stale lock broken
  expect(Date.now() - t0 < 1500).toBeTruthy(); // did not wait out the full timeout
  expect(fs.existsSync(lock)).toBeFalsy();
  rmTree(root);
});

test('an out-of-repo absolute file path is home-collapsed and redacted', () => {
  const root = tmpRoot();
  const secretish = path.join(os.homedir(), 'scratch', `${AWS_KEY}.json`);
  const { doc } = upsert(root, [
    turn({
      files: new Set(['lib/store.js', secretish, '/etc/hosts']),
    }),
  ]);
  const rec = doc.turns[GID];
  if (!rec) throw new Error('expected a record');
  // Inside the repo: repo-relative. Outside: `~`-collapsed, never the real home.
  expect(rec.files.includes('lib/store.js')).toBeTruthy();
  expect(rec.files.includes('/etc/hosts')).toBeTruthy();
  expect(rec.files.some((f) => f.startsWith(os.homedir()))).toBeFalsy(); // home leaked
  const collapsed = rec.files.find((f) => f.startsWith('~/'));
  expect(collapsed).toBeTruthy(); // an out-of-repo path is collapsed
  // ...and it went through the redactor like every other stored string.
  expect(collapsed).not.toMatch(new RegExp(AWS_KEY));
  expect(collapsed).toMatch(/\[redacted:aws-key:[0-9a-f]{4}\]/);
  expect(rec.redactions.some((f) => f.kind === 'aws-key')).toBeTruthy(); // and the finding is recorded
  rmTree(root);
});

test('homeCollapse handles a realpath-different home (macOS /private/var)', () => {
  const home = os.homedir();
  expect(store.homeCollapse(path.join(home, 'x'))).toBe('~/x');
  expect(store.homeCollapse('')).toBe('');
  expect(store.homeCollapse('relative/path.js')).toBe('relative/path.js');
  // A path that only matches after resolving symlinks is still collapsed: on
  // macOS `/var/...` and `/private/var/...` are the same directory.
  const real = fs.realpathSync(home);
  if (real !== home) {
    expect(store.homeCollapse(path.join(real, 'x'))).toBe('~/x');
  }
});

test('sessionsFingerprint changes when a document changes without changing size', () => {
  const root = tmpRoot();
  upsert(root, [turn()], ['a'.repeat(40)]);
  const before = storeIndex.sessionsFingerprint(root);
  // A sha swapped for another of the same length, in the same millisecond: a
  // size+mtime fingerprint calls this unchanged, which left `reindex` serving
  // a stale index after every post-rewrite remap.
  const file = store.sessionDocPath(root, 'claude', SID);
  const st = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a'.repeat(40), 'b'.repeat(40)));
  fs.utimesSync(file, st.atime, st.mtime);
  expect(fs.statSync(file).size).toBe(st.size); // same byte count
  expect(storeIndex.sessionsFingerprint(root)).not.toBe(before); // the fingerprint must notice
  rmTree(root);
});

test('initStore gitignores the index, the cache dir and atomic-write temp files', () => {
  const root = tmpRoot();
  store.initStore(root);
  const text = fs.readFileSync(path.join(root, '.promptlog', '.gitignore'), 'utf8');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const want of ['index.jsonl', '.cache/', '.*.tmp']) {
    expect(lines.includes(want)).toBeTruthy();
  }
  // Idempotent, and it never duplicates a line a second init would add.
  store.initStore(root);
  const again = fs
    .readFileSync(path.join(root, '.promptlog', '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  expect(again).toEqual(lines);
  rmTree(root);
});
