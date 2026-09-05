/**
 * Claude Code edit evidence (PLAN-v0.3.md §3.2).
 *
 * The shared Session model keeps only what every agent has in common, so the
 * tool-call payloads are re-read from the transcript here. Records are mapped
 * to their turn by walking `parentUuid` up to the nearest prompt record, which
 * is exactly how the parser assigns them - so an edit is never credited to a
 * neighbouring turn.
 *
 * Tier A: `Edit` (old_string/new_string), `Write` (content), `MultiEdit`
 *         (one entry per sub-edit), `NotebookEdit` (path only - the payload
 *         has no line-level before/after we can match).
 * Tier B: `Bash` command strings parsed for written paths.
 */

import { readJsonl } from '../../core/fsutil';
import { bool, rec, str } from '../../core/json';
import type { JsonRecord, Session } from '../../core/model';
import { locateFile, parseShellWrites } from '../../core/shellWrites';
import { parseIsoStringToMicros } from '../../core/util';
import type { Edit, EditKind } from '../types';

export function edits(session: Session, { root = null }: { root?: string | null } = {}): Edit[] {
  if (!session?.path) return [];
  const gidByFullId = new Map<string, string>();
  for (const t of session.turns) gidByFullId.set(t.fullId, t.gid);
  if (!gidByFullId.size) return [];

  const records = readJsonl(session.path);
  const byUuid = new Map<string, JsonRecord>();
  for (const r of records) {
    const uid = str(r.uuid);
    if (uid) byUuid.set(uid, r);
  }

  /** Nearest ancestor that is one of this session's turns. */
  const ownerCache = new Map<string, string | null>();
  function ownerOf(uuid: string | null): string | null {
    if (uuid == null) return null;
    const chain: string[] = [];
    let cur: string | null = uuid;
    let found: string | null = null;
    const seen = new Set<string>();
    while (cur != null && !seen.has(cur)) {
      if (ownerCache.has(cur)) {
        found = ownerCache.get(cur) ?? null;
        break;
      }
      seen.add(cur);
      const gid = gidByFullId.get(cur);
      if (gid !== undefined) {
        found = gid;
        chain.push(cur);
        break;
      }
      chain.push(cur);
      const r = byUuid.get(cur);
      if (!r) break;
      cur = str(r.parentUuid);
    }
    for (const c of chain) ownerCache.set(c, found);
    return found;
  }

  const cwd = session.cwd || process.cwd();
  const out: Edit[] = [];
  const push = (
    turnId: string,
    file: string,
    kind: EditKind,
    before: string | null,
    after: string | null,
    tsMicros: number | null,
  ): void => {
    const at = locateFile(file, { cwd, root });
    if (!at) return;
    out.push({
      turnId,
      file: at.file,
      rel: at.rel,
      kind,
      before: before ?? undefined,
      after: after ?? undefined,
      tsMicros: tsMicros ?? 0,
    });
  };

  for (const r of records) {
    if (bool(r.isSidechain)) continue;
    if (r.type !== 'assistant') continue;
    const message = rec(r.message);
    if (!message) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const turnId = ownerOf(str(r.uuid));
    if (!turnId) continue;
    const ts = parseIsoStringToMicros(r.timestamp);

    for (const block of content) {
      const b = rec(block);
      if (b?.type !== 'tool_use') continue;
      const input = rec(b.input) ?? {};
      const name = b.name;

      if (name === 'Edit') {
        const filePath = str(input.file_path);
        if (!filePath) continue;
        push(turnId, filePath, 'edit', str(input.old_string), str(input.new_string), ts);
      } else if (name === 'Write') {
        const filePath = str(input.file_path);
        if (!filePath) continue;
        push(turnId, filePath, 'write', null, str(input.content), ts);
      } else if (name === 'MultiEdit') {
        // Not seen on this machine (Claude Code dropped it), kept because a
        // transcript written by an older build still has it.
        const file = str(input.file_path);
        if (!file) continue;
        for (const sub of Array.isArray(input.edits) ? input.edits : []) {
          const s = rec(sub);
          if (!s) continue;
          push(turnId, file, 'edit', str(s.old_string), str(s.new_string), ts);
        }
      } else if (name === 'NotebookEdit') {
        const file = str(input.notebook_path) || str(input.file_path);
        if (!file) continue;
        // The payload is a cell replacement, not a file diff: file level only.
        push(turnId, file, 'notebook', null, null, ts);
      } else if (name === 'Bash' || name === 'Shell') {
        const command = str(input.command);
        if (!command) continue;
        for (const p of parseShellWrites(command)) {
          push(turnId, p, 'shell', null, null, ts);
        }
      }
    }
  }
  return out;
}
