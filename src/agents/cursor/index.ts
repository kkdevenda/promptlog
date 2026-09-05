import os from 'node:os';
import path from 'node:path';
import { isDir } from '../../core/fsutil';
import type { Adapter, SkillScope } from '../types';
import { edits } from './edits';
import { findSession, locate, newestForCwd } from './locate';
import { parseCursorSession } from './parser';
import { children } from './subagents';

function cursorHome(home: string): string {
  return path.join(home || os.homedir(), '.cursor');
}

function skillDirs(scope: SkillScope, home: string, cwd?: string): string[] {
  if (scope === 'project') return [path.join(cwd || process.cwd(), '.cursor', 'skills')];
  return [path.join(cursorHome(home), 'skills')];
}

export const cursor: Adapter = {
  id: 'cursor',
  displayName: 'Cursor',
  // parse: transcripts parse into the shared Session model. liveSession:
  // no env var names the live session (see sessionEnvVars). edits: true -
  // ApplyPatch (tier A, via codex/edits.ts's shared parseV4A) and Shell
  // (tier B, via core/attribution.ts's parseShellWrites), see edits.ts.
  // tokens: false (see tokensPartial) because the JSONL itself has none -
  // the SQLite sidecar (sidecar.ts) fills them in when a matching
  // composer/bubble is found, and only inputTokens/outputTokens (no
  // cache/thinking split Cursor doesn't track). hooks: true, turns do
  // carry files (ReadFile/Read/ApplyPatch paths) worth attributing.
  // statusline: false - Cursor has no custom status line hook today; core
  // falls back to `promptlog status` behaviour for it.
  capabilities: {
    parse: true,
    liveSession: false,
    edits: true,
    tokens: false,
    tokensPartial: true,
    hooks: true,
    statusline: false,
    subagents: true,
  },
  // No environment variable naming the live Cursor session was found on
  // this machine (PLAN-v0.3.md §4); session resolution falls back to
  // newest-for-cwd, which does not need one.
  sessionEnvVars: [],
  detectInstalled(home) {
    return isDir(cursorHome(home));
  },
  skillDirs,
  locate,
  findSession,
  newestForCwd,
  parse: parseCursorSession,
  edits,
  /** Subagent transcripts next to the session file. Listed with zero usage:
   * Cursor records no token counts for them. See ./subagents.ts. */
  children,
  /** No known signal yet for which UI produced a Cursor transcript. */
  ui() {
    return 'unknown';
  },
  /** Cheap session id lookup for a transcript path: the uuid is the
   * filename itself, no parse required. */
  sessionIdFor(filePath) {
    const base = path.basename(filePath);
    return base.endsWith('.jsonl') ? base.slice(0, -6) : base;
  },
  /** Filename heuristic used to route an explicit `--session <path>` to the
   * right adapter under `--agent auto`: a Cursor transcript's basename is
   * its own uuid (`<uuid>.jsonl`), which looks just like a bare Claude
   * session file. Only meaningful when the caller can't otherwise pick an
   * adapter (e.g. by which one's locate() finds it), so this stays
   * permissive rather than trying to out-guess Claude's own
   * looksLikeOwnFile — never claimed by cursor over an explicit path unless
   * it actually sits under a `.cursor/projects/.../agent-transcripts/`
   * directory. */
  looksLikeOwnFile() {
    return false;
  },
};
