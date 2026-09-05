/**
 * Claude Code transcript discovery: slug directories under
 * ~/.claude/projects, session lookup, and cheap metadata peeking.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitRoot, isDir, isFile, isUnderRepo, META_HEAD_BYTES, mtime, readHead } from '../../core/fsutil';
import { isRecord, str } from '../../core/json';
import type { Located, LocatedSession, LocateOptions } from '../types';

export function claudeProjectsDir(home?: string | null): string {
  return path.join(home || os.homedir(), '.claude', 'projects');
}

export const CLAUDE_PROJECTS_DIR = claudeProjectsDir();

/**
 * Claude's own slugging rule: every character that isn't a letter or digit
 * becomes `-` (verified against real directories on this machine, e.g. cwd
 * `/Users/krishna/.buzz` -> slug `-Users-krishna--buzz` — note the `.`
 * becomes its own `-`, not just each `/`). A plain `split('/').join('-')`
 * gets POSIX paths with no dot/space/etc in them right but silently drops
 * every other separator, which also breaks on a Windows cwd
 * (`C:\Users\k\proj` has no `/` at all to split on).
 */
export function slug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function* iterSlugDirsForCwd(cwd: string, home?: string | null): Generator<string> {
  const base = claudeProjectsDir(home);
  let cur = path.resolve(cwd);
  while (true) {
    yield path.join(base, slug(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
}

export interface FindClaudeSessionOptions {
  cwd?: string | null;
  session?: string | null;
  home?: string | null;
}

/** Resolve a Claude session argument (path / uuid / uuid-prefix) or find the
 * most recently modified session for cwd. Returns a file path or null. */
export function findClaudeSession({
  cwd = null,
  session = null,
  home = null,
}: FindClaudeSessionOptions = {}): string | null {
  const base = claudeProjectsDir(home);
  if (session) {
    if (isFile(session)) return session;
    // DESIGN.md step 2: "search the slug dir for cwd first, then all slug
    // dirs". The cwd dirs are a handful of stats; the full scan is hundreds.
    if (cwd) {
      const local: string[] = [];
      for (const slugDir of iterSlugDirsForCwd(cwd, home)) {
        if (!isDir(slugDir)) continue;
        let entries: string[];
        try {
          entries = fs.readdirSync(slugDir);
        } catch {
          continue;
        }
        for (const fn of entries) {
          if (fn.endsWith('.jsonl') && fn.startsWith(session)) local.push(path.join(slugDir, fn));
        }
      }
      if (local.length) {
        local.sort((a, b) => mtime(b) - mtime(a));
        return local[0] ?? null;
      }
    }
    if (isDir(base)) {
      const candidates: string[] = [];
      for (const d of fs.readdirSync(base)) {
        const dpath = path.join(base, d);
        if (!isDir(dpath)) continue;
        let entries: string[];
        try {
          entries = fs.readdirSync(dpath);
        } catch {
          continue;
        }
        for (const fn of entries) {
          if (fn.endsWith('.jsonl') && fn.startsWith(session)) {
            candidates.push(path.join(dpath, fn));
          }
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => mtime(b) - mtime(a));
        return candidates[0] ?? null;
      }
    }
    return null;
  }

  // No env var is consulted here: session identification is the core
  // resolver's job, and it passes the id in explicitly as `session`.
  const startCwd = cwd || process.cwd();

  for (const slugDir of iterSlugDirsForCwd(startCwd, home)) {
    if (!isDir(slugDir)) continue;
    const files = fs
      .readdirSync(slugDir)
      .filter((fn) => fn.endsWith('.jsonl'))
      .map((fn) => path.join(slugDir, fn));
    if (!files.length) continue;
    files.sort((a, b) => mtime(b) - mtime(a));
    return files[0] ?? null;
  }
  return null;
}

/** Return list of session file paths for the project (all slug dirs walked
 * up from cwd), newest first. */
export function listClaudeSessions({
  cwd = null,
  home = null,
}: {
  cwd?: string | null;
  home?: string | null;
} = {}): string[] {
  const startCwd = cwd || process.cwd();
  for (const slugDir of iterSlugDirsForCwd(startCwd, home)) {
    if (!isDir(slugDir)) continue;
    const files = fs
      .readdirSync(slugDir)
      .filter((fn) => fn.endsWith('.jsonl'))
      .map((fn) => path.join(slugDir, fn));
    if (files.length) {
      files.sort((a, b) => mtime(b) - mtime(a));
      return files;
    }
  }
  return [];
}

export interface ClaudeMeta {
  sessionId: string;
  cwd: string | null;
}

/** Cheaply read the first `cwd`/`sessionId` fields seen in a Claude
 * transcript (mirrors the early-break loop in parseClaudeSession) without
 * doing a full structured parse. */
export function peekClaudeMeta(filePath: string): ClaudeMeta | null {
  const raw = readHead(filePath);
  if (raw === null) return null;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  const lines = raw.split('\n');
  // The last line of a truncated read is very likely incomplete JSON; drop it
  // unless the read covered the whole file.
  if (raw.length >= META_HEAD_BYTES && lines.length > 1) lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let d: unknown;
    try {
      d = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(d)) continue;
    const sid = str(d.sessionId);
    if (sid) sessionId = sid;
    const c = str(d.cwd);
    if (c) cwd = c;
    if (sessionId && cwd) break;
  }
  if (!sessionId) {
    const base = path.basename(filePath);
    sessionId = base.endsWith('.jsonl') ? base.slice(0, -6) : base;
  }
  return { sessionId, cwd };
}

/** DESIGN.md resolveSession step 4 for Claude: walk cwd's ancestor
 * directories up to gitRoot, using each one's slug dir directly (not a full
 * scan-and-peek), and return the single newest transcript found. */
export function newestForCwd({
  cwd,
  gitRoot,
  home = null,
}: {
  cwd: string;
  gitRoot: string;
  home?: string | null;
}): LocatedSession | null {
  let cur = cwd;
  const dirs: string[] = [];
  while (true) {
    dirs.push(cur);
    if (cur === gitRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const base = claudeProjectsDir(home);
  let best: LocatedSession | null = null;
  for (const dirCwd of dirs) {
    const slugDir = path.join(base, slug(dirCwd));
    if (!isDir(slugDir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(slugDir).filter((fn) => fn.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const fn of entries) {
      const fpath = path.join(slugDir, fn);
      const m = mtime(fpath);
      if (!best || m > best.mtime) {
        best = { agent: 'claude', path: fpath, sessionId: fn.slice(0, -6), mtime: m };
      }
    }
  }
  return best;
}

/** Adapter-contract `locate()`: every Claude transcript whose recorded cwd is
 * within the repo containing `cwd` and whose mtime >= `since`. Used by the
 * hooks to disambiguate multiple candidate sessions. */
export function locate({ cwd = process.cwd(), home = null, since = 0 }: LocateOptions): Located[] {
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = findGitRoot(resolvedCwd);
  const results: Located[] = [];
  const base = claudeProjectsDir(home);
  if (!isDir(base)) return results;
  for (const d of fs.readdirSync(base)) {
    const dpath = path.join(base, d);
    if (!isDir(dpath)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dpath);
    } catch {
      continue;
    }
    for (const fn of entries) {
      if (!fn.endsWith('.jsonl')) continue;
      const fpath = path.join(dpath, fn);
      const m = mtime(fpath);
      if (m < since) continue;
      const meta = peekClaudeMeta(fpath);
      if (!meta || !isUnderRepo(meta.cwd, gitRoot)) continue;
      results.push({ path: fpath, sessionId: meta.sessionId, mtime: m });
    }
  }
  return results;
}

/** Adapter-contract `findSession(idOrPath, {cwd, home})`. */
export function findSession(
  idOrPath: string,
  { cwd, home }: { cwd?: string; home?: string | null } = {},
): string | null {
  return findClaudeSession({ cwd, session: idOrPath, home });
}
