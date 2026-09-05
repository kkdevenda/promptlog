/** Parser for Codex CLI rollout JSONL transcripts
 * (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */

import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonl } from '../../core/fsutil';
import { arr, num, rec, str } from '../../core/json';
import { inc, type JsonRecord, Session, Turn } from '../../core/model';
import { nowMicros, parseIsoStringToMicros } from '../../core/util';

const SKIP_PREFIXES = [
  '<environment_context>',
  '<recommended',
  '<skills',
  '<user_instructions>',
  '<permissions',
  '<turn_aborted>',
];

function parseTs(ts: unknown): number | null {
  // Python: `if not ts: return None` — None/0/0.0/'' are all falsy.
  if (ts == null || ts === '' || ts === 0) return null;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return null;
    return Math.round(ts * 1000000);
  }
  if (typeof ts === 'string') return parseIsoStringToMicros(ts);
  return null;
}

/** Is `stripped` a skill invocation rather than a real prompt? Two shapes
 * observed/expected: an XML-ish `<skill ...>` tag (any attributes; e.g. a
 * host that renders a skill call as markup), or a message that is just a
 * `$name` mention on its own line, optionally with args after it on that
 * same line (e.g. `$promptlog tree -n 5`) - the way Codex's own `$name`
 * skill trigger looks in a transcript. Returns the short name to show as
 * the prompt (`<skill>` or `<skill>name`, or `$name`), or null when
 * `stripped` isn't one of these. */
export function skillCommandName(stripped: string): string | null {
  const tagMatch = /^<skill\b([^>]*)>/i.exec(stripped);
  if (tagMatch) {
    const attrs = tagMatch[1] || '';
    const nameAttr = /\bname\s*=\s*"([^"]+)"/i.exec(attrs) || /\bname\s*=\s*'([^']+)'/i.exec(attrs);
    if (nameAttr) return `$${nameAttr[1]}`;
    // Codex desktop expands a skill as `<skill>\n<name>promptlog</name>\n<path>…`.
    const nameTag = /<name>\s*([^<\n]+?)\s*<\/name>/i.exec(stripped);
    if (nameTag) return `$${nameTag[1]}`;
    const inner = /^\s*([^<\n]+)/.exec(stripped.slice(tagMatch[0].length))?.[1]?.trim();
    if (inner) return `<skill>${inner}`;
    return '<skill>';
  }
  // Codex desktop writes a skill mention as a Markdown link: `[$name](/path/SKILL.md)&#x20;`.
  const linkMatch = /^\[\$([A-Za-z0-9_-]+)\]\([^)]*\)(?:\s|&#x20;)*$/.exec(stripped);
  if (linkMatch) return `$${linkMatch[1]}`;
  // A single line consisting only of "$name" plus optional trailing args.
  if (!/\r|\n/.test(stripped)) {
    const dollarMatch = /^\$([A-Za-z0-9_-]+)(?:\s+.*)?$/.exec(stripped);
    if (dollarMatch) return `$${dollarMatch[1]}`;
  }
  return null;
}

function extractPromptText(message: unknown): string | null {
  return typeof message === 'string' ? message : null;
}

function filesFromArgs(args: unknown, files: Set<string>): void {
  if (args == null) return;
  let data: unknown = args;
  if (typeof args === 'string') {
    try {
      data = JSON.parse(args);
    } catch {
      return;
    }
  }
  const obj = rec(data);
  if (!obj) return;
  for (const key of ['path', 'file_path']) {
    const v = str(obj[key]);
    if (v) files.add(v);
  }
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

function zeroUsage(): CodexUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

/** `v` normalised to a `CodexUsage`, defaulting every missing field to 0; or
 * `null` when `v` isn't an object at all. */
function readUsage(v: unknown): CodexUsage | null {
  const r = rec(v);
  if (!r) return null;
  return {
    input_tokens: num(r.input_tokens) ?? 0,
    cached_input_tokens: num(r.cached_input_tokens) ?? 0,
    cache_write_input_tokens: num(r.cache_write_input_tokens) ?? 0,
    output_tokens: num(r.output_tokens) ?? 0,
    reasoning_output_tokens: num(r.reasoning_output_tokens) ?? 0,
  };
}

export function parseCodexSession(filePath: string): Session {
  const records = readJsonl(filePath);

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let started: number | null = null;
  let originator: string | null = null;
  for (const r of records) {
    if (r.type === 'session_meta') {
      const payload = rec(r.payload) ?? {};
      sessionId = str(payload.id) ?? sessionId;
      cwd = str(payload.cwd) ?? cwd;
      const ts = parseTs(payload.timestamp);
      started = ts ?? started;
      originator = str(payload.originator);
      break;
    }
  }
  sessionId ??= path.basename(filePath);

  const turns: Turn[] = [];
  const turnByFullId = new Map<string, Turn>();
  let prevTurnId: string | null = null;

  // Boxed (not a plain `let`) so TS re-checks its narrowed type after each
  // closeTurn()/openTurn() call instead of assuming it is still whatever it
  // was at the last assignment textually visible in this scope.
  const state: { turn: Turn | null } = { turn: null };
  let currentBaseline = zeroUsage();
  let currentLastTotal: CodexUsage | null = null;
  let currentFallbackSum = zeroUsage();
  let haveDelta = false;
  // Response capture: last event_msg/agent_message text for the current
  // turn, else the last response_item assistant message's output_text.
  let currentAgentMessage: string | null = null;
  let currentAssistantItemText: string | null = null;

  let lastSeenTotal: CodexUsage | null = null; // last cumulative total_token_usage overall

  function closeTurn(endTsMicros: number | null, durationS: number | null): void {
    if (state.turn === null) return;
    let dIn: number, dCached: number, dCwrite: number, dOut: number, dReason: number;
    if (haveDelta && currentLastTotal !== null) {
      const base = currentBaseline;
      const last = currentLastTotal;
      dIn = Math.max(0, last.input_tokens - base.input_tokens);
      dCached = Math.max(0, last.cached_input_tokens - base.cached_input_tokens);
      dCwrite = Math.max(0, last.cache_write_input_tokens - base.cache_write_input_tokens);
      dOut = Math.max(0, last.output_tokens - base.output_tokens);
      dReason = Math.max(0, last.reasoning_output_tokens - base.reasoning_output_tokens);
    } else {
      dIn = currentFallbackSum.input_tokens;
      dCached = currentFallbackSum.cached_input_tokens;
      dCwrite = currentFallbackSum.cache_write_input_tokens;
      dOut = currentFallbackSum.output_tokens;
      dReason = currentFallbackSum.reasoning_output_tokens;
    }

    state.turn.inputTokens = dIn;
    state.turn.cacheReadTokens = dCached;
    state.turn.cacheWriteTokens = dCwrite;
    state.turn.outputTokens = dOut;
    state.turn.thinkingTokens = dReason;

    if (durationS != null) {
      state.turn.durationS = Math.max(0.0, durationS);
    } else if (endTsMicros != null && state.turn.tsMicros != null) {
      state.turn.durationS = Math.max(0.0, (endTsMicros - state.turn.tsMicros) / 1000000);
    }

    const respText = currentAgentMessage ?? currentAssistantItemText;
    state.turn.response = respText?.trim() ? respText : null;
    state.turn.responsePending = state.turn.response === null;

    state.turn = null;
  }

  // The Codex TUI emits an event_msg/user_message per prompt. The desktop app
  // does not: its prompts only appear as response_item messages with role
  // "user", so fall back to those when no user_message events exist at all.
  const hasUserMessageEvents = records.some(
    (r) => r.type === 'event_msg' && rec(r.payload)?.type === 'user_message',
  );

  function openTurn(text: string | null, ts: number | null): void {
    if (text === null) return;
    const stripped = text.trim();
    if (!stripped) return;
    if (SKIP_PREFIXES.some((p) => stripped.startsWith(p))) return;
    if (state.turn !== null) closeTurn(ts, null);
    currentAgentMessage = null;
    currentAssistantItemText = null;
    const uid = `${sessionId}-${turns.length}`;
    const skillName = skillCommandName(stripped);
    const t = new Turn({
      // git-style short id: stable hash of the full id, unique per turn
      id: crypto.createHash('sha1').update(uid).digest('hex').slice(0, 7),
      fullId: uid,
      parentId: prevTurnId,
      agent: 'codex',
      sessionId,
      tsMicros: ts ?? nowMicros(),
      prompt: skillName ?? stripped,
      isCommand: skillName != null,
    });
    turns.push(t);
    turnByFullId.set(uid, t);
    prevTurnId = uid;
    state.turn = t;
  }

  for (const r of records) {
    const rtype = r.type;
    const payload = rec(r.payload) ?? {};
    const ts = parseTs(r.timestamp);

    if (rtype === 'turn_context') {
      const model = str(payload.model);
      if (model && state.turn !== null) state.turn.models.add(model);
      continue;
    }

    if (rtype === 'event_msg') {
      const etype = payload.type;

      if (etype === 'task_started') {
        currentBaseline = lastSeenTotal ? { ...lastSeenTotal } : zeroUsage();
        currentLastTotal = null;
        currentFallbackSum = zeroUsage();
        haveDelta = false;
        continue;
      }

      if (etype === 'user_message') {
        openTurn(extractPromptText(payload.message), ts);
        continue;
      }

      if (etype === 'token_count') {
        const info = rec(payload.info) ?? {};
        const total = readUsage(info.total_token_usage);
        const last = readUsage(info.last_token_usage);
        if (total) {
          lastSeenTotal = total;
          if (state.turn !== null) {
            currentLastTotal = total;
            haveDelta = true;
          }
        }
        if (last && state.turn !== null) {
          currentFallbackSum.input_tokens += last.input_tokens;
          currentFallbackSum.cached_input_tokens += last.cached_input_tokens;
          currentFallbackSum.cache_write_input_tokens += last.cache_write_input_tokens;
          currentFallbackSum.output_tokens += last.output_tokens;
          currentFallbackSum.reasoning_output_tokens += last.reasoning_output_tokens;
        }
        continue;
      }

      if (etype === 'agent_message') {
        if (state.turn !== null && typeof payload.message === 'string') {
          currentAgentMessage = payload.message;
        }
        continue;
      }

      if (etype === 'task_complete') {
        let durationS: number | null = null;
        const startedAt = num(payload.started_at);
        const completedAt = num(payload.completed_at);
        if (startedAt != null && completedAt != null) {
          durationS = completedAt - startedAt;
        } else {
          const durationMs = num(payload.duration_ms);
          if (durationMs != null) durationS = durationMs / 1000.0;
        }
        closeTurn(ts, durationS);
        continue;
      }

      // other event_msg subtypes ignored
      continue;
    }

    if (rtype === 'response_item') {
      const ritype = payload.type;
      if (ritype === 'message' && payload.role === 'user' && !hasUserMessageEvents) {
        const parts = arr(payload.content);
        const text = parts
          .map((c) => rec(c))
          .filter((c): c is JsonRecord => c != null && (c.type === 'input_text' || c.type === 'text'))
          .map((c) => str(c.text) ?? '')
          .join('\n');
        openTurn(text, ts);
        continue;
      }
      if (state.turn === null) continue;
      if (ritype === 'function_call' || ritype === 'custom_tool_call') {
        state.turn.toolCalls += 1;
        const name = str(payload.name) ?? '?';
        inc(state.turn.toolNames, name);
        const args = payload.arguments !== undefined ? payload.arguments : payload.input;
        filesFromArgs(args, state.turn.files);
      } else if (ritype === 'message' && payload.role === 'assistant') {
        const parts = arr(payload.content);
        currentAssistantItemText = parts
          .map((c) => rec(c))
          .filter((c): c is JsonRecord => c != null && c.type === 'output_text')
          .map((c) => str(c.text) ?? '')
          .join('\n');
      }
    }

    // unknown top-level record type: skip
  }

  if (state.turn !== null) {
    closeTurn(turns.length ? (turns[turns.length - 1]?.tsMicros ?? null) : null, null);
  }

  const roots = turns.filter((t) => t.parentId == null).map((t) => t.fullId);
  for (const t of turns) {
    if (t.parentId && turnByFullId.has(t.parentId)) {
      turnByFullId.get(t.parentId)?.children.push(t.fullId);
    }
  }

  const startedMicros = turns.length ? (turns[0]?.tsMicros ?? null) : started;
  return new Session({
    id: sessionId,
    agent: 'codex',
    path: filePath,
    cwd: cwd || process.cwd(),
    startedMicros,
    turns,
    roots,
    meta: { originator },
  });
}
