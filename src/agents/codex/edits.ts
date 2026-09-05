/**
 * Codex CLI edit evidence (PLAN-v0.3.md §3.2).
 *
 * Tier A: `apply_patch` calls, whose payload is a V4A patch
 *         (`*** Begin Patch` / `*** Update File:` / `@@` / `+`-`-` lines),
 *         parsed into per-file hunks. Also picked up when a patch is piped to
 *         `apply_patch` from inside a shell command.
 * Tier B: shell command strings parsed for written paths. On this machine the
 *         shell tool is named `exec_command` (function_call) or `exec`
 *         (custom_tool_call, whose input is JS calling `tools.exec_command`);
 *         the older `shell`/`Shell` names are handled too.
 *
 * Records are assigned to the turn that was open when they were written:
 * Codex turns are strictly sequential, so the last turn starting at or before
 * a record's timestamp is that turn.
 */

import { readJsonl } from '../../core/fsutil';
import { rec, str } from '../../core/json';
import type { Session, Turn } from '../../core/model';
import { locateFile, parseShellWrites } from '../../core/shellWrites';
import { parseIsoStringToMicros } from '../../core/util';
import type { Edit, PatchHunk } from '../types';

const PATCH_START = '*** Begin Patch';

// ------------------------------------------------------------ V4A patch

interface V4AFile {
  file: string;
  op: 'update' | 'add' | 'delete';
  movedTo: string | null;
  hunks: PatchHunk[];
}

/**
 * Parse a V4A patch into per-file hunks.
 *
 *   *** Begin Patch
 *   *** Update File: path/to/a
 *   *** Move to: path/to/b          (optional, renames)
 *   @@ optional context header
 *    context line
 *   -removed
 *   +added
 *   *** Add File: path/to/new
 *   +every line
 *   *** Delete File: path/to/gone
 *   *** End Patch
 */
export function parseV4A(text: unknown): V4AFile[] {
  const src = text == null ? '' : String(text);
  if (!src.includes(PATCH_START)) return [];
  const lines = src.split(/\r?\n/);
  const files: V4AFile[] = [];
  // Boxed (not plain `let`s) so TS re-checks their narrowed type after each
  // openFile()/openHunk() call instead of assuming they are still whatever
  // they were at the last assignment textually visible in this scope.
  const cur: { file: V4AFile | null; hunk: PatchHunk | null } = { file: null, hunk: null };

  const openFile = (file: string, op: 'update' | 'add' | 'delete') => {
    cur.file = { file, op, movedTo: null, hunks: [] };
    files.push(cur.file);
    cur.hunk = null;
  };
  const openHunk = () => {
    if (!cur.file) return;
    cur.hunk = { removed: [], added: [] };
    cur.file.hunks.push(cur.hunk);
  };

  let started = false;
  for (const line of lines) {
    if (!started) {
      if (line.startsWith(PATCH_START)) started = true;
      continue;
    }
    if (line.startsWith('*** End Patch')) break;
    let m = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) {
      openFile(m[2], m[1].toLowerCase() as 'update' | 'add' | 'delete');
      if (m[1] === 'Add') openHunk();
      continue;
    }
    m = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) {
      if (cur.file) cur.file.movedTo = m[1];
      continue;
    }
    if (line.startsWith('*** ')) continue; // any other directive
    if (!cur.file) continue;
    if (line.startsWith('@@')) {
      openHunk();
      continue;
    }
    if (!cur.hunk) openHunk();
    if (line.startsWith('+')) cur.hunk?.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.hunk?.removed.push(line.slice(1));
    // context (' ' prefixed or empty) carries no evidence either way
  }
  return files;
}

// ------------------------------------------------------- payload extraction

function asObject(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  const r = rec(value);
  if (r) return r;
  if (typeof value === 'string') {
    try {
      return rec(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

/** The patch text of an apply_patch call, whatever shape it arrived in. */
function patchTextOf(payload: Record<string, unknown>): string | null {
  const raw = payload.input !== undefined ? payload.input : payload.arguments;
  if (typeof raw === 'string' && raw.includes(PATCH_START)) return raw;
  const obj = asObject(raw);
  if (obj) {
    for (const key of ['input', 'patch', 'text', 'contents']) {
      const v = obj[key];
      if (typeof v === 'string' && v.includes(PATCH_START)) return v;
    }
  }
  return null;
}

/** Every shell command string a tool call carries. */
function commandsOf(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const raw = payload.input !== undefined ? payload.input : payload.arguments;
  const obj = asObject(raw);
  if (obj) {
    if (typeof obj.cmd === 'string') out.push(obj.cmd);
    if (typeof obj.command === 'string') out.push(obj.command);
    if (Array.isArray(obj.command)) {
      // `{"command": ["bash", "-lc", "..."]}`: the script is the last element.
      const last = obj.command[obj.command.length - 1];
      if (typeof last === 'string') out.push(last);
    }
  } else if (typeof raw === 'string') {
    // The `exec` tool's input is JavaScript calling tools.exec_command({cmd}).
    const re = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = re.exec(raw)) !== null) {
      const lit = m[1] ?? '';
      if (lit.startsWith('"')) {
        try {
          out.push(JSON.parse(lit));
        } catch {
          out.push(lit.slice(1, -1));
        }
      } else {
        out.push(lit.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'"));
      }
    }
    if (!out.length && raw.includes(PATCH_START)) out.push(raw);
  }
  return out;
}

function isShellName(name: string | null): boolean {
  return (
    name != null &&
    ['exec', 'exec_command', 'shell', 'Shell', 'bash', 'Bash', 'local_shell', 'container.exec'].includes(name)
  );
}

/** Extra fields Codex attaches to its edit evidence, beyond the shared
 * `Edit` contract: which V4A directive produced it, and (for a rename) the
 * path it moved from. Read directly off `codex.edits()`'s result. */
interface CodexEdit extends Edit {
  op?: string;
  movedFrom?: string | null;
  command?: string;
}

/** @param root repo root: entries inside it also carry `rel` */
export function edits(session: Session, { root = null }: { root?: string | null } = {}): Edit[] {
  if (!session?.path) return [];
  const turns = [...session.turns].sort((a, b) => a.tsMicros - b.tsMicros);
  if (!turns.length) return [];
  const maybeFirst = turns[0];
  const maybeLast = turns[turns.length - 1];
  if (!maybeFirst || !maybeLast) return [];
  const firstTurn: Turn = maybeFirst;
  const lastTurn: Turn = maybeLast;

  /** The turn that was open when a record at `ts` was written. */
  function ownerAt(ts: number | null): string {
    if (ts == null || !Number.isFinite(ts)) return lastTurn.gid;
    let owner: Turn = firstTurn;
    for (const t of turns) {
      if (t.tsMicros <= ts) owner = t;
      else break;
    }
    return owner.gid;
  }

  const cwd = session.cwd || process.cwd();
  const out: CodexEdit[] = [];

  for (const r of readJsonl(session.path)) {
    if (r.type !== 'response_item') continue;
    const payload = rec(r.payload) ?? {};
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue;
    const ts = parseIsoStringToMicros(str(r.timestamp) ?? '');
    const turnId = ownerAt(ts);
    const name = str(payload.name);

    // Tier A. A patch can arrive as an apply_patch call or piped to
    // `apply_patch` from a shell command; both carry the same V4A text.
    const patchTexts: string[] = [];
    const direct = patchTextOf(payload);
    if (direct) patchTexts.push(direct);
    const commands = isShellName(name) ? commandsOf(payload) : [];
    for (const c of commands) {
      if (c.includes(PATCH_START)) patchTexts.push(c);
    }

    let sawPatch = false;
    for (const text of patchTexts) {
      const parsed = parseV4A(text);
      for (const f of parsed) {
        sawPatch = true;
        const target = f.movedTo || f.file;
        const at = locateFile(target, { cwd, root });
        if (!at) continue;
        out.push({
          turnId,
          file: at.file,
          rel: at.rel,
          kind: 'patch',
          op: f.op,
          movedFrom: f.movedTo ? f.file : null,
          hunks: f.hunks.map((h) => ({ removed: [...h.removed], added: [...h.added] })),
          tsMicros: ts ?? Number.NaN,
        });
      }
      // A rename also leaves the old path changed (deleted).
      for (const f of parsed) {
        if (!f.movedTo) continue;
        const at = locateFile(f.file, { cwd, root });
        if (!at) continue;
        out.push({
          turnId,
          file: at.file,
          rel: at.rel,
          kind: 'patch',
          op: 'move-from',
          hunks: [],
          tsMicros: ts ?? Number.NaN,
        });
      }
    }
    if (sawPatch) continue;

    // Tier B.
    for (const c of commands) {
      for (const p of parseShellWrites(c)) {
        const at = locateFile(p, { cwd, root });
        if (!at) continue;
        out.push({
          turnId,
          file: at.file,
          rel: at.rel,
          kind: 'shell',
          tsMicros: ts ?? Number.NaN,
          command: c,
        });
      }
    }
  }
  return out;
}
