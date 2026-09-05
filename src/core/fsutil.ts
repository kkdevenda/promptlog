/**
 * Generic filesystem helpers shared by the core resolver and every agent's
 * locate.ts. Nothing here is agent-specific.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from './json';
import type { JsonRecord } from './model';

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read at most `max` bytes from the front of a file.
 *
 * Session metadata (`cwd`, `sessionId`, Codex's `session_meta`) is always in
 * the first few records, but transcripts routinely run to tens of megabytes:
 * reading them whole to answer "which session am I in" cost ~930 ms over
 * 526 MB on the reviewer's machine. 64 KB is far more than enough.
 */
export const META_HEAD_BYTES = 64 * 1024;

export function readHead(filePath: string, max = META_HEAD_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Every record of a JSONL transcript, in file order. Blank lines, lines that
 * are not JSON and JSON that is not an object are skipped; an unreadable
 * file yields [].
 */
export function readJsonl(filePath: string): JsonRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const records: JsonRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let d: unknown;
    try {
      d = JSON.parse(t);
    } catch {
      continue;
    }
    if (isRecord(d)) records.push(d);
  }
  return records;
}

/** Walk up from `cwd` looking for a `.git` entry (dir or file, the latter
 * for worktrees/submodules). Falls back to `cwd` itself if none is found. */
export function findGitRoot(cwd: string): string {
  let cur = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(cwd);
    cur = parent;
  }
}

/**
 * Canonical form of `p` for comparing two paths that may each have arrived
 * by a different route (a git command's stdout, a transcript's recorded
 * cwd, a hand-built join): resolved to absolute, then `realpath`'d against
 * the longest prefix of it that actually exists on disk
 * (`fs.realpathSync.native`, so Windows' short 8.3 aliases - `RUNNER~1` -
 * collapse to the same real name a sibling process sees, e.g.
 * `runneradmin`, and macOS's `/var` collapses to `/private/var`), then
 * case-folded on win32 (NTFS/ReFS paths are case-insensitive; every other
 * platform's filesystem is not).
 *
 * The longest-EXISTING-prefix rule matters whenever `p` itself no longer
 * exists (a transcript's recorded cwd, a deleted directory) but an ancestor
 * of it does: `realpath`ing only the whole path would then leave it
 * unresolved while a sibling path that does fully exist gets resolved,
 * and the two would stop comparing equal for a reason that has nothing to
 * do with whether they are really the same place.
 *
 * `pathMod` defaults to the real `node:path` and only exists so a unit test
 * can inject `path.win32` to exercise Windows-shaped paths from any host;
 * `realpathSync.native` itself always consults the real filesystem, so the
 * prefix walk only ever resolves anything (and the injected `pathMod` only
 * ever matters for the paths it fails to resolve) when a test's paths
 * genuinely exist on the host running it.
 */
export function canonicalPath(
  p: string,
  pathMod: Pick<typeof path, 'resolve' | 'dirname' | 'sep'> = path,
): string {
  let dir = pathMod.resolve(p);
  const tail: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      dir = fs.realpathSync.native(dir);
      break;
    } catch {
      const parent = pathMod.dirname(dir);
      if (parent === dir) break; // reached a root with nothing resolvable
      tail.push(dir.slice(parent.length).replace(/^[\\/]/, ''));
      dir = parent;
    }
  }
  const r = tail.length ? [dir, ...tail.reverse()].join(pathMod.sep) : dir;
  return process.platform === 'win32' || pathMod === path.win32 ? r.toLowerCase() : r;
}

/**
 * Is `candidateCwd` the repo root or a path underneath it?
 *
 * Containment is decided with `path.relative` rather than a string prefix
 * test, so a Windows-recorded cwd (`C:\Users\k\proj\sub`, backslashes) is
 * compared correctly against a repo root that may use the other slash style
 * - and both sides go through `canonicalPath` first, so a `realpath`-only
 * difference (macOS `/var` vs `/private/var`, Windows' `RUNNER~1` vs its long
 * name) cannot make a cwd that really is inside the repo look foreign.
 *
 * `pathMod` defaults to the real `node:path` and only exists so a unit test
 * can inject `path.win32` to exercise Windows-shaped paths from any host.
 */
export function isUnderRepo(
  candidateCwd: string | null | undefined,
  repoRoot: string | null | undefined,
  pathMod: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'dirname' | 'sep'> = path,
): boolean {
  if (!candidateCwd || !repoRoot) return false;
  const a = canonicalPath(candidateCwd, pathMod);
  const b = canonicalPath(repoRoot, pathMod);
  if (a === b) return true;
  const rel = pathMod.relative(b, a);
  return rel !== '' && !rel.startsWith('..') && !pathMod.isAbsolute(rel);
}
