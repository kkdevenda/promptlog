/**
 * The shared data model every adapter parses into and every renderer reads.
 * A `Session` is one transcript; a `Turn` is one human prompt plus everything
 * the agent did until the next one (docs/DESIGN.md "Vocabulary").
 */

import { isoFormatUtc } from './util';

export type Source = 'origin' | 'origin-modified' | 'repo';

/** How a subagent transcript was tied to the turn that spawned it. */
export type Linkage = 'exact' | 'time' | 'mixed' | 'none';

/** Token usage of one or more subagent transcripts. `linkage` is null while
 * `count` is 0 (DESIGN.md "Subagent usage"). */
export interface SubagentUsage {
  count: number;
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  linkage: Linkage | null;
}

export interface TokenUsage {
  output: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

export function zeroSubagents(): SubagentUsage {
  return { count: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, linkage: null };
}

/** Add `src` into `dst` in place, widening `linkage` to 'mixed' when two
 * differently-linked children land in the same bucket. Returns `dst`. */
export function addSubagentUsage(dst: SubagentUsage, src: Partial<SubagentUsage>): SubagentUsage {
  dst.count += src.count ?? 0;
  dst.output += src.output ?? 0;
  dst.input += src.input ?? 0;
  dst.cacheRead += src.cacheRead ?? 0;
  dst.cacheWrite += src.cacheWrite ?? 0;
  dst.thinking += src.thinking ?? 0;
  const l = src.linkage ?? null;
  if (l) dst.linkage = dst.linkage == null || dst.linkage === l ? l : 'mixed';
  return dst;
}

/** Increment `key` in a count map. */
export function inc(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/** Entries of a count map, most common first (stable for ties). */
export function mostCommon(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export interface TurnInit {
  id: string;
  fullId: string;
  parentId: string | null;
  agent: string;
  sessionId?: string | null;
  tsMicros: number;
  prompt: string;
  isCommand?: boolean;
  response?: string | null;
  responsePending?: boolean;
  source?: Source;
}

export class Turn {
  id: string;
  fullId: string;
  parentId: string | null;
  agent: string;
  sessionId: string | null;
  /** Epoch microseconds, UTC. */
  tsMicros: number;
  prompt: string;
  isCommand: boolean;
  response: string | null;
  responsePending: boolean;
  source: Source;
  durationS = 0;
  outputTokens = 0;
  inputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  thinkingTokens = 0;
  toolCalls = 0;
  toolNames = new Map<string, number>();
  files = new Set<string>();
  models = new Set<string>();
  children: string[] = [];
  /** Usage of the subagent transcripts this turn spawned. NEVER folded into
   * the turn's own token fields: a row shows own usage, only headline totals
   * show own + subagents (DESIGN.md "Subagent usage"). */
  subagents: SubagentUsage = zeroSubagents();

  constructor(init: TurnInit) {
    this.id = init.id;
    this.fullId = init.fullId;
    this.parentId = init.parentId;
    this.agent = init.agent;
    this.sessionId = init.sessionId ?? null;
    this.tsMicros = init.tsMicros;
    this.prompt = init.prompt;
    this.isCommand = init.isCommand ?? false;
    this.response = init.response ?? null;
    this.responsePending = init.responsePending ?? false;
    this.source = init.source ?? 'origin';
  }

  /** Global prompt id `<agent>:<sessionId8>:<shortId>` (DESIGN.md "Prompt
   * identity"): stable, and the key everywhere in the repo store. */
  get gid(): string {
    return `${this.agent}:${(this.sessionId ?? '').slice(0, 8)}:${this.id}`;
  }

  toJSON(): TurnJson {
    return {
      id: this.id,
      full_id: this.fullId,
      parent_id: this.parentId,
      agent: this.agent,
      session_id: this.sessionId,
      gid: this.gid,
      ts: isoFormatUtc(this.tsMicros),
      prompt: this.prompt,
      response: this.response,
      response_pending: this.responsePending,
      source: this.source,
      is_command: this.isCommand,
      duration_s: this.durationS,
      output_tokens: this.outputTokens,
      input_tokens: this.inputTokens,
      cache_read_tokens: this.cacheReadTokens,
      cache_write_tokens: this.cacheWriteTokens,
      thinking_tokens: this.thinkingTokens,
      tool_calls: this.toolCalls,
      tool_names: Object.fromEntries(this.toolNames),
      files: [...this.files].sort(),
      models: [...this.models].sort(),
      children: [...this.children],
      subagents: { ...this.subagents },
    };
  }
}

export interface TurnJson {
  id: string;
  full_id: string;
  parent_id: string | null;
  agent: string;
  session_id: string | null;
  gid: string;
  ts: string;
  prompt: string;
  response: string | null;
  response_pending: boolean;
  source: Source;
  is_command: boolean;
  duration_s: number;
  output_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
  tool_calls: number;
  tool_names: Record<string, number>;
  files: string[];
  models: string[];
  children: string[];
  subagents: SubagentUsage;
}

export interface SessionInit {
  id: string;
  agent: string;
  path: string;
  cwd: string | null;
  startedMicros: number | null;
  turns?: Turn[];
  roots?: string[];
  meta?: Record<string, unknown>;
}

export class Session {
  id: string;
  agent: string;
  path: string;
  cwd: string | null;
  startedMicros: number | null;
  /** Chronological. */
  turns: Turn[];
  /** fullIds of the turns with no parent. */
  roots: string[];
  /** Adapter-specific transcript metadata not otherwise modeled (Codex's
   * `originator`, Claude's `toolUseOwners`). Read only by that adapter. */
  meta: Record<string, unknown>;
  /** Subagent transcripts of this session that belong to no single turn:
   * counted in the headline totals, attributed to no row. */
  subagentsUnattributed: SubagentUsage = zeroSubagents();
  /** How many subagent transcripts were read. Invariant: sum of
   * turn.subagents.count + subagentsUnattributed.count === subagentFiles. */
  subagentFiles = 0;
  /** Message ids seen in more than one transcript and counted once. */
  subagentDuplicateIds = 0;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.agent = init.agent;
    this.path = init.path;
    this.cwd = init.cwd;
    this.startedMicros = init.startedMicros;
    this.turns = init.turns ?? [];
    this.roots = init.roots ?? [];
    this.meta = init.meta ?? {};
  }

  byId(tid: string): Turn | null {
    return this.turns.find((t) => t.id === tid || t.fullId === tid) ?? null;
  }

  toJSON(): SessionJson {
    return {
      id: this.id,
      agent: this.agent,
      path: this.path,
      cwd: this.cwd,
      started: this.startedMicros != null ? isoFormatUtc(this.startedMicros) : null,
      turns: this.turns.map((t) => t.toJSON()),
      roots: [...this.roots],
      subagents_unattributed: { ...this.subagentsUnattributed },
      subagent_files: this.subagentFiles,
      subagent_duplicate_ids: this.subagentDuplicateIds,
    };
  }
}

export interface SessionJson {
  id: string;
  agent: string;
  path: string;
  cwd: string | null;
  started: string | null;
  turns: TurnJson[];
  roots: string[];
  subagents_unattributed: SubagentUsage;
  subagent_files: number;
  subagent_duplicate_ids: number;
}

/** One parsed line of a JSONL transcript. Fields are read through the
 * narrowing helpers in ./json, never trusted as typed. */
export type JsonRecord = Record<string, unknown>;
