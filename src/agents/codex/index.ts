import os from 'node:os';
import path from 'node:path';
import { isDir } from '../../core/fsutil';
import type { Adapter } from '../types';
import { edits } from './edits';
import { findSession, locate, newestForCwd, readCodexSessionMeta } from './locate';
import { parseCodexSession } from './parser';
import { children } from './subagents';

function codexHome(home: string): string {
  return path.join(home || os.homedir(), '.codex');
}

export const codex: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  // statusline: false - Codex has no custom status line hook today; core
  // falls back to `promptlog status` behaviour for it.
  capabilities: {
    parse: true,
    liveSession: true,
    edits: true,
    tokens: true,
    hooks: true,
    statusline: false,
    subagents: true,
  },
  sessionEnvVars: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID'],

  detectInstalled(home) {
    return isDir(codexHome(home));
  },
  skillDirs(scope, home, cwd) {
    if (scope === 'project') return [path.join(cwd || process.cwd(), '.codex', 'skills')];
    return [path.join(codexHome(home), 'skills')];
  },
  locate,
  findSession,
  newestForCwd,
  parse: parseCodexSession,
  edits,
  /** Spawned threads: separate rollouts naming this one in
   * `session_meta.payload.parent_thread_id`, linked to a turn by time. Their
   * usage is NOT part of this thread's own - measured, see ./subagents.ts. */
  children,
  /** Which kind of UI produced this transcript, from
   * `session_meta.payload.originator` (kept on `session.meta.originator` by
   * the parser). Verified values on real machines: `codex-tui` and
   * `codex_exec` are both terminal UIs; `Codex Desktop` and
   * `codex_work_desktop` are the desktop app. Anything else (e.g.
   * `codex_cli_rs`, `buzz-acp`, or a missing originator) is 'unknown' -
   * never guess desktop for an unrecognized value. */
  ui({ session }) {
    const originator = session?.meta.originator;
    if (originator === 'codex-tui' || originator === 'codex_exec') return 'terminal';
    if (originator === 'Codex Desktop' || originator === 'codex_work_desktop') return 'desktop';
    return 'unknown';
  },
  /** Cheap session id lookup for a transcript path, used by the core
   * resolver to fill in `sessionId` without a full parse. */
  sessionIdFor(filePath) {
    const meta = readCodexSessionMeta(filePath) ?? {};
    return typeof meta.id === 'string' ? meta.id : path.basename(filePath);
  },
  /** Filename heuristic used to route an explicit `--session <path>` to the
   * right adapter when `--agent auto`. */
  looksLikeOwnFile(basename) {
    return basename.startsWith('rollout-');
  },
};
