/** Parser for Cursor agent transcripts
 * (~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl). */

import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonl } from '../../core/fsutil';
import { isRecord, str } from '../../core/json';
import { inc, type JsonRecord, Session, Turn } from '../../core/model';
import { nowMicros, parseIsoStringToMicros } from '../../core/util';
import { cachedCwdFor, homeFromTranscriptPath, resolveCwdForSlug } from './locate';
import { readBubbles } from './sidecar';

/** A Cursor turn's timestamp is approximate (parsed from embedded prompt
 * text) until the SQLite sidecar supplies a real one. Not part of the
 * shared `Turn` model (core never reads it); tracked here as a side
 * property for diagnostics only. */
export type CursorTurn = Turn & { tsApprox: boolean };

/** Resolve a transcript's cwd for the Session model, without ever
 * reversing its slug (lossy: a real dash in a directory name is
 * indistinguishable from a path separator once joined, so
 * "/a/b-c" and "/a-b/c" share a slug). In order:
 *  1. A cache entry left by locate()/newestForCwd()/findSession(), which
 *     built this transcript's slug dir from a real, known cwd — the exact
 *     answer, not a guess.
 *  2. Cursor's own workspaceStorage/<hash>/workspace.json records, each
 *     naming one real folder Cursor opened; whichever slugs back to this
 *     transcript's slug is the answer.
 *  3. The raw slug string itself, unchanged — deliberately not shaped like
 *     a path (no leading '/'), so callers can tell it's a fallback label
 *     rather than a location. */
export function cwdFromTranscriptPath(filePath: string): string {
  const cached = cachedCwdFor(filePath);
  if (cached) return cached;

  const slugName = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
  if (!slugName) return process.cwd();

  const home = homeFromTranscriptPath(filePath);
  const viaWorkspace = resolveCwdForSlug(slugName, home);
  if (viaWorkspace) return viaWorkspace;

  return slugName;
}

const TIMESTAMP_RE = /^<timestamp>([\s\S]*?)<\/timestamp>\n?/;
const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Parse Cursor's embedded prompt timestamp text, e.g.
 * "Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)", into epoch microseconds, or
 * null if it doesn't match. This is the only timestamp source when the
 * SQLite sidecar (sidecar.ts) has no matching bubble. */
const CURSOR_TS_RE =
  /^\w+, (\w{3})\w* (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC([+-])(\d{1,2}):(\d{2})\)$/;

export function parseCursorTimestampText(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = CURSOR_TS_RE.exec(text.trim());
  if (!m) return null;
  const [, monAbbr, day, year, hour12Str, minStr, ampm, offSign, offH, offM] = m;
  if (!monAbbr || !day || !year || !hour12Str || !minStr || !ampm || !offSign || !offH || !offM) return null;
  const mon = MONTHS[monAbbr.toLowerCase()];
  if (mon === undefined) return null;
  let hour = parseInt(hour12Str, 10) % 12;
  if (ampm.toUpperCase() === 'PM') hour += 12;
  const epochMs = Date.UTC(parseInt(year, 10), mon, parseInt(day, 10), hour, parseInt(minStr, 10), 0);
  if (Number.isNaN(epochMs)) return null;
  let micros = epochMs * 1000;
  const sign = offSign === '-' ? -1 : 1;
  const offsetMinutes = sign * (parseInt(offH, 10) * 60 + parseInt(offM, 10));
  micros -= offsetMinutes * 60 * 1000000;
  return micros;
}

/** Return the joined text if content is a list of text-only blocks, or null
 * (record isn't plain text — e.g. carries a tool_use block, which real user
 * records never do on this machine but the format allows for). */
function contentTextOnly(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!isRecord(block)) return null;
      if (str(block.type) !== 'text') return null;
      texts.push(str(block.text) ?? '');
    }
    return texts.join('\n');
  }
  return null;
}

/** If rec is a real user prompt, return the prompt text. Else null.
 *
 * A prompt is a user record whose text, after stripping a leading
 * `<timestamp>…</timestamp>` block, contains a `<user_query>…</user_query>`
 * section (the query text is what's inside), or — if there is no such tag
 * at all — the whole remaining text, provided it isn't empty. On this
 * machine every real user record found (across ~30 transcripts) carries a
 * `<user_query>` tag, sometimes preceded by attachment markers like
 * `[Image]\n<image_files>…</image_files>` before the `<timestamp>` block;
 * those are kept (the query text itself is unaffected since we search for
 * `<user_query>` anywhere, not only at the very start). No genuinely
 * context-only user record (no `<user_query>`, nothing but attachment/tool
 * metadata) was found to test against; the empty-after-strip fallback below
 * is what would skip one if it appeared. */
export function isPromptRecord(rec: JsonRecord): string | null {
  if (str(rec.role) !== 'user') return null;
  const message = rec.message;
  if (!isRecord(message)) return null;
  const text = contentTextOnly(message.content);
  if (text === null) return null;

  const uq = USER_QUERY_RE.exec(text);
  if (uq?.[1] !== undefined) {
    const inner = uq[1].trim();
    return inner ? inner : null;
  }

  const stripped = text.replace(TIMESTAMP_RE, '').trim();
  return stripped ? stripped : null;
}

/** Extract the raw `<timestamp>…</timestamp>` text (if present at the front
 * of the record, after any attachment preamble) for approximate dating. */
function extractTimestampText(rec: JsonRecord): string | null {
  const message = rec.message;
  if (!isRecord(message)) return null;
  const text = contentTextOnly(message.content);
  if (text === null) return null;
  const m = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(text);
  return m?.[1] ?? null;
}

const READ_FILE_TOOLS = new Set(['ReadFile', 'Read']);
const APPLY_PATCH_FILE_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const APPLY_PATCH_MOVE_RE = /^\*\*\* Move to: (.+)$/gm;

/** Pull file paths out of a tool_use block's input, per PLAN-v0.3.md §4:
 * ReadFile/Read give an object `{path, ...}`; ApplyPatch gives a raw V4A
 * patch string with `*** Update/Add/Delete File: <path>` (and, for renames,
 * `*** Move to: <path>`) headers. */
function filesFromToolUse(name: string, input: unknown, files: Set<string>): void {
  if (READ_FILE_TOOLS.has(name)) {
    if (isRecord(input)) {
      const p = str(input.path);
      if (p) files.add(p);
    }
    return;
  }
  if (name === 'ApplyPatch' && typeof input === 'string') {
    for (const m of input.matchAll(APPLY_PATCH_FILE_HEADER_RE)) {
      files.add(m[1]?.trim() ?? '');
    }
    for (const m of input.matchAll(APPLY_PATCH_MOVE_RE)) {
      files.add(m[1]?.trim() ?? '');
    }
  }
}

/** A transcript's session id is its own filename: `<uuid>/<uuid>.jsonl`. */
function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base;
}

/**
 * SQLite sidecar alignment: bubbles are ordered by createdAt; type 1 is a
 * user bubble, type 2 an assistant bubble (verified against real data).
 * Align bubbles to turns by order of user bubbles: the Nth turn gets the
 * Nth type-1 bubble's createdAt as its real timestamp, and the sum of
 * tokenCount across that bubble through (excluding) the next type-1 bubble
 * as its tokens.
 */
function applySidecar(turns: CursorTurn[], sessionId: string): void {
  let rows: ReturnType<typeof readBubbles>;
  try {
    rows = readBubbles(sessionId);
  } catch {
    rows = null;
  }
  if (!rows?.length) return;

  const withTs = rows
    .map((r) => ({ type: r.type, createdAt: str(r.createdAt), tokenCount: r.tokenCount }))
    .filter((r): r is { type: unknown; createdAt: string; tokenCount: unknown } => r.createdAt !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const userBubbleIdxs: number[] = [];
  for (let i = 0; i < withTs.length; i++) {
    if (withTs[i]?.type === 1) userBubbleIdxs.push(i);
  }

  for (let n = 0; n < turns.length && n < userBubbleIdxs.length; n++) {
    const start = userBubbleIdxs[n];
    if (start === undefined) continue;
    const nextIdx = userBubbleIdxs[n + 1];
    const end = nextIdx !== undefined ? nextIdx : withTs.length;
    const userBubble = withTs[start];
    const turn = turns[n];
    if (!userBubble || !turn) continue;

    const realTs = parseIsoStringToMicros(userBubble.createdAt);
    if (realTs != null) {
      turn.tsMicros = realTs;
      turn.tsApprox = false;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let lastTs = realTs;
    for (let i = start; i < end; i++) {
      const row = withTs[i];
      if (!row) continue;
      const tc = isRecord(row.tokenCount) ? row.tokenCount : null;
      if (tc) {
        inputTokens += typeof tc.inputTokens === 'number' ? tc.inputTokens : 0;
        outputTokens += typeof tc.outputTokens === 'number' ? tc.outputTokens : 0;
      }
      const t = parseIsoStringToMicros(row.createdAt);
      if (t != null) lastTs = t;
    }
    if (inputTokens || outputTokens) {
      turn.inputTokens = inputTokens;
      turn.outputTokens = outputTokens;
    }
    if (realTs != null && lastTs != null) {
      turn.durationS = Math.max(0, (lastTs - realTs) / 1000000);
    }
  }
}

export function parseCursorSession(filePath: string): Session {
  const records = readJsonl(filePath);
  const sessionId = sessionIdFromPath(filePath);
  const cwd = cwdFromTranscriptPath(filePath);

  const turns: CursorTurn[] = [];
  let prevTurnId: string | null = null;
  let currentTurn: CursorTurn | null = null;
  let currentLastResponseText: string | null = null;

  function closeTurn(): void {
    if (currentTurn === null) return;
    currentTurn.response = currentLastResponseText;
    currentTurn.responsePending = currentLastResponseText === null;
    currentTurn = null;
    currentLastResponseText = null;
  }

  for (const rec of records) {
    if (str(rec.type) === 'turn_ended') continue;

    if (str(rec.role) === 'user') {
      const promptText = isPromptRecord(rec);
      if (promptText === null) continue; // context/attachment-only, not a prompt
      closeTurn();

      const uid = `${sessionId}-${turns.length}`;
      const tsText = extractTimestampText(rec);
      const tsMicros = parseCursorTimestampText(tsText);
      // tsApprox is a side property, not part of the shared model: cleared
      // by applySidecar() below when a real sidecar timestamp replaces it.
      const t: CursorTurn = Object.assign(
        new Turn({
          id: crypto.createHash('sha1').update(uid).digest('hex').slice(0, 7),
          fullId: uid,
          parentId: prevTurnId,
          agent: 'cursor',
          sessionId,
          tsMicros: tsMicros != null ? tsMicros : nowMicros(),
          prompt: promptText,
          isCommand: false,
        }),
        { tsApprox: tsMicros != null },
      );
      turns.push(t);
      prevTurnId = uid;
      currentTurn = t;
      continue;
    }

    if (str(rec.role) !== 'assistant' || currentTurn === null) continue;
    const message = rec.message;
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = str(block.text);
        if (text) currentLastResponseText = text;
      } else if (block.type === 'tool_use') {
        currentTurn.toolCalls += 1;
        const name = str(block.name) ?? '?';
        inc(currentTurn.toolNames, name);
        filesFromToolUse(name, block.input, currentTurn.files);
      }
    }
  }
  closeTurn();

  applySidecar(turns, sessionId);

  const roots = turns.length ? [turns[0]?.fullId ?? ''] : [];
  const started = turns.length ? (turns[0]?.tsMicros ?? null) : null;

  return new Session({
    id: sessionId,
    agent: 'cursor',
    path: filePath,
    cwd,
    startedMicros: started,
    turns,
    roots,
  });
}
