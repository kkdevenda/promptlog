/**
 * Git helpers for promptlog: running git, commit windows, trailers, the
 * staged diff the attributor matches against, notes mirroring and
 * post-rewrite sha remapping.
 *
 * Nothing here throws for an ordinary git failure: callers get
 * `{ code, stdout, stderr }` and decide. promptlog must always fail open.
 */

import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import path from 'node:path';
import { toRepoRel } from './fsutil';
import type { Turn } from './model';

export const TRAILER_KEY = 'Prompt-Id';

/** git's hash of the empty tree: what to diff the index against with no HEAD. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * One shared deadline for a whole commit's worth of hooks (DESIGN.md
 * "Hooks"). While it is set, no child git process may be given a timeout
 * that would let it outlive the budget: three hooks x 2 s each would
 * otherwise add six seconds to a commit, and a stuck child would sit there
 * for all of it.
 *
 * The budget itself is platform-aware: every git spawn costs several hundred
 * ms more on Windows than elsewhere, so the POSIX budget (2.5 s) was
 * routinely exhausted by the time `post-commit` ran, silently skipping
 * `promptlog.amend`'s amend step there. The single constant is used
 * everywhere the budget appears - `hooks.ts`'s `openBudget`, and
 * `dispatch.ts`'s own watchdog around the whole `promptlog hook <name>`
 * child, which must stay longer than this or it would kill that child before
 * the budget it is honoring even runs out.
 */
export const HOOK_BUDGET_MS = process.platform === 'win32' ? 6000 : 2500;
let deadlineAt: number | null = null;

export function setDeadline(epochMs: number): void {
  deadlineAt = Number.isFinite(epochMs) ? epochMs : null;
}

export function clearDeadline(): void {
  deadlineAt = null;
}

/** Milliseconds left in the shared budget, or null when none is set. */
export function remainingBudget(): number | null {
  return deadlineAt == null ? null : deadlineAt - Date.now();
}

const MIN_CHILD_TIMEOUT = 150;

export interface GitOptions {
  cwd?: string;
  input?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  error: Error | null;
}

/**
 * Run git with `args`. Never throws.
 *
 * Under a live hook budget (`setDeadline`), the requested timeout is clamped
 * to what is left - otherwise three hooks x their own timeout could add
 * seconds to a commit regardless of the budget. That clamp can starve a
 * git spawn that would have succeeded given its usual timeout: on a slow
 * runner (Windows CI is the known case) the child is killed mid-work and
 * this returns `ok: false` exactly as it would for an ordinary git failure -
 * indistinguishable to every caller, so `stagedHunks`/`stagedBlobHash`
 * silently see "nothing" instead of "ran out of time". That is the one case
 * where a failure here is worth a diagnostic: fail open still (the caller's
 * existing empty-result handling is unchanged), but say so on stderr so it
 * is not mistaken for "no evidence".
 */
export function git(args: string[], options: GitOptions = {}): GitResult {
  const { cwd = process.cwd(), input, env } = options;
  let timeout = options.timeout ?? 2000;
  const left = remainingBudget();
  const clamped = left != null && left < timeout;
  if (left != null) timeout = Math.max(MIN_CHILD_TIMEOUT, Math.min(timeout, left));
  const spawnOptions: SpawnSyncOptions = {
    cwd,
    input,
    timeout,
    encoding: 'utf8',
    env: env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  };
  const res = spawnSync('git', args, spawnOptions);
  const stdout = res.stdout == null ? '' : String(res.stdout);
  const stderr = res.stderr == null ? '' : String(res.stderr);
  const code = res.error ? 1 : (res.status ?? 1);
  if (res.error && clamped) {
    process.stderr.write(
      `promptlog: git ${args[0]} did not finish within ${timeout}ms (hook budget nearly spent) - treated as no result, not an error\n`,
    );
  }
  return { code, stdout, stderr, ok: code === 0, error: res.error ?? null };
}

/** Alias kept for callers that read better as `git.run(...)`. */
export const run = git;

/** Repo root for `cwd`, or null. */
export function repoRoot(cwd: string): string | null {
  const r = git(['rev-parse', '--show-toplevel'], { cwd });
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return out ? out : null;
}

/** Is this repo opted in (`git config --get promptlog.enabled` === true)? */
export function isEnabled(cwd: string): boolean {
  const r = git(['config', '--get', 'promptlog.enabled'], { cwd });
  return r.ok && r.stdout.trim() === 'true';
}

export function configGet(cwd: string, key: string): string | null {
  const r = git(['config', '--get', key], { cwd });
  return r.ok ? r.stdout.trim() : null;
}

export function configSetLocal(cwd: string, key: string, value: string | number | boolean): GitResult {
  return git(['config', key, String(value)], { cwd });
}

/** True when HEAD exists (repo has at least one commit). */
export function hasHead(cwd: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).ok;
}

/** Committer date of HEAD as epoch microseconds, or null when no commits. */
export function headCommitTime(cwd: string): number | null {
  if (!hasHead(cwd)) return null;
  const r = git(['log', '-1', '--format=%ct', 'HEAD'], { cwd });
  if (!r.ok) return null;
  const secs = Number.parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(secs)) return null;
  return secs * 1000000;
}

export function headSha(cwd: string): string | null {
  const r = git(['rev-parse', 'HEAD'], { cwd });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Repo-relative paths of files staged in the index.
 *
 * Before the first commit there is no HEAD to diff against, so the index is
 * compared with the empty tree instead. That fallback is chosen from the
 * ABSENCE OF A HEAD, never from an empty result: an empty index with a HEAD
 * (`git commit --allow-empty`) genuinely stages nothing, and diffing it
 * against the empty tree would report every tracked file in the repo as
 * staged - which the attributor would then hand to whoever last edited them.
 */
export function stagedFiles(cwd: string): string[] {
  const args = ['diff', '--cached', '--name-only', '--diff-filter=ACMRT'];
  const r = hasHead(cwd) ? git(args, { cwd }) : git(args.concat([EMPTY_TREE]), { cwd });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Files changed by a commit. */
export function commitFiles(cwd: string, sha: string): string[] {
  const r = git(['show', '--pretty=format:', '--name-only', sha], { cwd });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function commitMessage(cwd: string, sha: string): string {
  const r = git(['log', '-1', '--format=%B', sha], { cwd });
  return r.ok ? r.stdout : '';
}

// ---------------------------------------------------------------- trailers

/** `["a","b"]` -> "Prompt-Id: a\nPrompt-Id: b\n" (deduped, order kept). */
export function formatTrailers(gids: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of gids ?? []) {
    const v = String(g).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(`${TRAILER_KEY}: ${v}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/**
 * Extract Prompt-Id values from a commit message. Uses
 * `git interpret-trailers --parse` when git is available, and falls back to
 * a line scan so this stays usable with no repo (and in unit tests).
 */
export function parseTrailers(message: string | null | undefined, options: { cwd?: string } = {}): string[] {
  const { cwd = process.cwd() } = options;
  const text = String(message ?? '');
  let lines: string[] | null = null;
  const r = git(['interpret-trailers', '--parse'], { cwd, input: text });
  if (r.ok) lines = r.stdout.split('\n');
  if (!lines) lines = text.split('\n');
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`^${TRAILER_KEY}\\s*:\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const v = (m[1] as string).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Every `Prompt-Id:` line anywhere in a commit message, trailer block or not.
 *
 * `reindex` needs this rather than `parseTrailers`: a squash merge folds the
 * squashed messages into the body, so the ids end up mid-message where
 * `git interpret-trailers --parse` cannot see them. The line must START with
 * the key, so a body mentioning "Prompt-Id: x" inline mid-sentence is still
 * not picked up.
 */
export function parseAllPromptIds(message: string | null | undefined): string[] {
  const re = new RegExp(`^\\s*${TRAILER_KEY}\\s*:\\s*(.+?)\\s*$`, 'i');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(message ?? '').split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const v = (m[1] as string).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Does this text's LAST paragraph already look like a trailer block?
 *
 * git's own rule: trailers live in the final paragraph, every line of which
 * must be `Token: value` (or a folded continuation, indented). A message
 * with only one paragraph has no trailer block at all - that paragraph is
 * the subject, and a subject like `readme: initial` merely has the SHAPE of
 * a trailer.
 */
export function lastParagraphIsTrailers(text: string | null | undefined): boolean {
  const paragraphs = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p.trim() !== '');
  if (paragraphs.length < 2) return false; // subject only: no trailer block
  const lastParagraph = paragraphs[paragraphs.length - 1] as string;
  const lines = lastParagraph.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return false;
  let sawToken = false;
  for (const line of lines) {
    if (/^\s/.test(line)) {
      if (!sawToken) return false; // a continuation with nothing to continue
      continue;
    }
    // `Token: value`, or a `(cherry picked from ...)`-style git-generated line.
    if (/^[A-Za-z0-9][A-Za-z0-9-]*\s*:\s*\S/.test(line) || /^\(.*\)$/.test(line)) {
      sawToken = true;
      continue;
    }
    return false;
  }
  return sawToken;
}

/**
 * Append trailers to a commit message body, skipping any gid already
 * present. Returns the new message text (unchanged when there is nothing to
 * add).
 *
 * The block must end up as the message's last paragraph, so a blank line is
 * inserted when the message does not already end with one - but ONLY then.
 * Splitting an existing trailer paragraph (`Signed-off-by:`,
 * `Co-Authored-By:`) into two would take every trailer in it out of the last
 * paragraph, and `git interpret-trailers --parse` would stop seeing them:
 * sign-offs would silently vanish from the commit as far as any tool that
 * reads them is concerned.
 */
export function appendTrailers(
  message: string | null | undefined,
  gids: string[],
  options: { cwd?: string } = {},
): string {
  const { cwd = process.cwd() } = options;
  const existing = new Set(parseTrailers(message, { cwd }));
  const fresh = (gids ?? []).filter((g) => !existing.has(String(g).trim()));
  if (!fresh.length) return String(message ?? '');
  let text = String(message ?? '');
  const block = formatTrailers(fresh);
  if (!text.endsWith('\n')) text += '\n';
  if (text.trim() && !lastParagraphIsTrailers(text)) text += '\n';
  return text + block;
}

// ------------------------------------------------------------ turn windows

export interface SelectTurnsOptions {
  since?: number | null;
  until?: number | null;
  activeLast?: boolean;
}

/** Minimal shape `selectTurns`/`activeTurn` need from a turn. */
export type WindowTurn = Pick<Turn, 'tsMicros' | 'durationS'>;

/**
 * Turns of `session` whose window [ts, ts + durationS] overlaps
 * `(since, until]`. `since`/`until` are epoch microseconds; `since` null
 * means "since the session started" (everything).
 *
 * `activeLast` forces the session's LAST turn to be selected whatever the
 * window says. That turn is the one the user is inside right now, so a
 * commit issued from it belongs to it - but its `durationS` is derived from
 * the last record written to the transcript *so far*, which is already in
 * the past by the time the commit lands. Trusting the window loses it on
 * every commit after the first: the first commit's committer date becomes
 * `since`, the stale end falls before it, and rapid successive commits get
 * no trailers.
 *
 * Note that "the turn has no assistant text yet" is NOT a usable signal for
 * this - agents narrate between tool calls, so the parser's
 * `responsePending` is false for most of a turn's life. Active-ness is
 * decided by the caller from how the session was identified and the
 * transcript's mtime; see `activeLastFor` in `src/core/commands/repo.ts`.
 */
export function selectTurns<T extends WindowTurn>(
  session: { turns?: T[] } | null | undefined,
  { since = null, until = null, activeLast = false }: SelectTurnsOptions = {},
): T[] {
  const turns = session?.turns ?? [];
  const hi = until == null ? Number.MAX_SAFE_INTEGER : until;
  const last = turns.length ? turns[turns.length - 1] : null;
  return turns.filter((t) => {
    const start = Number(t.tsMicros);
    if (!Number.isFinite(start)) return false;
    if (activeLast && t === last) return true;
    const end = start + Math.max(0, Number(t.durationS) || 0) * 1000000;
    if (start > hi) return false;
    if (since == null) return true;
    return end > since;
  });
}

/** The session's last turn: the one a commit is being issued from. */
export function activeTurn<T extends WindowTurn>(session: { turns?: T[] } | null | undefined): T | null {
  const turns = session?.turns ?? [];
  return turns.length ? (turns[turns.length - 1] as T) : null;
}

// -------------------------------------------------------- disambiguation

export function normalizeRepoPath(p: string | null | undefined, root: string | null | undefined): string {
  let s = String(p ?? '');
  if (!s) return '';
  if (path.isAbsolute(s) && root) {
    const rel = toRepoRel(root, s);
    if (rel && !rel.startsWith('..')) s = rel;
  }
  return s.split(path.sep).join('/').replace(/^\.\//, '');
}

// "Highest overlap wins" used to live here, picking ONE session per commit
// from file-name overlap. It has been removed: every candidate session is
// kept and `src/core/attribution.ts` links the turns that can be shown to
// have written the staged hunks. Nothing guesses any more.

// ---------------------------------------------------------- staged diff

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: string[];
  removed: string[];
}

/**
 * Parse unified-diff text (as produced with `-U0`) into
 * `Map<path, DiffHunk[]>`.
 *
 * `-U0` means every hunk is exactly the changed lines, so a hunk's `added`
 * array is precisely what the commit introduces there - which is what the
 * tier A matcher compares an edit's `new_string` against.
 */
export function parseDiffHunks(text: string | null | undefined): Map<string, DiffHunk[]> {
  const files = new Map<string, DiffHunk[]>();
  let file: string | null = null;
  let hunk: DiffHunk | null = null;
  // Split on either line ending: git's own diff format always uses `\n`,
  // but this is defensive against a CRLF-converting filter putting a stray
  // `\r` in front of it (an embedded `\r` in a content line is stripped by
  // `normLine` downstream regardless).
  for (const line of String(text ?? '').split(/\r\n|\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null;
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p === '/dev/null') {
        file = null; // deletion: nothing in the new tree to attribute
      } else {
        file = p.replace(/^b\//, '');
        if (!files.has(file)) files.set(file, []);
      }
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || !file) {
        hunk = null;
        continue;
      }
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] == null ? 1 : Number(m[4]),
        added: [],
        removed: [],
      };
      (files.get(file) as DiffHunk[]).push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.added.push(line.slice(1));
    else if (line.startsWith('-')) hunk.removed.push(line.slice(1));
  }
  return files;
}

/** `git diff --cached -U0` for the whole index, parsed into hunks per path.
 * Same empty-tree rule as `stagedFiles`: no HEAD, not "no output". */
export function stagedHunks(cwd: string): Map<string, DiffHunk[]> {
  const args = [
    'diff',
    '--cached',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--diff-filter=ACMRT',
  ];
  const r = hasHead(cwd)
    ? git(args, { cwd, timeout: 10000 })
    : git(args.concat([EMPTY_TREE]), { cwd, timeout: 10000 });
  if (!r.ok) return new Map();
  return parseDiffHunks(r.stdout);
}

/** The blob id git has staged for `relPath`, or null. */
export function stagedBlobHash(cwd: string, relPath: string): string | null {
  const r = git(['rev-parse', `:${relPath}`], { cwd });
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** `git hash-object --stdin` for content, for parity with git's own hashing. */
export function hashObject(cwd: string, content: string | null | undefined): string | null {
  const r = git(['hash-object', '--stdin'], { cwd, input: String(content ?? '') });
  if (!r.ok) return null;
  const out = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(out) ? out : null;
}

// -------------------------------------------------------------- post-rewrite

/**
 * Parse `post-rewrite` stdin: one "<old-sha> <new-sha>" pair per line.
 * Returns a Map old -> new.
 */
export function parseRewriteStdin(text: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const oldSha = parts[0] as string;
    const newSha = parts[1] as string;
    if (!/^[0-9a-f]{7,40}$/i.test(oldSha) || !/^[0-9a-f]{7,40}$/i.test(newSha)) continue;
    map.set(oldSha, newSha);
  }
  return map;
}

// -------------------------------------------------------------- notes mirror

export const NOTES_REF = 'refs/notes/promptlog';

/** Mirror the gids of HEAD into refs/notes/promptlog. */
export function notesAdd(cwd: string, gids: Iterable<string>, options: { sha?: string } = {}): GitResult {
  const { sha = 'HEAD' } = options;
  const payload = JSON.stringify({ gids: Array.from(gids ?? []) });
  return git(['notes', '--ref=promptlog', 'add', '-f', '-m', payload, sha], { cwd });
}

/** Configure notes rewriting + the origin refspec (best effort). */
export function notesConfigure(cwd: string): void {
  configSetLocal(cwd, 'notes.rewriteRef', NOTES_REF);
  const remotes = git(['remote'], { cwd });
  if (
    remotes.ok &&
    remotes.stdout
      .split('\n')
      .map((s) => s.trim())
      .includes('origin')
  ) {
    const refspec = `+${NOTES_REF}:${NOTES_REF}`;
    const existing = git(['config', '--get-all', 'remote.origin.fetch'], { cwd });
    if (!(existing.ok && existing.stdout.split('\n').some((l) => l.trim() === refspec))) {
      git(['config', '--add', 'remote.origin.fetch', refspec], { cwd });
    }
    const push = git(['config', '--get-all', 'remote.origin.push'], { cwd });
    if (!(push.ok && push.stdout.split('\n').some((l) => l.trim() === refspec))) {
      git(['config', '--add', 'remote.origin.push', refspec], { cwd });
    }
  }
}
