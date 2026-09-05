/**
 * Session documents: building, merging and reading the per-session
 * `.promptlog/sessions/<agent>-<sid8>.json` records that are the store's
 * source of truth (see `store.ts`'s header comment for the store layout).
 */

import fs from 'node:fs';
import path from 'node:path';

import * as gitmod from './git';
import { errorMessage } from './json';
import { mergeRoles } from './merge';
import type { Turn } from './model';
import type {
  CommitEntry,
  CommitFileEvidence,
  CommitRole,
  RedactionRecord,
  SessionDoc,
  TurnRecord,
} from './records';
import { decodeFileEvidence, readSessionDoc as decodeSessionDoc } from './records';
import type { RedactConfig, RedactResult } from './redact';
import { mergeConfig, redact } from './redact';
import {
  homeCollapse,
  machineId,
  makeGid,
  readConfig,
  readJson,
  type StoreConfig,
  sessionDocPath,
  sessionsDir,
  sha256,
  turnGid,
  withLock,
  writeAtomic,
} from './store';
import { isoFormatUtc } from './util';

/**
 * Raised when the redactor cannot be used. Redaction is the whole safety
 * property of the repo store, so it must fail CLOSED: no record, no trailer,
 * one warning. A redact()/mergeConfig() that throws or returns something
 * malformed must never fall through to storing plaintext.
 */
export class RedactionUnavailable extends Error {
  redactionUnavailable = true as const;

  constructor(message: string) {
    super(`redaction unavailable: ${message}`);
    this.name = 'RedactionUnavailable';
  }
}

export function readSessionDoc(root: string, agent: string, sessionId: string): SessionDoc | null {
  return decodeSessionDoc(readJson(sessionDocPath(root, agent, sessionId)));
}

export interface SessionDocEntry {
  file: string;
  doc: SessionDoc;
}

export function listSessionDocs(root: string): SessionDocEntry[] {
  const dir = sessionsDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  names.sort();
  const out: SessionDocEntry[] = [];
  for (const n of names) {
    const doc = decodeSessionDoc(readJson(path.join(dir, n)));
    if (doc) out.push({ file: path.join(dir, n), doc });
  }
  return out;
}

/** Parent's global id. Short ids are not derivable from fullIds for Codex, so
 * prefer the fullId -> gid map of the session being written. */
function parentGid(
  turn: Turn,
  opts: { agent: string; sessionId: string; gidByFullId: Map<string, string> | null },
): string | null {
  const pid = turn.parentId;
  if (!pid) return null;
  const viaBatch = opts.gidByFullId?.get(pid);
  if (viaBatch) return viaBatch;
  if (opts.agent === 'claude') return makeGid(opts.agent, opts.sessionId, pid.slice(0, 7));
  return null;
}

// --------------------------------------------------------- commit entries

export type CommitInput = string | { sha?: unknown; role?: unknown; files?: unknown };

const COMMIT_ROLES: readonly CommitRole[] = ['contributor', 'committer', 'both', 'unknown'];

/**
 * A record's `commits` are entries, not shas (DESIGN.md "Session document"):
 *
 *   { "sha": "…", "role": "contributor" | "committer" | "both" | "unknown",
 *     "files": { "src/core/cli.ts": { hunks: 3, matched: 3, confidence: "edit" } } }
 *
 * `role` says whether the turn contributed the change, issued the commit, or
 * both; `files` is the per-file evidence the attributor found. The whole list
 * is cache: `rebuildCommits` can regenerate the shas from the commit trailers
 * at any time, and does.
 */
export function normalizeCommitEntry(entry: CommitInput | null | undefined): CommitEntry | null {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    return entry ? { sha: entry, role: 'unknown', files: {} } : null;
  }
  const sha = String(entry.sha ?? '').trim();
  if (!sha) return null;
  const roleStr = typeof entry.role === 'string' ? entry.role : '';
  // roleStr is checked against COMMIT_ROLES immediately above.
  const role = (COMMIT_ROLES as readonly string[]).includes(roleStr) ? (roleStr as CommitRole) : 'unknown';
  // Per-file evidence isn't deeply validated, matching OLD behaviour: it is
  // our own cache, regenerable from trailers by `rebuildCommits`.
  const files = decodeFileEvidence(entry.files);
  return { sha, role, files };
}

function sortCommits(entries: CommitEntry[]): CommitEntry[] {
  return [...entries].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
}

/** Normalize + dedupe by sha, later entries winning on conflict. */
export function normalizeCommits(list: Array<CommitInput | null | undefined> | undefined): CommitEntry[] {
  const bySha = new Map<string, CommitEntry>();
  for (const raw of list ?? []) {
    const e = normalizeCommitEntry(raw);
    if (!e) continue;
    const prev = bySha.get(e.sha);
    bySha.set(e.sha, prev ? mergeCommitEntry(prev, e) : e);
  }
  return sortCommits([...bySha.values()]);
}

function mergeCommitEntry(prev: CommitEntry, next: CommitEntry): CommitEntry {
  return {
    sha: next.sha,
    // merge.ts's rule: a turn that both contributed and committed is 'both'.
    role: mergeRoles(prev.role, next.role),
    // Fresh evidence for a file replaces the old; files only in the stored
    // entry are kept, so re-running `sync` never loses per-file detail.
    files: { ...prev.files, ...next.files },
  };
}

/** Just the shas, for trailers, the index and the renderers. */
export function commitShas(record: { commits: CommitInput[] } | null | undefined): string[] {
  return normalizeCommits(record?.commits ?? []).map((e) => e.sha);
}

/**
 * Build the stored record for a Turn. `prompt`/`response` are redacted;
 * `origin.promptHash`/`responseHash` hash the ORIGINAL text.
 */
export interface BuildRecordOptions {
  agent: string;
  sessionId: string;
  originPath?: string | null;
  config: StoreConfig;
  commits?: CommitInput[];
  root?: string | null;
  gidByFullId?: Map<string, string> | null;
  active?: boolean;
}

export function buildRecord(turn: Turn, opts: BuildRecordOptions): TurnRecord {
  const {
    agent,
    sessionId,
    originPath = null,
    config,
    commits = [],
    root = null,
    gidByFullId = null,
    active = false,
  } = opts;

  let rcfg: RedactConfig;
  try {
    rcfg = mergeConfig(config.redact);
  } catch (e) {
    throw new RedactionUnavailable(`mergeConfig() failed (${errorMessage(e)})`);
  }

  const redactRequired = (text: string): { text: string; findings: RedactResult['findings'] } => {
    let r: RedactResult;
    try {
      r = redact(text, rcfg);
    } catch (e) {
      throw new RedactionUnavailable(`redact() threw (${errorMessage(e)})`);
    }
    if (typeof r.text !== 'string') throw new RedactionUnavailable('redact() returned no text');
    return { text: r.text, findings: r.findings ?? [] };
  };
  const redactNullable = (
    text: string | null,
  ): { text: string | null; findings: RedactResult['findings'] } =>
    text == null ? { text: null, findings: [] } : redactRequired(text);

  // The ACTIVE turn is the one the commit is being issued from: the agent has
  // not written its final text yet, so whatever `turn.response` holds is a
  // mid-turn narration between tool calls, not the answer. Store nothing and
  // let the upsert backfill fill it in once the turn is no longer active.
  const wantResponse = config.responses !== 'none' && !active;
  const rawPrompt = turn.prompt ?? '';
  const rawResponse = wantResponse && turn.response != null ? turn.response : null;

  const p = redactRequired(rawPrompt);
  const r = redactNullable(rawResponse);

  // A file inside the repo becomes repo-relative; one OUTSIDE it stays
  // absolute, and an absolute path is a string like any other - it can carry
  // the user's home directory (portability) and, in a scratch filename, a
  // secret (`/tmp/aws-AKIA....json`). So it is home-collapsed and passes
  // through the redactor exactly like the prompt and the response do; there
  // is no path by which unredacted text reaches the store.
  const fileFindings: RedactResult['findings'] = [];
  const files: string[] = [];
  for (const raw of turn.files) {
    const relPath = gitmod.normalizeRepoPath(raw, root);
    if (!relPath) continue;
    if (!path.isAbsolute(relPath)) {
      files.push(relPath);
      continue;
    }
    const collapsed = homeCollapse(relPath);
    const red = redactRequired(collapsed);
    if (red.text) files.push(red.text);
    fileFindings.push(...red.findings);
  }

  const findings: RedactionRecord[] = [];
  const seenFinding = new Set<string>();
  for (const f of [...p.findings, ...r.findings, ...fileFindings]) {
    const key = `${f.kind}:${f.hash4}`;
    if (seenFinding.has(key)) continue;
    seenFinding.add(key);
    findings.push({ kind: f.kind, hash4: f.hash4 });
  }

  return {
    id: turn.id,
    fullId: turn.fullId,
    parentId: parentGid(turn, { agent, sessionId, gidByFullId }),
    ts: isoFormatUtc(turn.tsMicros).replace('+00:00', 'Z'),
    durationS: Math.round(turn.durationS * 10) / 10,
    prompt: p.text,
    response: r.text,
    // Derived from active-ness, not from the parser's field: an active turn
    // is pending by definition, whatever text it has emitted so far.
    responsePending: active ? true : turn.responsePending,
    isCommand: turn.isCommand,
    tokens: {
      output: turn.outputTokens,
      input: turn.inputTokens,
      cacheRead: turn.cacheReadTokens,
      cacheWrite: turn.cacheWriteTokens,
      thinking: turn.thinkingTokens,
    },
    // Subagent usage for this turn, kept SEPARATE from `tokens` above: the
    // record says what the prompt itself cost and what the agents it spawned
    // cost, and never adds one into the other (DESIGN.md "Subagent usage").
    subagents: { ...turn.subagents },
    toolCalls: turn.toolCalls,
    toolNames: Object.fromEntries(turn.toolNames),
    files: [...new Set(files)].sort(),
    models: [...new Set(turn.models)].sort(),
    origin: {
      path: homeCollapse(originPath ?? ''),
      uuid: turn.fullId,
      promptHash: sha256(rawPrompt),
      responseHash: rawResponse == null ? null : sha256(rawResponse),
    },
    redactions: findings,
    commits: normalizeCommits(commits),
  };
}

/**
 * Upsert turns into a session document.
 *
 * Merge rules per DESIGN.md: `commits` is a set union, a pending `response`
 * is filled in when a later parse has one, everything else is replaced with
 * the fresh parse.
 */
export interface UpsertSessionOptions {
  agent: string;
  sessionId: string;
  cwd?: string | null;
  started?: string | null;
  originPath?: string | null;
  config?: StoreConfig;
  commits?: CommitInput[];
  turns?: Turn[];
  activeFullId?: string | null;
}

export interface UpsertSessionResult {
  file: string;
  doc: SessionDoc;
  gids: string[];
}

export function upsertSession(root: string, opts: UpsertSessionOptions): UpsertSessionResult {
  return withLock(root, () => upsertSessionLocked(root, opts));
}

const VERSION = 1;

function upsertSessionLocked(root: string, opts: UpsertSessionOptions): UpsertSessionResult {
  const { agent, sessionId, cwd = null, started = null, originPath, config, commits = [], turns = [] } = opts;
  const activeFullId = opts.activeFullId ?? null;
  const cfg = config ?? readConfig(root);
  const file = sessionDocPath(root, agent, sessionId);
  const existing = readSessionDoc(root, agent, sessionId);
  const doc: SessionDoc = existing ?? {
    version: VERSION,
    agent,
    sessionId,
    cwd: homeCollapse(cwd ?? ''),
    machine: machineId(),
    started: started ?? new Date().toISOString(),
    turns: {},
  };
  doc.version = VERSION;
  doc.agent = agent;
  doc.sessionId = sessionId;
  if (cwd) doc.cwd = homeCollapse(cwd);
  if (!doc.machine) doc.machine = machineId();
  if (started && !existing) doc.started = started;

  const gidByFullId = new Map<string, string>();
  for (const t of turns) gidByFullId.set(t.fullId, turnGid(t));

  const gids: string[] = [];
  for (const turn of turns) {
    const gid = turnGid(turn);
    gids.push(gid);
    const prev = doc.turns[gid];
    const fresh = buildRecord(turn, {
      agent,
      sessionId,
      originPath,
      config: cfg,
      commits,
      root,
      gidByFullId,
      active: activeFullId != null && turn.fullId === activeFullId,
    });
    if (prev) {
      fresh.commits = normalizeCommits([...prev.commits, ...fresh.commits]);
      if (fresh.response == null && prev.response != null) {
        fresh.response = prev.response;
        fresh.responsePending = !!prev.responsePending && !prev.response;
        if (prev.origin.responseHash && !fresh.origin.responseHash) {
          fresh.origin.responseHash = prev.origin.responseHash;
        }
      }
      if (prev.redactions.length && !fresh.redactions.length) {
        fresh.redactions = prev.redactions;
      }
    } else {
      fresh.commits = normalizeCommits(fresh.commits);
    }
    doc.turns[gid] = fresh;
  }

  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file, doc, gids };
}

/**
 * Link `sha` to every listed gid, across all documents.
 *
 * `evidence` is the attributor's output for this commit,
 * `{ gid: { role, files } }` (DESIGN.md "Session document"). A gid with no
 * evidence still gets an entry, with role 'unknown' and no files: the
 * trailer says the turn belongs to the commit even when the per-file detail
 * was lost (a bypassed pre-commit, a `reindex` from trailers alone).
 */
export interface CommitEvidenceEntry {
  role?: CommitRole;
  files?: Record<string, CommitFileEvidence>;
}

export interface AddCommitOptions {
  evidence?: Map<string, CommitEvidenceEntry> | Record<string, CommitEvidenceEntry> | null;
}

export interface AddCommitResult {
  changed: number;
  files: string[];
}

export function addCommitToGids(
  root: string,
  gids: string[],
  sha: string,
  opts: AddCommitOptions = {},
): AddCommitResult {
  return withLock(root, () => addCommitToGidsLocked(root, gids, sha, opts));
}

function addCommitToGidsLocked(
  root: string,
  gids: string[],
  sha: string,
  { evidence = null }: AddCommitOptions,
): AddCommitResult {
  const want = new Set(gids ?? []);
  if (!want.size || !sha) return { changed: 0, files: [] };
  const ev = evidence instanceof Map ? evidence : new Map(Object.entries(evidence ?? {}));
  let changed = 0;
  const files: string[] = [];
  for (const { file, doc } of listSessionDocs(root)) {
    let dirty = false;
    for (const gid of Object.keys(doc.turns)) {
      if (!want.has(gid)) continue;
      const turnRecord = doc.turns[gid];
      if (!turnRecord) continue;
      const found = ev.get(gid) ?? null;
      const fresh: CommitEntry = {
        sha,
        role: found?.role ?? 'unknown',
        files: found?.files ?? {},
      };
      const before = JSON.stringify(normalizeCommits(turnRecord.commits));
      turnRecord.commits = normalizeCommits([...turnRecord.commits, fresh]);
      if (JSON.stringify(turnRecord.commits) !== before) {
        dirty = true;
        changed += 1;
      }
    }
    if (dirty) {
      writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
      files.push(file);
    }
  }
  return { changed, files };
}

/** post-rewrite: rewrite old shas to new ones everywhere. */
export function remapCommits(
  root: string,
  mapping: Map<string, string> | Record<string, string>,
): { changed: number } {
  return withLock(root, () => remapCommitsLocked(root, mapping));
}

function remapCommitsLocked(
  root: string,
  mapping: Map<string, string> | Record<string, string>,
): { changed: number } {
  const map = mapping instanceof Map ? mapping : new Map(Object.entries(mapping));
  if (!map.size) return { changed: 0 };
  let changed = 0;
  for (const { file, doc } of listSessionDocs(root)) {
    let dirty = false;
    for (const gid of Object.keys(doc.turns)) {
      const turnRecord = doc.turns[gid];
      if (!turnRecord) continue;
      const next: CommitEntry[] = [];
      let touched = false;
      for (const entry of normalizeCommits(turnRecord.commits)) {
        const sha = entry.sha;
        const moveTo = (to: string) => next.push({ ...entry, sha: to });
        const mapped = map.get(sha);
        if (mapped) {
          moveTo(mapped);
          touched = true;
        } else {
          // Abbreviated keys from post-rewrite stdin: the STORED full sha
          // must start with the given prefix, never the other way round (a
          // stored 7-char value must not swallow a 40-char mapping), and a
          // prefix shorter than 7 is too ambiguous to act on.
          let hit: string | null = null;
          for (const [o, n] of map.entries()) {
            if (o.length >= 7 && sha.length >= o.length && sha.startsWith(o)) {
              hit = n;
              break;
            }
          }
          if (hit) {
            moveTo(hit);
            touched = true;
          } else {
            next.push(entry);
          }
        }
      }
      if (touched) {
        turnRecord.commits = normalizeCommits(next);
        dirty = true;
        changed += 1;
      }
    }
    if (dirty) writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return { changed };
}

/** All records across all documents, chronological. */
export interface RecordEntry {
  gid: string;
  agent: string;
  sessionId: string;
  cwd: string | null;
  record: TurnRecord;
}

export function allRecords(root: string): RecordEntry[] {
  const out: RecordEntry[] = [];
  for (const { doc } of listSessionDocs(root)) {
    for (const gid of Object.keys(doc.turns)) {
      const record = doc.turns[gid];
      if (!record) continue;
      out.push({ gid, agent: doc.agent, sessionId: doc.sessionId, cwd: doc.cwd, record });
    }
  }
  out.sort((a, b) => a.record.ts.localeCompare(b.record.ts));
  return out;
}
