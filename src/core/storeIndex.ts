/**
 * `.promptlog/index.jsonl`: the derived, lazily-rebuilt read index over the
 * session documents, plus the commit-trailer scan (and its `.cache/`
 * cache) that keeps every record's `commits` list in sync with what git
 * actually says.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as gitmod from './git';
import { isRecord, num, rec, str, tryParse } from './json';
import type { CommitEntry } from './records';
import { allRecords, listSessionDocs, normalizeCommits } from './sessionRecords';
import { indexPath, readJson, sessionsDir, sha256, trailerCachePath, withLock, writeAtomic } from './store';

export function firstLine(text: string | null | undefined, max = 80): string {
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (t) return (t.length > max ? t.slice(0, max) : t).replace(/\s+$/, '');
  }
  return '';
}

// ------------------------------------------------------------ index header

const INDEX_HEADER_VERSION = 1;

export interface IndexHeader {
  _promptlog_index: number;
  head: string | null;
  sessions: string;
  builtAt: string;
}

/**
 * A fingerprint of the session documents, for the index's freshness header.
 *
 * The CONTENT is hashed, not `size:mtime`: two writes in the same
 * millisecond that keep the byte count identical (a sha swapped for another
 * sha by `post-rewrite`, a role changing from `contributor` to `both`) are
 * exactly what the hooks do, and a stat-based fingerprint calls the stale
 * index fresh. The documents are small - a few KB each - so hashing them is
 * cheaper than the rebuild it prevents.
 */
export function sessionsFingerprint(root: string): string {
  const dir = sessionsDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    names = [];
  }
  names.sort();
  const parts: string[] = [];
  for (const n of names) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(dir, n));
    } catch {
      continue;
    }
    parts.push(`${n}:${crypto.createHash('sha256').update(content).digest('hex')}`);
  }
  return sha256(parts.join('\n'));
}

function currentHeadSha(root: string): string | null {
  return gitmod.headSha(root);
}

function parseIndexHeader(text: string): IndexHeader | null {
  const r = rec(tryParse(text));
  if (!r || num(r._promptlog_index) !== INDEX_HEADER_VERSION) return null;
  const sessions = str(r.sessions);
  const builtAt = str(r.builtAt);
  if (sessions == null || builtAt == null) return null;
  return { _promptlog_index: INDEX_HEADER_VERSION, head: str(r.head), sessions, builtAt };
}

/** Read just the header line of index.jsonl, without loading the whole file. */
export function readIndexHeader(root: string): IndexHeader | null {
  let fd: number;
  try {
    fd = fs.openSync(indexPath(root), 'r');
  } catch {
    return null;
  }
  let firstLineText = '';
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    firstLineText = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  return parseIndexHeader(firstLineText);
}

/**
 * Is index.jsonl's cached header still good for the repo as it stands now?
 * False for a missing/corrupt/pre-header index, a HEAD that has moved (a
 * pull, a new commit made by another clone's hooks that never touched this
 * checkout) or a sessions listing that has changed (a merge, a new session
 * doc written by `sync`).
 */
export function indexIsFresh(root: string): boolean {
  const header = readIndexHeader(root);
  if (!header) return false;
  if ((header.head ?? null) !== (currentHeadSha(root) ?? null)) return false;
  if (header.sessions !== sessionsFingerprint(root)) return false;
  return true;
}

/**
 * Warm the index.jsonl cache if it is stale or missing, per DESIGN.md
 * "index.jsonl": "Lazy: header line with HEAD sha and a hash of the sessions
 * listing; rebuild on mismatch at next read." Every repo-store read path
 * (`show`, `grep`, `files`, `reindex`, `doctor`) calls this before reading
 * records.
 */
export function ensureIndexFresh(root: string): { rebuilt: boolean } {
  if (indexIsFresh(root)) return { rebuilt: false };
  reindex(root);
  return { rebuilt: true };
}

interface RefState {
  hash: string;
  heads: string[];
}

/** Every ref's sha, as git sees it right now, plus a hash of that listing. */
function refState(root: string): RefState | null {
  const r = gitmod.git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: root, timeout: 10000 });
  if (!r.ok) return null;
  const head = gitmod.headSha(root);
  const text = r.stdout + (head ? `${head} HEAD\n` : '');
  const heads = [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((sha): sha is string => !!sha && /^[0-9a-f]{40}$/.test(sha)),
    ),
  ].sort();
  return { hash: sha256(text), heads };
}

interface TrailerCache {
  version: number;
  hash: string;
  heads: string[];
  commits: number;
  gids: Record<string, string[]>;
}

const TRAILER_CACHE_VERSION = 1;

function readTrailerCache(root: string): TrailerCache | null {
  const r = rec(readJson(trailerCachePath(root)));
  if (!r || num(r.version) !== TRAILER_CACHE_VERSION) return null;
  if (!isRecord(r.gids) || !Array.isArray(r.heads)) return null;
  const heads = r.heads.filter((h): h is string => typeof h === 'string');
  const gids: Record<string, string[]> = {};
  for (const [gid, list] of Object.entries(r.gids)) {
    gids[gid] = Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  }
  return {
    version: TRAILER_CACHE_VERSION,
    hash: str(r.hash) ?? '',
    heads,
    commits: num(r.commits) ?? 0,
    gids,
  };
}

function writeTrailerCache(root: string, payload: TrailerCache): void {
  try {
    fs.mkdirSync(path.dirname(trailerCachePath(root)), { recursive: true });
    writeAtomic(trailerCachePath(root), `${JSON.stringify(payload)}\n`);
  } catch {
    /* the cache is optional by construction */
  }
}

/** Are all of `heads` still reachable from some current ref? */
function stillReachable(root: string, heads: string[]): boolean {
  for (const sha of heads) {
    // One commit is enough to answer it: if anything in `sha`'s history is
    // NOT reachable from the current refs, that head was rewritten or
    // dropped and the cached scan can no longer be trusted to be a subset.
    const r = gitmod.git(['rev-list', '-1', sha, '--not', '--all'], { cwd: root, timeout: 10000 });
    if (!r.ok || r.stdout.trim()) return false;
  }
  return true;
}

interface TrailerScan {
  byGid: Map<string, string[]>;
  commits: number;
}

function scanTrailers(root: string, opts: { notHeads?: string[] } = {}): TrailerScan | null {
  const { notHeads = [] } = opts;
  const args = ['log', '--all', '--format=%H%x00%B%x1e'];
  for (const sha of notHeads) args.push(`^${sha}`);
  const log = gitmod.git(args, { cwd: root, timeout: 20000 });
  if (!log.ok) return null;
  const byGid = new Map<string, string[]>();
  let commits = 0;
  for (const entry of log.stdout.split('\x1e')) {
    const nul = entry.indexOf('\0');
    if (nul < 0) continue;
    const sha = entry.slice(0, nul).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const gids = gitmod.parseAllPromptIds(entry.slice(nul + 1));
    if (!gids.length) continue;
    commits += 1;
    for (const gid of gids) {
      const list = byGid.get(gid) ?? [];
      list.push(sha);
      byGid.set(gid, list);
    }
  }
  return { byGid, commits };
}

interface TrailerIndex extends TrailerScan {
  cached: boolean;
  mode?: 'full' | 'incremental';
}

/**
 * gid -> [sha], from the commit messages, cached in `.promptlog/.cache/`.
 *
 * Reading every commit body of every ref on every commit (and every stale
 * index read) is O(repo history) for work that changes by one commit at a
 * time, and it showed: seconds on a big repo, inside a 2.5 s hook budget.
 * The cache is keyed by a hash of `git for-each-ref` (plus HEAD), so:
 *
 *   refs unchanged      -> no `git log` at all
 *   refs moved forward  -> scan only `--all ^<cached head>...`, union the result
 *   a head was rewritten (rebase, amend, force-fetch, dropped branch)
 *                       -> full rescan, because cached shas may no longer be
 *                          reachable and the trailers are the truth
 *
 * The cache is gitignored, per-clone and disposable: a missing or corrupt
 * one only costs one full scan.
 */
export function trailerIndex(root: string): TrailerIndex | null {
  const refs = refState(root);
  const cached = readTrailerCache(root);
  if (refs && cached && cached.hash === refs.hash) {
    return { byGid: new Map(Object.entries(cached.gids)), commits: cached.commits, cached: true };
  }

  let result: TrailerScan | null = null;
  let mode: 'full' | 'incremental' = 'full';
  if (refs && cached?.heads.length && stillReachable(root, cached.heads)) {
    const fresh = scanTrailers(root, { notHeads: cached.heads });
    if (fresh) {
      const byGid = new Map(Object.entries(cached.gids).map(([g, list]) => [g, [...list]]));
      for (const [gid, shas] of fresh.byGid.entries()) {
        const list = byGid.get(gid) ?? [];
        for (const sha of shas) if (!list.includes(sha)) list.push(sha);
        byGid.set(gid, list);
      }
      result = { byGid, commits: cached.commits + fresh.commits };
      mode = 'incremental';
    }
  }
  if (!result) {
    const full = scanTrailers(root);
    if (!full) return null;
    result = full;
  }

  if (refs) {
    writeTrailerCache(root, {
      version: TRAILER_CACHE_VERSION,
      hash: refs.hash,
      heads: refs.heads,
      commits: result.commits,
      gids: Object.fromEntries(result.byGid.entries()),
    });
  }
  return { cached: false, mode, ...result };
}

function rebuildCommitsLocked(root: string): {
  changed: number;
  commits: number;
  skipped: boolean;
  cached?: boolean;
} {
  const scan = trailerIndex(root);
  if (!scan) return { changed: 0, commits: 0, skipped: true };
  const shasByGid = scan.byGid;
  const commits = scan.commits;

  let changed = 0;
  for (const { file, doc } of listSessionDocs(root)) {
    let dirty = false;
    for (const gid of Object.keys(doc.turns)) {
      const turnRecord = doc.turns[gid];
      if (!turnRecord) continue;
      const stored = normalizeCommits(turnRecord.commits);
      const shas = shasByGid.get(gid) ?? [];
      if (!shas.length) continue; // no trailer anywhere: keep what we have
      const byStoredSha = new Map(stored.map((e) => [e.sha, e]));
      const next = normalizeCommits(
        shas.map((sha): CommitEntry => byStoredSha.get(sha) ?? { sha, role: 'unknown', files: {} }),
      );
      if (JSON.stringify(next) === JSON.stringify(stored)) continue;
      turnRecord.commits = next;
      dirty = true;
      changed += 1;
    }
    if (dirty) writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return { changed, commits, skipped: false, cached: scan.cached };
}

/**
 * Rebuild every record's `commits` list from the commit messages in
 * `git log`.
 *
 * The trailers are the truth (DESIGN.md "index.jsonl"); the stored list is a
 * cache that a rebase, a squash merge or a `--no-verify` commit can
 * invalidate. The WHOLE commit body is scanned for `Prompt-Id:` lines rather
 * than just the trailer block, because a squash merge folds them into the
 * body.
 *
 * Per-file evidence is preserved for a sha that survives; a sha we only
 * learn about from a trailer (someone else's commit, a hand-written one)
 * gets `{ sha, role: 'unknown', files: {} }`. When `git log` cannot be read
 * at all, nothing is touched: a broken git is not evidence that a link is
 * wrong.
 */
export function rebuildCommits(root: string): {
  changed: number;
  commits: number;
  skipped: boolean;
  cached?: boolean;
} {
  return withLock(root, () => rebuildCommitsLocked(root));
}

/**
 * Rebuild index.jsonl from the session documents. Never hand-edited.
 * Slash-command turns are never indexed (see DESIGN.md "Which turns belong
 * to a commit"); this also cleans up any left by an older version.
 *
 * `commits` in an index line stays a plain list of shas - the per-file
 * evidence lives in the session document - and `attributedFiles` counts the
 * files that evidence covers, so `grep`-style tooling can spot a turn that
 * carries a commit but no file-level attribution.
 */
export function reindex(
  root: string,
  opts: { rebuild?: boolean } = {},
): { path: string; count: number; rebuilt: ReturnType<typeof rebuildCommits> | null } {
  const { rebuild = true } = opts;
  let rebuilt: ReturnType<typeof rebuildCommits> | null = null;
  if (rebuild) {
    try {
      rebuilt = rebuildCommits(root);
    } catch {
      rebuilt = null;
    }
  }
  const lines: string[] = [];
  for (const { gid, agent, sessionId, record } of allRecords(root)) {
    if (record.isCommand) continue;
    const entries = normalizeCommits(record.commits);
    const attributed = new Set<string>();
    for (const e of entries) for (const f of Object.keys(e.files)) attributed.add(f);
    lines.push(
      JSON.stringify({
        gid,
        agent,
        session: sessionId,
        ts: record.ts,
        id: record.id,
        first: firstLine(record.prompt, 80)
          .replace(/\r\n|\r|\n/g, ' ')
          .replace(/\s+$/, ''),
        files: record.files,
        commits: entries.map((e) => e.sha),
        attributedFiles: attributed.size,
        durationS: record.durationS,
        out: record.tokens.output,
        in: record.tokens.input,
      }),
    );
  }
  const header: IndexHeader = {
    _promptlog_index: INDEX_HEADER_VERSION,
    head: currentHeadSha(root),
    sessions: sessionsFingerprint(root),
    builtAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(header)}\n${lines.length ? `${lines.join('\n')}\n` : ''}`;
  writeAtomic(indexPath(root), text);
  return { path: indexPath(root), count: lines.length, rebuilt };
}
