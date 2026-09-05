/**
 * The on-disk shape of a session document (docs/DESIGN.md "Session
 * document"): one JSON file per (agent, session id), keyed by turn gid.
 * Shared by `src/core/merge.ts` (the union merge driver) and the store
 * package, which reads and writes these files.
 */

import { bool, num, rec, str } from './json';
import type { Linkage, SubagentUsage } from './model';

export interface TokenCounts {
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

/** How a matched file's evidence was scored for one commit (DESIGN.md
 * "Evidence tiers"). */
export interface CommitFileEvidence {
  hunks: number;
  matched: number;
  confidence: string;
}

export type CommitRole = 'contributor' | 'committer' | 'both' | 'unknown';

export interface CommitEntry {
  sha: string;
  role: CommitRole;
  files: Record<string, CommitFileEvidence>;
}

export interface TurnOrigin {
  path: string;
  uuid: string;
  promptHash: string;
  responseHash: string | null;
}

export interface RedactionRecord {
  kind: string;
  hash4: string;
}

export interface TurnRecord {
  id: string;
  fullId: string;
  parentId: string | null;
  ts: string;
  durationS: number;
  prompt: string;
  response: string | null;
  responsePending: boolean;
  isCommand: boolean;
  tokens: TokenCounts;
  toolCalls: number;
  toolNames: Record<string, number>;
  files: string[];
  models: string[];
  origin: TurnOrigin;
  redactions: RedactionRecord[];
  commits: CommitEntry[];
  /** Usage of the subagent transcripts this turn spawned, separate from
   * `tokens` (the turn's own usage) - DESIGN.md "Subagent usage". */
  subagents: SubagentUsage;
}

export interface SessionDoc {
  version: number;
  agent: string;
  sessionId: string;
  cwd: string | null;
  machine: string;
  started: string;
  turns: Record<string, TurnRecord>;
}

// ---------------------------------------------------------------- decoding

function strArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function decodeTokenCounts(v: unknown): TokenCounts | null {
  const r = rec(v);
  if (!r) return null;
  const output = num(r.output);
  const input = num(r.input);
  const cacheRead = num(r.cacheRead);
  const cacheWrite = num(r.cacheWrite);
  const thinking = num(r.thinking);
  if (output === null || input === null || cacheRead === null || cacheWrite === null || thinking === null) {
    return null;
  }
  return { output, input, cacheRead, cacheWrite, thinking };
}

function decodeToolNames(v: unknown): Record<string, number> | null {
  const r = rec(v);
  if (!r) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(r)) {
    const n = num(val);
    if (n === null) return null;
    out[k] = n;
  }
  return out;
}

function decodeOrigin(v: unknown): TurnOrigin | null {
  const r = rec(v);
  if (!r) return null;
  const p = str(r.path);
  const uuid = str(r.uuid);
  const promptHash = str(r.promptHash);
  if (p === null || uuid === null || promptHash === null) return null;
  return { path: p, uuid, promptHash, responseHash: str(r.responseHash) };
}

function decodeRedactions(v: unknown): RedactionRecord[] | null {
  if (!Array.isArray(v)) return null;
  const out: RedactionRecord[] = [];
  for (const item of v) {
    const r = rec(item);
    const kind = r && str(r.kind);
    const hash4 = r && str(r.hash4);
    if (!kind || !hash4) return null;
    out.push({ kind, hash4 });
  }
  return out;
}

const COMMIT_ROLES = new Set<string>(['contributor', 'committer', 'both', 'unknown']);

/** Per-file evidence isn't required to decode - it is regenerable cache
 * (`rebuildCommits`), so a malformed entry is dropped rather than failing
 * the whole commit, matching OLD's laissez-faire treatment of this field. */
export function decodeFileEvidence(v: unknown): Record<string, CommitFileEvidence> {
  const r = rec(v);
  if (!r) return {};
  const out: Record<string, CommitFileEvidence> = {};
  for (const [k, val] of Object.entries(r)) {
    const fr = rec(val);
    if (!fr) continue;
    const hunks = num(fr.hunks);
    const matched = num(fr.matched);
    const confidence = str(fr.confidence);
    if (hunks === null || matched === null || confidence === null) continue;
    out[k] = { hunks, matched, confidence };
  }
  return out;
}

function decodeCommits(v: unknown): CommitEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: CommitEntry[] = [];
  for (const item of v) {
    const r = rec(item);
    const sha = r && str(r.sha);
    if (!r || !sha) return null;
    const roleStr = str(r.role);
    const role = (roleStr && COMMIT_ROLES.has(roleStr) ? roleStr : 'unknown') as CommitRole;
    out.push({ sha, role, files: decodeFileEvidence(r.files) });
  }
  return out;
}

const LINKAGES = new Set<string>(['exact', 'time', 'mixed', 'none']);

function decodeSubagents(v: unknown): SubagentUsage | null {
  const r = rec(v);
  if (!r) return null;
  const count = num(r.count);
  const output = num(r.output);
  const input = num(r.input);
  const cacheRead = num(r.cacheRead);
  const cacheWrite = num(r.cacheWrite);
  const thinking = num(r.thinking);
  if (
    count === null ||
    output === null ||
    input === null ||
    cacheRead === null ||
    cacheWrite === null ||
    thinking === null
  ) {
    return null;
  }
  const linkageStr = str(r.linkage);
  const linkage = linkageStr && LINKAGES.has(linkageStr) ? (linkageStr as Linkage) : null;
  return { count, output, input, cacheRead, cacheWrite, thinking, linkage };
}

function decodeTurnRecord(v: unknown): TurnRecord | null {
  const r = rec(v);
  if (!r) return null;
  const id = str(r.id);
  const fullId = str(r.fullId);
  const ts = str(r.ts);
  const durationS = num(r.durationS);
  const prompt = str(r.prompt);
  const toolCalls = num(r.toolCalls);
  if (
    id === null ||
    fullId === null ||
    ts === null ||
    durationS === null ||
    prompt === null ||
    toolCalls === null
  ) {
    return null;
  }
  const tokens = decodeTokenCounts(r.tokens);
  const toolNames = decodeToolNames(r.toolNames);
  const files = strArray(r.files);
  const models = strArray(r.models);
  const origin = decodeOrigin(r.origin);
  const redactions = decodeRedactions(r.redactions);
  const commits = decodeCommits(r.commits);
  const subagents = decodeSubagents(r.subagents);
  if (!tokens || !toolNames || !files || !models || !origin || !redactions || !commits || !subagents) {
    return null;
  }
  return {
    id,
    fullId,
    parentId: str(r.parentId),
    ts,
    durationS,
    prompt,
    response: str(r.response),
    responsePending: bool(r.responsePending),
    isCommand: bool(r.isCommand),
    tokens,
    toolCalls,
    toolNames,
    files,
    models,
    origin,
    redactions,
    commits,
    subagents,
  };
}

/**
 * Validate `raw` as a session document: the top-level shape and every
 * turn's required fields. Returns null on any deviation - a doc that fails
 * to decode is treated exactly as OLD treated a document it could not even
 * JSON.parse.
 */
export function readSessionDoc(raw: unknown): SessionDoc | null {
  const r = rec(raw);
  if (!r) return null;
  const version = num(r.version);
  const agent = str(r.agent);
  const sessionId = str(r.sessionId);
  const machine = str(r.machine);
  const started = str(r.started);
  const turnsRaw = rec(r.turns);
  if (
    version === null ||
    agent === null ||
    sessionId === null ||
    machine === null ||
    started === null ||
    !turnsRaw
  ) {
    return null;
  }
  const turns: Record<string, TurnRecord> = {};
  for (const [gid, tv] of Object.entries(turnsRaw)) {
    const t = decodeTurnRecord(tv);
    if (!t) return null;
    turns[gid] = t;
  }
  return { version, agent, sessionId, cwd: str(r.cwd), machine, started, turns };
}
