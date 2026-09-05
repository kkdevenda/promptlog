/**
 * The only place that knows the shape of the JSON Claude Code pipes to its
 * `statusLine` command: `session_id`, `cwd`, `workspace.current_dir`,
 * `model.display_name`, `context_window.*`. Core (`promptlog statusline`)
 * never parses this itself - it only knows `capabilities.statusline` and
 * calls `parseStatusInput`.
 */

import { rec, str } from '../../core/json';
import type { StatusInput } from '../types';

/** `text` -> `{sessionId, cwd}` if it looks like Claude Code's statusLine
 * JSON (has a `session_id`), else `null`. Never throws. */
export function parseStatusInput(text: string): StatusInput | null {
  if (!text.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = rec(data);
  if (!d) return null;

  const sessionId = str(d.session_id);
  if (!sessionId) return null;

  const workspaceDir = str(rec(d.workspace)?.current_dir);
  const cwd = str(d.cwd) || workspaceDir || null;

  return { sessionId, cwd };
}
