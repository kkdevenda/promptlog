/**
 * Cursor subagent transcripts (DESIGN.md "Subagent usage").
 *
 * They exist - `agent-transcripts/<uuid>/subagents/<uuid>.jsonl`, which
 * locate.ts already skips when it enumerates sessions - but they carry NO
 * token counts: every usage field in every one of them is zero, on this
 * machine and in the fixtures. So they are reported as children with zero
 * usage and no arithmetic is done on them. Listing the files is truthful;
 * inventing numbers for them would not be, and adding zeros to a total is
 * the same as adding nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../../core/model';
import type { ChildrenResult } from '../types';

export function children(session: Session): ChildrenResult {
  const out: ChildrenResult = { children: [], duplicates: 0 };
  const dir = path.join(path.dirname(session.path), 'subagents');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.filter((f) => f.endsWith('.jsonl')).sort()) {
    out.children.push({
      path: path.join(dir, name),
      agentId: name.slice(0, -6),
      parentAgentId: null,
      spawnedByTurnId: null,
      spawnedByTurnGid: null,
      // Not 'time': nothing was matched. The file is listed, its usage is
      // zero, and no turn is credited with it.
      linkage: 'none',
      usage: { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    });
  }
  return out;
}
