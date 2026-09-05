/**
 * Cursor edit evidence (PLAN-v0.3.md §3.2).
 *
 * Tier A: `ApplyPatch` tool_use calls, whose `input` is the same V4A patch
 *         text Codex's `apply_patch` uses (`*** Begin Patch` / `*** Update
 *         File:` / `@@` / `+`/`-` lines) - parsed with codex/edits.ts's
 *         `parseV4A` rather than a second copy of it.
 * Tier B: `Shell` (and `run_terminal_command`, seen in some Cursor builds)
 *         tool_use `input.command` strings, parsed for written paths by the
 *         shared shell parser in core/shellWrites.ts.
 *
 * Cursor's JSONL has no per-record timestamp (see parser.ts), so records
 * can't be assigned to a turn by "last turn starting at or before this
 * ts" the way codex/edits.ts does. Instead this re-runs the exact same
 * prompt-boundary test the parser uses (`isPromptRecord`, imported rather
 * than reimplemented) over the transcript a second time: the Nth prompt
 * record encountered is `session.turns[N]`, so every record between it and
 * the next prompt belongs to that turn - by construction, never a guess.
 */

import { readJsonl } from '../../core/fsutil';
import { isRecord, str } from '../../core/json';
import type { Session } from '../../core/model';
import { locateFile, parseShellWrites } from '../../core/shellWrites';
import { parseV4A } from '../codex/edits';
import type { Edit } from '../types';
import { isPromptRecord } from './parser';

const PATCH_START = '*** Begin Patch';
const SHELL_TOOL_NAMES = new Set(['Shell', 'run_terminal_command', 'shell', 'bash', 'Bash']);

export function edits(session: Session | null, opts: { root?: string | null } = {}): Edit[] {
  if (!session?.path) return [];
  const turns = session.turns ?? [];
  if (!turns.length) return [];

  const cwd = session.cwd || process.cwd();
  const root = opts.root ?? null;
  const out: Edit[] = [];
  let turnIndex = -1; // -1: no prompt seen yet (records before the first turn)

  for (const rec of readJsonl(session.path)) {
    if (str(rec.role) === 'user') {
      if (isPromptRecord(rec) !== null) turnIndex += 1;
      continue;
    }
    if (str(rec.role) !== 'assistant') continue;
    if (turnIndex < 0 || turnIndex >= turns.length) continue;
    const turn = turns[turnIndex];
    if (!turn) continue;

    const message = rec.message;
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const name = str(block.name);
      const input = block.input;
      if (!name) continue;

      // Tier A.
      if (name === 'ApplyPatch' && typeof input === 'string' && input.includes(PATCH_START)) {
        const parsed = parseV4A(input);
        for (const f of parsed) {
          const target = f.movedTo || f.file;
          const at = locateFile(target, { cwd, root });
          if (!at) continue;
          out.push({
            turnId: turn.gid,
            file: at.file,
            rel: at.rel,
            kind: 'patch',
            hunks: f.hunks.map((h) => ({ removed: h.removed.slice(), added: h.added.slice() })),
            tsMicros: turn.tsMicros,
          });
        }
        // A rename also leaves the old path changed (deleted).
        for (const f of parsed) {
          if (!f.movedTo) continue;
          const at = locateFile(f.file, { cwd, root });
          if (!at) continue;
          out.push({
            turnId: turn.gid,
            file: at.file,
            rel: at.rel,
            kind: 'patch',
            hunks: [],
            tsMicros: turn.tsMicros,
          });
        }
        continue;
      }

      // Tier B.
      if (SHELL_TOOL_NAMES.has(name) && isRecord(input)) {
        const command = str(input.command);
        if (!command) continue;
        for (const p of parseShellWrites(command)) {
          const at = locateFile(p, { cwd, root });
          if (!at) continue;
          out.push({ turnId: turn.gid, file: at.file, rel: at.rel, kind: 'shell', tsMicros: turn.tsMicros });
        }
      }
    }
  }
  return out;
}
