import os from 'node:os';
import path from 'node:path';
import { isDir } from '../../core/fsutil';
import type { Adapter, SkillScope } from '../types';
import { edits } from './edits';
import { findSession, locate, newestForCwd, peekClaudeMeta } from './locate';
import { parseClaudeSession } from './parser';
import { parseStatusInput } from './statusline';
import { children } from './subagents';

function claudeHome(home?: string | null): string {
  return path.join(home || os.homedir(), '.claude');
}

function detectInstalled(home: string): boolean {
  return isDir(claudeHome(home));
}

function skillDirs(scope: SkillScope, home: string, cwd: string): string[] {
  if (scope === 'project') return [path.join(cwd || process.cwd(), '.claude', 'skills')];
  return [path.join(claudeHome(home), 'skills')];
}

export const claude: Adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    parse: true,
    liveSession: true,
    edits: true,
    tokens: true,
    hooks: true,
    statusline: true,
    subagents: true,
  },
  sessionEnvVars: ['CLAUDE_CODE_SESSION_ID'],
  detectInstalled,
  skillDirs,
  locate,
  newestForCwd,
  findSession,
  parse: parseClaudeSession,
  edits,
  /** Subagent transcripts under `<session dir>/subagents/`, linked to the
   * turn that spawned them by the `tool_use` id in each agent's meta sidecar.
   * See ./subagents.ts. */
  children,
  /** Which kind of UI produced this session. Claude Code sets
   * `CLAUDE_CODE_ENTRYPOINT=cli` for its terminal; we have not yet observed
   * what (if anything) the desktop/web hosts set, so anything else -
   * including unset - stays 'unknown' rather than guessed. Refine once a
   * desktop-side value is confirmed. */
  ui({ env }) {
    if (env.CLAUDE_CODE_ENTRYPOINT === 'cli') return 'terminal';
    return 'unknown';
  },
  /** `promptlog statusline`'s only Claude-specific hook: does `text` look
   * like the JSON Claude Code pipes to a statusLine command? See
   * ./statusline.ts - the only file that knows that shape. */
  parseStatusInput,
  /** Cheap session id lookup for a transcript path, used by the core
   * resolver to fill in `sessionId` without a full parse. */
  sessionIdFor(filePath) {
    return peekClaudeMeta(filePath)?.sessionId ?? null;
  },
  /** Filename heuristic used to route an explicit `--session <path>` to the
   * right adapter when `--agent auto`: anything not shaped like a Codex
   * rollout file defaults to Claude. */
  looksLikeOwnFile(basename) {
    return !basename.startsWith('rollout-');
  },
};
