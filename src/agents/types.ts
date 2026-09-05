/**
 * The adapter contract (docs/PLAN-v0.3.md §2, docs/DESIGN.md "Adapter
 * contract"). One object per agent, registered in ./index.ts. Core never
 * reads a transcript format itself: everything agent-specific lives behind
 * this interface.
 */

import type { Linkage, Session, TokenUsage } from '../core/model';

export interface Capabilities {
  /** `parse(path)` returns a real Session. */
  parse: boolean;
  /** Has a session-id env var naming the live session. */
  liveSession: boolean;
  /** `edits()` returns real data, not []. */
  edits: boolean;
  /** Parsed turns carry real token counts. */
  tokens: boolean;
  /** Set with `tokens: false` when counts come from a side channel for some
   * turns only, so a zero is not necessarily "no tokens used". */
  tokensPartial?: boolean;
  /** Meaningful under git hooks (has files to attribute). */
  hooks: boolean;
  /** Implements `parseStatusInput`. */
  statusline: boolean;
  /** `children()` returns real transcripts, not []. */
  subagents: boolean;
}

export type SkillScope = 'user' | 'project';

export type Ui = 'terminal' | 'desktop' | 'unknown';

export interface LocateOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  home?: string | null;
  /** Only transcripts with mtime >= since (epoch ms). */
  since?: number;
}

export interface Located {
  path: string;
  sessionId: string;
  /** Epoch ms. */
  mtime: number;
}

export interface LocatedSession extends Located {
  agent: string;
}

export type EditKind = 'edit' | 'write' | 'notebook' | 'patch' | 'shell';

export interface PatchHunk {
  removed: string[];
  added: string[];
}

/** One edit an agent made, as evidence for attribution (DESIGN.md "Evidence
 * tiers"). Tier A kinds carry text to match hunk by hunk; 'shell' is file
 * level only. */
export interface Edit {
  /** The turn's gid. */
  turnId: string;
  /** Absolute path. */
  file: string;
  /** Repo-relative when inside the root, else null. */
  rel: string | null;
  kind: EditKind;
  /** 'edit': old text. */
  before?: string;
  /** 'edit': new text; 'write': the whole content. */
  after?: string;
  /** 'patch' only. */
  hunks?: PatchHunk[];
  tsMicros: number;
}

export interface Child {
  /** Absolute path to the child transcript. */
  path: string;
  agentId: string;
  parentAgentId: string | null;
  /** The TOP-LEVEL turn's fullId, or null when it cannot be tied to one. The
   * key core links on. */
  spawnedByTurnId: string | null;
  /** The same turn's gid, display only (gids can collide on a 7-char id). */
  spawnedByTurnGid: string | null;
  linkage: Linkage;
  /** This transcript's OWN usage, never already inside the parent's. */
  usage: TokenUsage;
}

export interface ChildrenResult {
  children: Child[];
  /** Message ids seen in more than one file and counted once. */
  duplicates: number;
}

export interface StatusInput {
  sessionId: string | null;
  cwd: string | null;
}

export interface Adapter {
  /** Short lowercase id: used in gids and as the `--agent` value. */
  id: string;
  displayName: string;
  capabilities: Capabilities;
  /** Env vars naming the live session, first present wins. */
  sessionEnvVars: string[];

  /** Is this agent installed on this machine (e.g. `~/.claude` exists)? */
  detectInstalled(home: string): boolean;
  /** Where this agent looks for skills at the given scope. */
  skillDirs(scope: SkillScope, home: string, cwd: string): string[];
  /** Every transcript whose recorded cwd is under `cwd`, bounded by mtime. */
  locate(opts: LocateOptions): Located[];
  /** Resolve an explicit id, prefix, or path to a transcript path. */
  findSession(idOrPath: string, opts: { cwd?: string; home?: string | null }): string | null;
  /** The single newest transcript for a repo (DESIGN.md resolution step 4). */
  newestForCwd(opts: { cwd: string; gitRoot: string; home?: string | null }): LocatedSession | null;
  /** Parse a transcript into the shared model. Throws on an unreadable file. */
  parse(path: string): Session;
  /** Edit evidence for attribution; re-reads `session.path` for payloads. */
  edits(session: Session, opts: { root: string }): Edit[];
  /** Every subagent transcript of the session, each exactly once. Fails open. */
  children(session: Session, opts: { home?: string | null }): ChildrenResult;
  /** Which UI the host runs in. 'unknown' whenever unsure, never 'desktop'. */
  ui(opts: { session: Session | null; env: NodeJS.ProcessEnv }): Ui;
  /** Session id of a transcript without a full parse. */
  sessionIdFor(filePath: string): string | null;
  /** Does this basename look like one of this agent's own transcript files?
   * Routes an explicit `--session <path>` under `--agent auto`. */
  looksLikeOwnFile(basename: string): boolean;
  /** Only with `capabilities.statusline`: parse what the host pipes to a
   * status-line command. Returns null when the shape is not recognised. */
  parseStatusInput?(text: string): StatusInput | null;
}
