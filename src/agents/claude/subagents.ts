/**
 * Claude Code subagent transcripts (DESIGN.md "Subagent usage").
 *
 * A subagent's transcript sits in a directory named after the session file it
 * belongs to:
 *
 *   ~/.claude/projects/<slug>/<sessionId>.jsonl          <- the main chain
 *   ~/.claude/projects/<slug>/<sessionId>/subagents/     <- one file per agent
 *       agent-<agentId>.jsonl
 *       agent-<agentId>.meta.json                        <- {toolUseId, spawnDepth, ...}
 *
 * That directory is the ONLY place this module reads. Claude Code also leaves
 * copies of some of these transcripts under a per-task scratch directory
 * (`/private/tmp/.../tasks/...`); reading those would count the same agent
 * twice, so nothing here ever looks outside `<session dir>/subagents`.
 *
 * Records in a subagent file have the same shape as the main chain's, carry
 * `isSidechain: true` and an `agentId`, and their usage is NOT part of the
 * main chain's numbers: a subagent is a separate sequence of API requests, so
 * its tokens are additional, never a subset. That is what makes adding them
 * correct rather than double counting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isRecord, str } from '../../core/json';
import type { Linkage, Session } from '../../core/model';
import type { Child, ChildrenResult } from '../types';
import { transcriptUsage } from './parser';

/** `<dir>/<sessionId>/subagents` for a main transcript path. */
export function subagentDir(sessionPath: string): string {
  const dir = path.dirname(sessionPath);
  const base = path.basename(sessionPath);
  const stem = base.endsWith('.jsonl') ? base.slice(0, -6) : base;
  return path.join(dir, stem, 'subagents');
}

/** The `.jsonl` regular files directly inside `dir`, sorted. A symlink, or
 * an entry whose real path is not inside `dir`'s real path, is skipped: the
 * subagents directory is the ONLY place read (see the module comment), and a
 * link planted there could otherwise pull in any transcript on the machine.
 * Fails closed - any stat/realpath error skips the entry. */
function listFiles(dir: string): string[] {
  let entries: string[];
  let realDir: string;
  try {
    entries = fs.readdirSync(dir);
    realDir = fs.realpathSync(dir);
  } catch {
    return [];
  }
  const inside = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
  const out: string[] = [];
  for (const f of entries.filter((n) => n.endsWith('.jsonl')).sort()) {
    const full = path.join(dir, f);
    try {
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const real = fs.realpathSync(full);
      if (!real.startsWith(inside)) continue;
    } catch {
      continue;
    }
    out.push(full);
  }
  return out;
}

interface SidecarMeta {
  toolUseId: string | null;
  parentAgentId: string | null;
}

/** `agent-<id>.meta.json` next to the transcript: Claude Code records the
 * `tool_use` id of the call that spawned the agent there, which is the exact
 * link to the turn. Absent or unreadable -> null, and the text-scan fallback
 * in resolve() takes over. */
function readMeta(filePath: string): SidecarMeta | null {
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
  try {
    const j: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!isRecord(j)) return null;
    return { toolUseId: str(j.toolUseId), parentAgentId: str(j.parentAgentId) };
  } catch {
    return null;
  }
}

/** agentId out of `agent-<id>.jsonl`, for a file whose records carry none. */
function agentIdFromName(filePath: string): string | null {
  const m = /^agent-(.+)\.jsonl$/.exec(path.basename(filePath));
  return m?.[1] ?? null;
}

interface Entry {
  path: string;
  agentId: string;
  toolUseId: string | null;
  metaParentAgentId: string | null;
  scan: ReturnType<typeof transcriptUsage>;
}

/**
 * Every subagent transcript of `session`, each appearing EXACTLY ONCE however
 * deeply it is nested, with the top-level turn it should be attributed to.
 *
 * `spawnedByTurnId` is the top-level Turn's `fullId` and is what core links
 * on; `spawnedByTurnGid` is the same turn's short gid, for display only (a
 * gid is built from a 7-char id prefix and two turns can share one).
 *
 * `usage` is deduped against every other file of the session (main chain
 * included): a message id already counted somewhere else is skipped, so no
 * arithmetic here can inflate a total even if a transcript is duplicated.
 */
export function children(session: Session, _opts: { home?: string | null } = {}): ChildrenResult {
  const out: ChildrenResult = { children: [], duplicates: 0 };
  if (!session?.path) return out;

  const files = listFiles(subagentDir(session.path));
  if (!files.length) return out;

  // tool_use id -> the turn that issued it, recorded by parseClaudeSession.
  // A private contract with parser.ts: session.meta is agent-specific and
  // otherwise unmodeled (docs/DESIGN.md "Adapter contract").
  const rawOwners = session.meta.toolUseOwners;
  // instanceof proves it's a Map; the key/value types are the private
  // contract with parser.ts noted above, not runtime-checkable.
  const owners = rawOwners instanceof Map ? (rawOwners as Map<string, string>) : new Map<string, string>();
  const turnByFullId = new Map<string, Session['turns'][number]>();
  for (const t of session.turns) turnByFullId.set(t.fullId, t);

  // Seed the cross-file id set with the main chain's own message ids so a
  // child that somehow repeats one of them adds nothing. `skipSidechain`
  // applies the parser's own inclusion rule: sidechain records in the main
  // file are counted in no turn, so they must not be allowed to pre-empt the
  // same messages in the child's file (see transcriptUsage).
  const seen = new Set<string>();
  const mainScan = transcriptUsage(session.path, { seen, skipSidechain: true });

  const entries: Entry[] = [];
  for (const file of files) {
    const scan = transcriptUsage(file, { seen });
    out.duplicates += scan.duplicates;
    const meta = readMeta(file);
    const agentId =
      agentIdFromName(file) || (scan.agentIds.size ? [...scan.agentIds][0] : null) || path.basename(file);
    entries.push({
      path: file,
      agentId: agentId ?? path.basename(file),
      toolUseId: meta?.toolUseId ?? null,
      metaParentAgentId: meta?.parentAgentId ?? null,
      scan,
    });
  }

  // agentId -> tool_use id, from the `Agent` tool_result text in whichever
  // transcript made the call (the main chain for a depth-1 agent, a child's
  // own file for a nested one) plus the background-agent task notifications.
  const linkByAgentId = new Map<string, string>();
  for (const [aid, tu] of mainScan.agentLinks.entries()) linkByAgentId.set(aid, tu);
  for (const e of entries) {
    for (const [aid, tu] of e.scan.agentLinks.entries()) linkByAgentId.set(aid, tu);
  }
  // tool_use id -> the child whose transcript issued it, so a grandchild
  // resolves to its parent and, through it, to the same top-level turn.
  const issuedBy = new Map<string, Entry>();
  for (const e of entries) {
    for (const tu of e.scan.toolUseIds) issuedBy.set(tu, e);
  }

  const byAgentId = new Map<string, Entry>();
  for (const e of entries) if (e.agentId) byAgentId.set(e.agentId, e);

  /** The top-level turn for one entry, walking up a nested chain. Every
   * step is an id match, so the whole chain stays linkage 'exact'; a cycle or
   * a missing link ends the walk with null rather than a guess. */
  function resolve(entry: Entry): {
    turn: Session['turns'][number] | null;
    linkage: Linkage;
    parentAgentId: string | null;
  } {
    const guard = new Set<string>();
    let cur: Entry | null = entry;
    let parentAgentId: string | null = null;
    while (cur && !guard.has(cur.path)) {
      guard.add(cur.path);
      const tu: string | null = cur.toolUseId || linkByAgentId.get(cur.agentId) || null;
      if (tu) {
        const ownerFullId = owners.get(tu);
        if (ownerFullId && turnByFullId.has(ownerFullId)) {
          return { turn: turnByFullId.get(ownerFullId) ?? null, linkage: 'exact', parentAgentId };
        }
      }
      // Nested agent: climb to the one that spawned it. The meta sidecar names
      // it outright; otherwise the tool_use id is found in its transcript.
      // Either way it is an id match, so the whole chain stays 'exact'.
      const up: Entry | null =
        (cur.metaParentAgentId && byAgentId.get(cur.metaParentAgentId)) ||
        (tu ? issuedBy.get(tu) : null) ||
        null;
      if (!up || up === cur) break;
      if (cur === entry) parentAgentId = up.agentId;
      cur = up;
    }
    return { turn: null, linkage: 'none', parentAgentId };
  }

  for (const e of entries) {
    const r = resolve(e);
    const child: Child = {
      path: e.path,
      agentId: e.agentId,
      parentAgentId: r.parentAgentId,
      spawnedByTurnId: r.turn ? r.turn.fullId : null,
      spawnedByTurnGid: r.turn ? r.turn.gid : null,
      linkage: r.linkage,
      usage: e.scan.usage,
    };
    out.children.push(child);
  }

  return out;
}
