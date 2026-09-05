/**
 * Agent-neutral session resolution: implements DESIGN.md "Host and session
 * identification" by asking each registered adapter, in turn, rather than
 * hardcoding Claude/Codex here. This module never requires an agent by name.
 */

import path from 'node:path';
import { agents } from '../agents/index';
import type { Adapter } from '../agents/types';
import { findGitRoot, isFile } from './fsutil';

function orderedAgents(agent: string): readonly Adapter[] {
  const all = agents(); // already sorted by id: claude, codex, ...
  if (!agent || agent === 'auto') return all;
  return all.filter((a) => a.id === agent);
}

export interface ResolvedSession {
  agent: string | null;
  path: string | null;
  sessionId: string | null;
  how: string | null;
}

export interface ResolveSessionOptions {
  agent?: string;
  session?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string | null;
}

/**
 * Implements DESIGN.md "Host and session identification", steps 1-4.
 * `env` and `home` are injectable for testing.
 */
export function resolveSession({
  agent = 'auto',
  session = null,
  cwd = process.cwd(),
  env = process.env,
  home = null,
}: ResolveSessionOptions = {}): ResolvedSession {
  const resolvedCwd = path.resolve(cwd);
  const agentsToTry = orderedAgents(agent);

  // 1. explicit --session
  if (session) {
    // A direct file path is routed to the adapter that owns its filename
    // shape (falling back to the first candidate when nothing recognizes
    // it), matching every other adapter's isFile() short-circuit exactly.
    if (isFile(session)) {
      const base = path.basename(session);
      const chosen =
        agentsToTry.length === 1
          ? agentsToTry[0]
          : (agentsToTry.find((a) => a.looksLikeOwnFile(base)) ?? agentsToTry[0]);
      if (!chosen) return { agent: null, path: null, sessionId: null, how: null };
      return { agent: chosen.id, path: session, sessionId: chosen.sessionIdFor(session), how: 'explicit' };
    }
    for (const a of agentsToTry) {
      const p = a.findSession(session, { cwd: resolvedCwd, home });
      if (p) return { agent: a.id, path: p, sessionId: a.sessionIdFor(p), how: 'explicit' };
    }
    return { agent: null, path: null, sessionId: null, how: null };
  }

  // 2/3. per-agent session env vars, in adapter order (claude before codex,
  // matching CLAUDE_CODE_SESSION_ID before CODEX_THREAD_ID/CODEX_SESSION_ID).
  // Within one adapter, the first env var listed that is actually set wins
  // (matching the old `threadId || fallbackId` single-attempt semantics) -
  // a second env var for the same adapter is never consulted once the first
  // one is set, even if the lookup for it fails.
  for (const a of agentsToTry) {
    let envVar: string | null = null;
    let id: string | null = null;
    for (const v of a.sessionEnvVars) {
      if (env[v]) {
        envVar = v;
        id = env[v] as string;
        break;
      }
    }
    if (!id) continue;
    let p = a.findSession(id, { cwd: resolvedCwd, home });
    if (!p) p = a.findSession(id, { home });
    if (p) return { agent: a.id, path: p, sessionId: a.sessionIdFor(p), how: `env:${envVar}` };
  }

  // 4. newest transcript whose recorded cwd is the repo root or a
  // subdirectory of it.
  const gitRoot = findGitRoot(resolvedCwd);
  let best: { agent: string; path: string; sessionId: string; mtime: number } | null = null;
  for (const a of agentsToTry) {
    const candidate = a.newestForCwd({ cwd: resolvedCwd, gitRoot, home });
    if (candidate && (!best || candidate.mtime > best.mtime)) {
      best = {
        agent: candidate.agent,
        path: candidate.path,
        sessionId: candidate.sessionId,
        mtime: candidate.mtime,
      };
    }
  }
  if (best) return { agent: best.agent, path: best.path, sessionId: best.sessionId, how: 'newest-for-cwd' };

  return { agent: null, path: null, sessionId: null, how: null };
}

export interface CandidateSessionLocation {
  agent: string;
  path: string;
  sessionId: string;
  mtime: number;
}

/**
 * All transcripts (every registered agent, unless narrowed) whose recorded
 * cwd is within the repo containing `cwd` and whose mtime >= `since`. Used by
 * the hooks to disambiguate multiple candidate sessions.
 */
export function listCandidateSessions({
  cwd = process.cwd(),
  since = 0,
  home = null,
}: {
  cwd?: string;
  since?: number;
  home?: string | null;
} = {}): CandidateSessionLocation[] {
  const resolvedCwd = path.resolve(cwd);
  const results: CandidateSessionLocation[] = [];
  for (const a of agents()) {
    for (const c of a.locate({ cwd: resolvedCwd, home, since })) {
      results.push({ agent: a.id, path: c.path, sessionId: c.sessionId, mtime: c.mtime });
    }
  }
  return results;
}
