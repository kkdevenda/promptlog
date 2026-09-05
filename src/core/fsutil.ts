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
 * Is `candidateCwd` the repo root or a path underneath it?
 *
 * Containment is decided with `path.relative` rather than a string prefix
 * test, so a Windows-recorded cwd (`C:\Users\k\proj\sub`, backslashes) is
 * compared correctly against a repo root that may use the other slash style
 * (`path.resolve` normalises both before the comparison). On win32 (or when
 * `pathMod` is `path.win32`, so this is testable off a real Windows host) the
 * comparison folds case, since NTFS/ReFS paths are case-insensitive.
 *
 * `pathMod` defaults to the real `node:path` and only exists so a unit test
 * can inject `path.win32` to exercise Windows-shaped paths from any host.
 */
export function isUnderRepo(
  candidateCwd: string | null | undefined,
  repoRoot: string | null | undefined,
  pathMod: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'> = path,
): boolean {
  if (!candidateCwd || !repoRoot) return false;
  let a = pathMod.resolve(candidateCwd);
  let b = pathMod.resolve(repoRoot);
  if (process.platform === 'win32' || pathMod === path.win32) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a === b) return true;
  const rel = pathMod.relative(b, a);
  return rel !== '' && !rel.startsWith('..') && !pathMod.isAbsolute(rel);
}
