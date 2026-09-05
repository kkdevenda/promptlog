/**
 * Codex CLI transcript discovery: rollout file scanning under
 * ~/.codex/sessions, session lookup, and cheap metadata peeking.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGitRoot, isDir, isFile, isUnderRepo, mtime, readHead } from '../../core/fsutil';
import { isRecord, str, tryParse } from '../../core/json';
import type { JsonRecord } from '../../core/model';
import type { Located, LocatedSession, LocateOptions } from '../types';

export function codexSessionsDir(home?: string | null): string {
  return path.join(home || os.homedir(), '.codex', 'sessions');
}

export const CODEX_SESSIONS_DIR = codexSessionsDir();

export function allRolloutFiles(home?: string | null): string[] {
  const base = codexSessionsDir(home);
  if (!isDir(base)) return [];
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  }
  walk(base);
  return files;
}

/** The `session_meta` payload of a rollout file, read from its first line
 * only. `{}` when the record parses but carries no payload; `null` when the
 * file is unreadable, empty, or its first record isn't `session_meta`. */
export function readCodexSessionMeta(filePath: string): JsonRecord | null {
  const raw = readHead(filePath);
  if (raw === null) return null;
  const idx = raw.indexOf('\n');
  const first = idx !== -1 ? raw.slice(0, idx) : raw;
  const d = tryParse(first);
  if (!isRecord(d) || d.type !== 'session_meta') return null;
  const payload = d.payload;
  return isRecord(payload) ? payload : {};
}

export function findCodexSession({
  cwd = null,
  session = null,
  home = null,
}: {
  cwd?: string | null;
  session?: string | null;
  home?: string | null;
} = {}): string | null {
  if (session) {
    if (isFile(session)) return session;
    const candidates = allRolloutFiles(home).filter((f) => path.basename(f).includes(session));
    if (candidates.length) {
      candidates.sort((a, b) => mtime(b) - mtime(a));
      return candidates[0] ?? null;
    }
    return null;
  }

  const targetCwd = cwd || process.cwd();
  let best: string | null = null;
  let bestMtime = -1.0;
  for (const f of allRolloutFiles(home)) {
    const meta = readCodexSessionMeta(f);
    if (!meta) continue;
    if (str(meta.cwd) === targetCwd) {
      const m = mtime(f);
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    }
  }
  return best;
}

export function listCodexSessions({
  cwd = null,
  home = null,
}: {
  cwd?: string | null;
  home?: string | null;
} = {}): string[] {
  const targetCwd = cwd || process.cwd();
  const matches: string[] = [];
  for (const f of allRolloutFiles(home)) {
    const meta = readCodexSessionMeta(f);
    if (!meta) continue;
    if (str(meta.cwd) === targetCwd) matches.push(f);
  }
  matches.sort((a, b) => mtime(b) - mtime(a));
  return matches;
}

/** DESIGN.md resolveSession step 4 for Codex: scan every rollout file and
 * return the single newest one whose recorded cwd is under gitRoot. */
export function newestForCwd({
  gitRoot,
  home = null,
}: {
  cwd: string;
  gitRoot: string;
  home?: string | null;
}): LocatedSession | null {
  let best: LocatedSession | null = null;
  for (const f of allRolloutFiles(home)) {
    const meta = readCodexSessionMeta(f);
    if (!meta || !isUnderRepo(str(meta.cwd), gitRoot)) continue;
    const m = mtime(f);
    if (!best || m > best.mtime) {
      best = { agent: 'codex', path: f, sessionId: str(meta.id) || path.basename(f), mtime: m };
    }
  }
  return best;
}

/** Adapter-contract `locate()`: every Codex transcript whose recorded cwd is
 * within the repo containing `cwd` and whose mtime >= `since`. */
export function locate({ cwd = process.cwd(), home = null, since = 0 }: LocateOptions): Located[] {
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = findGitRoot(resolvedCwd);
  const results: Located[] = [];
  for (const f of allRolloutFiles(home)) {
    const m = mtime(f);
    if (m < since) continue;
    const meta = readCodexSessionMeta(f);
    if (!meta || !isUnderRepo(str(meta.cwd), gitRoot)) continue;
    results.push({ path: f, sessionId: str(meta.id) || path.basename(f), mtime: m });
  }
  return results;
}

/** Adapter-contract `findSession(idOrPath, {cwd, home})`. */
export function findSession(
  idOrPath: string,
  { cwd = null, home = null }: { cwd?: string | null; home?: string | null } = {},
): string | null {
  return findCodexSession({ cwd, session: idOrPath, home });
}
