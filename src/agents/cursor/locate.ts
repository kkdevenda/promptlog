/**
 * Cursor transcript discovery: slug directories under
 * ~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl, session
 * lookup, and cheap metadata peeking.
 *
 * Cursor transcripts (unlike Claude's) carry no `cwd` field in the JSONL
 * itself, so there is nothing to peek-and-filter against like
 * claude/locate.ts's peekClaudeMeta does. Instead cwd-matching works the
 * same way Claude's directory layout does: the slug *is* the sanitised cwd,
 * so we build candidate slug dirs from cwd's ancestor chain.
 *
 * Slugging is lossy (a real dash in a directory name is indistinguishable
 * from a path separator once joined), so a transcript's cwd is never
 * *reconstructed* from its slug. Instead: whenever a transcript is found by
 * building its slug dir from a known real cwd (every function below except
 * the last-resort full scan in findCursorSession), that real cwd is cached
 * by transcript path in `knownCwdByPath` for parser.ts to read back
 * verbatim. When no such cache entry exists (e.g. parse() called directly
 * on a path nobody's `locate`d), `resolveCwdForSlug` falls back to reading
 * Cursor's own `workspaceStorage/<hash>/workspace.json` records, each of
 * which names one real folder Cursor opened; whichever one slugs back to
 * the same name is the answer, no reversal needed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitRoot, isDir, isFile, mtime } from '../../core/fsutil';
import { get } from '../../core/json';
import type { Located, LocatedSession, LocateOptions } from '../types';

function cursorHome(home?: string | null): string {
  return path.join(home || os.homedir(), '.cursor');
}

export function cursorProjectsDir(home?: string | null): string {
  return path.join(cursorHome(home), 'projects');
}

/**
 * Sanitise a cwd into a Cursor project slug: strip the leading path
 * separator(s) then replace every remaining non-alphanumeric character with
 * "-". Verified against real directories on this machine, e.g. cwd
 * "/Users/krishna/Developer/whatsareyouworkingon" -> slug
 * "Users-krishna-Developer-whatsareyouworkingon" (no leading dash, unlike
 * Claude's slug rule which keeps one). Stripping only "/" (not "\") for the
 * leading separator matches every cwd seen on this machine so far; a Windows
 * cwd has no leading separator to strip (it starts `C:\...`), so the same
 * regex is a no-op there and every character - including the drive letter's
 * ":" and the "\" separators - becomes "-" like Claude's rule. Unverified
 * against a real Windows Cursor install.
 */
export function slug(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/[^A-Za-z0-9]/g, '-');
}

// transcript absolute path -> the real cwd whose slug matched it. Populated
// only where a real cwd was actually known at lookup time (see file
// header); read back by parser.ts via cachedCwdFor(). Session-lifetime,
// process-local cache: never persisted, never a source of truth by itself.
const knownCwdByPath = new Map<string, string>();

/** List every `<uuid>/<uuid>.jsonl` transcript directly under a slug dir's
 * agent-transcripts/, ignoring subagents/. When `knownCwd` is given (the
 * real cwd this slugDir was built from), also remembers it against each
 * transcript path for parser.ts to read back. */
export function transcriptsInSlugDir(slugDir: string, knownCwd: string | null = null): Located[] {
  const out: Located[] = [];
  const transcriptsDir = path.join(slugDir, 'agent-transcripts');
  if (!isDir(transcriptsDir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'subagents') continue;
    const uuid = ent.name;
    const fpath = path.join(transcriptsDir, uuid, `${uuid}.jsonl`);
    if (!isFile(fpath)) continue;
    if (knownCwd) knownCwdByPath.set(fpath, knownCwd);
    out.push({ path: fpath, sessionId: uuid, mtime: mtime(fpath) });
  }
  return out;
}

/** Read back the real cwd cached for `transcriptPath` by a prior locate()/
 * newestForCwd()/findSession() call that matched it via a known cwd's slug,
 * or null if nothing is cached (parser.ts then falls back to the
 * workspaceStorage lookup below). */
export function cachedCwdFor(transcriptPath: string): string | null {
  return knownCwdByPath.get(path.resolve(transcriptPath)) ?? null;
}

/** Recover HOME from a transcript's own path (…/<home>/.cursor/projects/
 * <slug>/agent-transcripts/<uuid>/<uuid>.jsonl -> <home>), so a fallback
 * cwd lookup (workspaceStorage) checks the same HOME this transcript
 * actually lives under — the real machine HOME in production, but also a
 * fake test HOME, since nothing else tells parser.ts which one to use
 * (parse() takes only a path). Returns null if the path isn't shaped like
 * a Cursor transcript at all. */
export function homeFromTranscriptPath(filePath: string): string | null {
  let cur = path.resolve(filePath);
  for (let i = 0; i < 5; i++) cur = path.dirname(cur);
  if (path.basename(cur) !== '.cursor') return null;
  return path.dirname(cur);
}

export function workspaceStorageDir(home?: string | null): string {
  return path.join(
    home || os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'workspaceStorage',
  );
}

/** Decode a workspace.json `folder` field (`file:///Users/...`) into a
 * plain filesystem path, or null if it isn't a local file:// URI. */
function folderUriToPath(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
}

/**
 * Last-resort cwd recovery for a transcript nobody `locate()`d: scan every
 * `workspaceStorage/<hash>/workspace.json` Cursor has written (each names
 * one real folder it opened) and return the first whose slug equals
 * `slugName`. Unlike reversing the slug's dashes back into slashes, this
 * reads the real path Cursor itself recorded, so a hyphenated directory
 * name round-trips correctly. Returns null if nothing matches (or the dir
 * doesn't exist, e.g. non-macOS / Cursor never opened this project).
 */
export function resolveCwdForSlug(slugName: string, home: string | null = null): string | null {
  const base = workspaceStorageDir(home);
  if (!isDir(base)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const wsPath = path.join(base, ent.name, 'workspace.json');
    if (!isFile(wsPath)) continue;
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(wsPath, 'utf-8'));
    } catch {
      continue;
    }
    const folder = folderUriToPath(get(data, 'folder'));
    if (!folder) continue;
    if (slug(folder) === slugName) return folder;
  }
  return null;
}

/** Adapter-contract `locate()`: every Cursor transcript found under the
 * slug dirs for cwd's ancestor chain up to (and including) the git root,
 * with mtime >= since. Mirrors claude/locate.ts's "repo root and parents"
 * matching, but bounded at gitRoot since there is no per-record cwd to
 * validate a transcript against once found. */
export function locate(opts: LocateOptions): Located[] {
  const home = opts.home ?? null;
  const since = opts.since ?? 0;
  let cur = path.resolve(opts.cwd);
  const gitRoot = findGitRoot(cur);
  const results: Located[] = [];
  while (true) {
    const slugDir = path.join(cursorProjectsDir(home), slug(cur));
    if (isDir(slugDir)) {
      for (const t of transcriptsInSlugDir(slugDir, cur)) {
        if (t.mtime >= since) results.push(t);
      }
    }
    if (cur === gitRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return results;
}

/** DESIGN.md resolveSession step 4 for Cursor: walk cwd's ancestor
 * directories up to gitRoot, return the single newest transcript found. */
export function newestForCwd(opts: {
  cwd: string;
  gitRoot: string;
  home?: string | null;
}): LocatedSession | null {
  const home = opts.home ?? null;
  const dirs: string[] = [];
  let cur = opts.cwd;
  while (true) {
    dirs.push(cur);
    if (cur === opts.gitRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let best: LocatedSession | null = null;
  for (const dirCwd of dirs) {
    const slugDir = path.join(cursorProjectsDir(home), slug(dirCwd));
    for (const t of transcriptsInSlugDir(slugDir, dirCwd)) {
      if (!best || t.mtime > best.mtime) {
        best = { agent: 'cursor', path: t.path, sessionId: t.sessionId, mtime: t.mtime };
      }
    }
  }
  return best;
}

/** Resolve a Cursor session argument (path / uuid / uuid-prefix) or find the
 * most recently modified session for cwd. Returns a file path or null. */
export function findCursorSession(opts: {
  cwd?: string | null;
  session?: string | null;
  home?: string | null;
}): string | null {
  const home = opts.home ?? null;
  const base = cursorProjectsDir(home);
  const session = opts.session ?? null;
  if (session) {
    if (isFile(session)) return session;
    // Local first: slug dirs for cwd's ancestor chain (cheap), like Claude.
    if (opts.cwd) {
      const local: Located[] = [];
      let cur = path.resolve(opts.cwd);
      while (true) {
        const slugDir = path.join(base, slug(cur));
        for (const t of transcriptsInSlugDir(slugDir, cur)) {
          if (t.sessionId.startsWith(session)) local.push(t);
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (local.length) {
        local.sort((a, b) => b.mtime - a.mtime);
        return local[0]?.path ?? null;
      }
    }
    // Fall back to a full scan across every project dir. Not derived from a
    // known real cwd (just directory names), so nothing is cached here.
    if (isDir(base)) {
      const candidates: Located[] = [];
      for (const d of fs.readdirSync(base)) {
        const dpath = path.join(base, d);
        if (!isDir(dpath)) continue;
        for (const t of transcriptsInSlugDir(dpath)) {
          if (t.sessionId.startsWith(session)) candidates.push(t);
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates[0]?.path ?? null;
      }
    }
    return null;
  }

  // No env var: session identification is the core resolver's job.
  let cur = path.resolve(opts.cwd || process.cwd());
  while (true) {
    const slugDir = path.join(cursorProjectsDir(home), slug(cur));
    const found = transcriptsInSlugDir(slugDir, cur);
    if (found.length) {
      found.sort((a, b) => b.mtime - a.mtime);
      return found[0]?.path ?? null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Adapter-contract `findSession(idOrPath, {cwd, home})`. */
export function findSession(
  idOrPath: string | null,
  opts: { cwd?: string | null; home?: string | null } = {},
): string | null {
  return findCursorSession({ cwd: opts.cwd, session: idOrPath, home: opts.home });
}
