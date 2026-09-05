/** Parser for Claude Code JSONL transcripts (~/.claude/projects/<slug>/<uuid>.jsonl). */

import path from 'node:path';
import { readJsonl } from '../../core/fsutil';
import { arr, bool, num, rec, str } from '../../core/json';
import type { JsonRecord, TokenUsage } from '../../core/model';
import { inc, Session, Turn } from '../../core/model';
import { nowMicros, parseIsoStringToMicros } from '../../core/util';

export const SKIP_PREFIXES = [
  '<local-command-caveat>',
  '<system-reminder>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<local-command-stdout>',
  '<task-notification', // background agent finished (system, not user)
  '[Request interrupted by user]',
];

/** Return the joined text if content is a string, or a list containing only
 * text blocks. Return null otherwise (e.g. contains tool_result). */
function contentTextOnly(content: unknown): string | null {
  const s = str(content);
  if (s !== null) return s;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const b = rec(block);
    if (!b) return null;
    if (b.type === 'text') {
      texts.push(str(b.text) ?? '');
    } else {
      return null;
    }
  }
  return texts.join('\n');
}

const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/** If `r` is a real user prompt, return [promptText, isCommand]. Else null. */
function isPromptRecord(r: JsonRecord): [string, boolean] | null {
  if (r.type !== 'user') return null;
  if (bool(r.isSidechain)) return null;
  if (bool(r.isMeta)) return null;
  const message = rec(r.message);
  if (!message) return null;
  const text = contentTextOnly(message.content);
  if (text === null) return null;
  const stripped = text.trim();
  if (!stripped) return null;
  for (const prefix of SKIP_PREFIXES) {
    if (stripped.startsWith(prefix)) return null;
  }
  if (stripped.startsWith('<command-name>') || stripped.startsWith('<command-message>')) {
    const m = COMMAND_NAME_RE.exec(stripped);
    const name = m ? (m[1] ?? '').trim() : '?';
    const a = COMMAND_ARGS_RE.exec(stripped);
    const args = a ? (a[1] ?? '').trim() : '';
    const prompt = !args ? name : `${name} ${args}`;
    return [prompt, true];
  }
  return [stripped, false];
}

interface Usage {
  inputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  outputTokens: number;
  thinkingTokens: number;
}

function extractUsage(message: JsonRecord): Usage {
  const usage = rec(message.usage) ?? {};
  const details = rec(usage.output_tokens_details) ?? {};
  return {
    inputTokens: num(usage.input_tokens) ?? 0,
    cacheCreation: num(usage.cache_creation_input_tokens) ?? 0,
    cacheRead: num(usage.cache_read_input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
    thinkingTokens: num(details.thinking_tokens) ?? 0,
  };
}

function filesFromToolInput(input: unknown, files: Set<string>): void {
  const i = rec(input);
  if (!i) return;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = str(i[key]);
    if (v) files.add(v);
  }
}

/** Compaction markers: never real turns, never counted as prompts, never
 * attributed to a turn's response. */
function isCompactionRecord(r: JsonRecord): boolean {
  return bool(r.isCompactSummary) || r.type === 'summary';
}

export function parseClaudeSession(filePath: string): Session {
  const records = readJsonl(filePath).filter((r) => !isCompactionRecord(r));
  const byUuid = new Map<string, JsonRecord>();
  for (const r of records) {
    const uid = str(r.uuid);
    if (uid) byUuid.set(uid, r);
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  for (const r of records) {
    const sid = str(r.sessionId);
    if (sid) sessionId = sid;
    const c = str(r.cwd);
    if (c) cwd = c;
    if (sessionId && cwd) break;
  }
  if (!sessionId) {
    const base = path.basename(filePath);
    sessionId = base.endsWith('.jsonl') ? base.slice(0, -6) : base;
  }

  // find nearest ancestor prompt uuid for a given record, walking parentUuid
  // iteratively (never recursively - some sessions have 10k+ deep chains).
  const promptCache = new Map<string, string | null>();

  function nearestPromptUuid(uid: string | null): string | null {
    if (uid == null) return null;
    const chain: string[] = [];
    let cur: string | null = uid;
    let result: string | null = null;
    const seen = new Set<string>();
    while (cur != null) {
      if (promptCache.has(cur)) {
        result = promptCache.get(cur) ?? null;
        break;
      }
      if (seen.has(cur)) {
        result = null;
        break;
      }
      seen.add(cur);
      const r = byUuid.get(cur);
      if (r === undefined) {
        result = null;
        break;
      }
      if (isPromptRecord(r) !== null && !bool(r.isSidechain)) {
        result = cur;
        chain.push(cur);
        break;
      }
      chain.push(cur);
      cur = str(r.parentUuid);
    }
    for (const c of chain) promptCache.set(c, result);
    return result;
  }

  // Collect prompt records in file order (chronological, since jsonl is
  // append-only).
  const promptUuids: string[] = [];
  for (const r of records) {
    if (bool(r.isSidechain)) continue;
    const info = isPromptRecord(r);
    if (info === null) continue;
    const uid = str(r.uuid);
    if (uid == null) continue;
    promptUuids.push(uid);
  }

  const turns = new Map<string, Turn>();
  const turnOrder: string[] = [];
  // tool_use id -> owning turn's fullId. Not part of the shared model (it is
  // Claude-specific and never serialized); it rides on session.meta, which is
  // exactly what that field is for. subagents.ts uses it to tie a subagent
  // transcript to the turn whose `Agent` tool call spawned it, with no second
  // parent walk over the file.
  const toolUseOwners = new Map<string, string>();
  for (const uid of promptUuids) {
    const r = byUuid.get(uid);
    if (!r) continue;
    const info = isPromptRecord(r);
    if (!info) continue;
    const [promptText, isCommand] = info;
    const ts = parseIsoStringToMicros(r.timestamp);
    const tsMicros = ts != null ? ts : nowMicros();
    const parentUuid = str(r.parentUuid);
    const parentPrompt = parentUuid ? nearestPromptUuid(parentUuid) : null;
    const t = new Turn({
      id: uid.slice(0, 7),
      fullId: uid,
      parentId: parentPrompt,
      agent: 'claude',
      sessionId,
      tsMicros,
      prompt: promptText,
      isCommand,
    });
    turns.set(uid, t);
    turnOrder.push(uid);
  }

  const promptUuidSet = new Set(promptUuids);

  // Attribute assistant/tool records to turns.
  const seenMsgIds = new Map<string, Set<string>>(); // turn_uid -> Set of message.id already counted
  const lastTsForTurn = new Map<string, number>();
  // Response capture: the last assistant message (by message.id) seen for
  // each turn, and the text blocks accumulated for it.
  const lastMsgIdForTurn = new Map<string, string>(); // turn_uid -> message.id
  const textBlocksByMsg = new Map<string, string[]>(); // "turn_uid::msgId" -> string[]

  for (const r of records) {
    if (bool(r.isSidechain)) continue;
    const uid = str(r.uuid);
    const rtype = r.type;
    const ts = parseIsoStringToMicros(r.timestamp);

    if (rtype === 'user' && uid != null && promptUuidSet.has(uid)) {
      if (ts != null) {
        lastTsForTurn.set(uid, Math.max(lastTsForTurn.get(uid) ?? ts, ts));
      }
      continue;
    }

    if (rtype !== 'user' && rtype !== 'assistant') continue;

    const owner = nearestPromptUuid(uid);
    if (owner == null || !turns.has(owner)) continue;
    const t = turns.get(owner);
    if (!t) continue;
    if (ts != null) {
      lastTsForTurn.set(owner, Math.max(lastTsForTurn.get(owner) ?? ts, ts));
    }

    const message = rec(r.message);
    if (!message) continue;

    if (rtype === 'assistant') {
      const model = str(message.model);
      if (model) t.models.add(model);
      const msgId = str(message.id);
      if (!seenMsgIds.has(owner)) seenMsgIds.set(owner, new Set());
      const seen = seenMsgIds.get(owner);
      if (msgId && seen && !seen.has(msgId)) {
        seen.add(msgId);
        const u = extractUsage(message);
        t.inputTokens += u.inputTokens;
        t.cacheReadTokens += u.cacheRead;
        t.cacheWriteTokens += u.cacheCreation;
        t.outputTokens += u.outputTokens;
        t.thinkingTokens += u.thinkingTokens;
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = rec(block);
          if (!b) continue;
          if (b.type === 'tool_use') {
            t.toolCalls += 1;
            const name = str(b.name) ?? '?';
            inc(t.toolNames, name);
            filesFromToolInput(b.input, t.files);
            const toolUseId = str(b.id);
            if (toolUseId) toolUseOwners.set(toolUseId, owner);
          }
        }
      }

      if (msgId) {
        lastMsgIdForTurn.set(owner, msgId);
        const key = `${owner}::${msgId}`;
        if (!textBlocksByMsg.has(key)) textBlocksByMsg.set(key, []);
        const bucket = textBlocksByMsg.get(key);
        if (bucket && Array.isArray(content)) {
          for (const block of content) {
            const b = rec(block);
            if (!b) continue;
            if (b.type === 'text') bucket.push(str(b.text) ?? '');
          }
        }
      }
    }
  }

  // Finalize response/responsePending from the last assistant message seen
  // per turn.
  for (const [uid, t] of turns.entries()) {
    const lastMsgId = lastMsgIdForTurn.get(uid);
    let text: string | null = null;
    if (lastMsgId) {
      const texts = textBlocksByMsg.get(`${uid}::${lastMsgId}`) ?? [];
      if (texts.length) text = texts.join('\n');
    }
    t.response = text;
    t.responsePending = text === null;
  }

  for (const [uid, t] of turns.entries()) {
    const end = lastTsForTurn.get(uid) ?? t.tsMicros;
    t.durationS = Math.max(0.0, (end - t.tsMicros) / 1000000);
  }

  const orderedTurns = turnOrder.map((u) => turns.get(u)).filter((t): t is Turn => t !== undefined);
  orderedTurns.sort((a, b) => a.tsMicros - b.tsMicros);

  const roots = orderedTurns.filter((t) => t.parentId == null).map((t) => t.fullId);
  for (const t of orderedTurns) {
    if (t.parentId && turns.has(t.parentId)) {
      turns.get(t.parentId)?.children.push(t.fullId);
    }
  }

  const started = orderedTurns.length ? (orderedTurns[0]?.tsMicros ?? null) : null;
  return new Session({
    id: sessionId,
    agent: 'claude',
    path: filePath,
    cwd: cwd || process.cwd(),
    startedMicros: started,
    turns: orderedTurns,
    roots,
    meta: { toolUseOwners },
  });
}

const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/g;
const TASK_AGENT_ID_RE = /<task-id>\s*([A-Za-z0-9_-]+)\s*<\/task-id>/g;
const TOOL_USE_ID_RE = /<tool-use-id>\s*([A-Za-z0-9_-]+)\s*<\/tool-use-id>/;

/** Every capture group 1 of a global regex's matches against `text`. */
function matchAllGroup1(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Every string of text nested anywhere in a message content block, so a
 * `tool_result` payload is searched whether the host wrote it as a string or
 * as a list of text blocks. */
function textOfContent(content: unknown, out: string[]): void {
  const s = str(content);
  if (s !== null) {
    out.push(s);
    return;
  }
  if (Array.isArray(content)) {
    for (const b of content) textOfContent(b, out);
    return;
  }
  const c = rec(content);
  if (c) {
    const t = str(c.text);
    if (t !== null) out.push(t);
    if (c.content !== undefined) textOfContent(c.content, out);
  }
}

export interface TranscriptScan {
  usage: TokenUsage;
  toolUseIds: Set<string>;
  agentLinks: Map<string, string>;
  agentIds: Set<string>;
  duplicates: number;
}

export interface TranscriptUsageOptions {
  seen?: Set<string> | null;
  skipSidechain?: boolean;
}

/**
 * Deduped token usage over ONE Claude transcript file - the main one or a
 * subagent's - using exactly the rules parseClaudeSession uses: compaction
 * markers dropped, `extractUsage` per assistant message, at most one count
 * per `message.id`.
 *
 * `seen` is a Set of message ids already counted elsewhere in this session.
 * An id already in it is skipped and reported in `duplicates`: subagent
 * transcripts are separate files, so nothing should repeat across them, and
 * this is the safety net that makes double counting impossible rather than
 * merely unlikely.
 *
 * `skipSidechain` makes the scan drop `isSidechain` records, exactly as
 * parseClaudeSession does for the main chain. It exists for ONE caller: the
 * seed scan of the main file in subagents.ts. Claude Code sometimes writes a
 * subagent's messages into the main transcript too, flagged `isSidechain`,
 * and the parser never counts those in any turn. If the seed scan counted
 * them, their message ids would enter `seen` and the SAME messages in the
 * child's own file would then be marked duplicates - dropped from the child,
 * yet never present in any turn, so the session total would come out short.
 * The seed must therefore use the parser's inclusion rule. A child's own
 * file is scanned WITHOUT this flag: every record in it is a sidechain
 * record, and those are precisely the tokens being added.
 *
 * Also returns what links this transcript to the rest of the session:
 * `toolUseIds` (every tool_use id issued *inside* this file - a nested
 * subagent's spawning call is one of these) and `agentLinks`
 * (agentId -> tool_use id, read off the `Agent` tool_result text and the
 * background-agent task notifications).
 */
export function transcriptUsage(
  filePath: string,
  { seen = null, skipSidechain = false }: TranscriptUsageOptions = {},
): TranscriptScan {
  const usage: TokenUsage = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const perFile = new Set<string>();
  const toolUseIds = new Set<string>();
  const agentLinks = new Map<string, string>();
  const agentIds = new Set<string>();
  let duplicates = 0;

  /** `<task-id>agentId</task-id>` + `<tool-use-id>toolu_...</tool-use-id>` in one
   * blob of text: how a BACKGROUND agent's spawning call is recorded. These
   * arrive as `queue-operation` records whose payload is a top-level `content`
   * string, not a `message`, so they are scanned separately from the
   * conversation. */
  function scanNotification(text: string | null | undefined): void {
    if (!text || text.indexOf('<tool-use-id>') === -1) return;
    const tu = TOOL_USE_ID_RE.exec(text);
    if (!tu?.[1]) return;
    const toolUseId = tu[1];
    for (const id of matchAllGroup1(TASK_AGENT_ID_RE, text)) agentLinks.set(id, toolUseId);
    for (const id of matchAllGroup1(AGENT_ID_RE, text)) agentLinks.set(id, toolUseId);
  }

  for (const r of readJsonl(filePath)) {
    if (isCompactionRecord(r)) continue;
    if (skipSidechain && bool(r.isSidechain)) continue;
    const agentId = str(r.agentId);
    if (agentId) agentIds.add(agentId);
    const topContent = str(r.content);
    if (topContent !== null) scanNotification(topContent);
    const message = rec(r.message);
    if (!message) continue;

    if (r.type === 'assistant') {
      const msgId = str(message.id);
      if (msgId) {
        if (perFile.has(msgId)) {
          // already counted in this same file (a streamed message written
          // twice); parseClaudeSession skips it too.
        } else {
          perFile.add(msgId);
          if (seen?.has(msgId)) {
            duplicates += 1;
          } else {
            seen?.add(msgId);
            const u = extractUsage(message);
            usage.output += u.outputTokens;
            usage.input += u.inputTokens;
            usage.cacheRead += u.cacheRead;
            usage.cacheWrite += u.cacheCreation;
            usage.thinking += u.thinkingTokens;
          }
        }
      }
      for (const block of arr(message.content)) {
        const b = rec(block);
        if (b && b.type === 'tool_use') {
          const id = str(b.id);
          if (id) toolUseIds.add(id);
        }
      }
      continue;
    }

    if (r.type !== 'user') continue;
    // A tool_result for an `Agent` call names the agent it spawned, in its
    // own text, and the block carries the tool_use id it is answering: that
    // pair is the exact link between a subagent transcript and the turn whose
    // call created it.
    const contentStr = str(message.content);
    if (contentStr !== null) {
      scanNotification(contentStr);
      continue;
    }
    for (const block of arr(message.content)) {
      const b = rec(block);
      if (!b) continue;
      const texts: string[] = [];
      if (b.type === 'tool_result') {
        textOfContent(b.content, texts);
        const joined = texts.join('\n');
        const toolUseId = str(b.tool_use_id);
        if (toolUseId) {
          for (const id of matchAllGroup1(AGENT_ID_RE, joined)) agentLinks.set(id, toolUseId);
        }
        scanNotification(joined);
        continue;
      }
      textOfContent(block, texts);
      scanNotification(texts.join('\n'));
    }
  }

  return { usage, toolUseIds, agentLinks, agentIds, duplicates };
}
