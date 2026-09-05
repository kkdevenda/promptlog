/**
 * Codex spawned threads (DESIGN.md "Subagent usage").
 *
 * A Codex subagent is not a side file: it is a rollout of its own, under
 * ~/.codex/sessions/YYYY/MM/DD/, whose `session_meta.payload.parent_thread_id`
 * names the thread that spawned it. So "the children of this session" is a
 * scan of the rollout tree for that field, transitively (a grandchild names
 * its parent, which names ours).
 *
 * ARE A CHILD'S TOKENS ALREADY IN THE PARENT'S? No - measured, not assumed.
 * A Codex turn's usage is the delta of the parent's cumulative
 * `token_count.total_token_usage`, and over every turn that spawned a child
 * that delta equals the sum of the parent's OWN per-request
 * `last_token_usage` entries in the same window, to the token; across all 75
 * local parents the cumulative total never exceeds that own-request sum.
 * A child's usage therefore appears nowhere in the parent's numbers, and
 * adding it is the only way the total is true. See DESIGN.md for the five
 * measured pairs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord, num, rec, str, tryParse } from '../../core/json';
import type { Session, TokenUsage } from '../../core/model';
import { parseIsoStringToMicros } from '../../core/util';
import type { Child, ChildrenResult } from '../types';

function sessionsRoot(home?: string | null): string {
  return path.join(home || os.homedir(), '.codex', 'sessions');
}

function walkRollouts(dir: string, out: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkRollouts(p, out);
    else if (/^rollout-.*\.jsonl$/.test(ent.name)) out.push(p);
  }
  return out;
}

interface RolloutMeta {
  id: string | null;
  parentId: string | null;
  tsMicros: number | null;
}

/** First line only: a rollout's session_meta, which is all the parent/child
 * index needs. Never loads the whole file. */
function peekMeta(filePath: string): RolloutMeta | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    const line = nl === -1 ? text : text.slice(0, nl);
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.type !== 'session_meta') return null;
    const payload = rec(parsed.payload);
    if (!payload) return null;
    return {
      id: str(payload.id),
      parentId: str(payload.parent_thread_id),
      tsMicros: parseIsoStringToMicros(str(payload.timestamp) ?? str(parsed.timestamp) ?? ''),
    };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** Final cumulative `total_token_usage` of a rollout = that thread's own
 * whole-session usage, mapped onto promptlog's field names. */
function rolloutUsage(filePath: string): TokenUsage {
  const usage: TokenUsage = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return usage;
  }
  let last: Record<string, unknown> | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed?.includes('token_count')) continue;
    const r = rec(tryParse(trimmed));
    const p = r ? rec(r.payload) : null;
    if (!p || r?.type !== 'event_msg' || p.type !== 'token_count') continue;
    const info = rec(p.info);
    const t = info ? rec(info.total_token_usage) : null;
    if (t) last = t;
  }
  if (!last) return usage;
  usage.output = num(last.output_tokens) ?? 0;
  usage.input = num(last.input_tokens) ?? 0;
  usage.cacheRead = num(last.cached_input_tokens) ?? 0;
  usage.cacheWrite = num(last.cache_write_input_tokens) ?? 0;
  usage.thinking = num(last.reasoning_output_tokens) ?? 0;
  return usage;
}

interface RolloutEntry {
  path: string;
  id: string;
  parentId: string;
  tsMicros: number | null;
}

/** parent thread id -> child rollout metas, built once per process per
 * sessions root: `sessions` parses many sessions in a row and every one of
 * them would otherwise re-peek the whole rollout tree. */
const indexCache = new Map<string, Map<string, RolloutEntry[]>>();

function parentIndex(home?: string | null): Map<string, RolloutEntry[]> {
  const root = sessionsRoot(home);
  const cached = indexCache.get(root);
  if (cached) return cached;
  const kidsOf = new Map<string, RolloutEntry[]>();
  for (const f of walkRollouts(root, [])) {
    const m = peekMeta(f);
    if (!m?.id || !m.parentId) continue;
    const entry: RolloutEntry = { path: f, id: m.id, parentId: m.parentId, tsMicros: m.tsMicros };
    const kids = kidsOf.get(m.parentId);
    if (kids) kids.push(entry);
    else kidsOf.set(m.parentId, [entry]);
  }
  indexCache.set(root, kidsOf);
  return kidsOf;
}

/**
 * Every rollout descended from `session`, each exactly once, attributed to the
 * turn whose window contains its start.
 *
 * Linkage is 'time', never 'exact': a Codex parent rarely mentions the child's
 * thread id at all (3 of 30 locally), so the only available link is that the
 * child's `session_meta` timestamp falls inside a turn's [ts, ts+duration]
 * window. A child that starts in no window is left unattributed rather than
 * assigned to the nearest turn.
 */
export function children(session: Session, { home }: { home?: string | null } = {}): ChildrenResult {
  const out: ChildrenResult = { children: [], duplicates: 0 };
  if (!session?.id) return out;

  const kidsOf = parentIndex(home);
  const seenIds = new Set([session.id]);
  const queue = [session.id];
  const descendants: Array<{ entry: RolloutEntry; parentThreadId: string }> = [];
  while (queue.length) {
    const pid = queue.shift();
    if (pid === undefined) break;
    for (const kid of kidsOf.get(pid) ?? []) {
      if (seenIds.has(kid.id)) continue; // a cycle, or two rollouts sharing an id
      seenIds.add(kid.id);
      descendants.push({ entry: kid, parentThreadId: pid });
      queue.push(kid.id);
    }
  }

  // Turn windows are [ts, ts + durationS]: the stretch the turn was actually
  // working, not "everything until the next prompt", and with no open-ended
  // last window. A child that started outside every one of them is genuinely
  // unattributable and stays that way - it still counts in the session's
  // totals, it just does not get credited to a row that cannot be shown to
  // have spawned it.
  const turns = [...session.turns].sort((a, b) => a.tsMicros - b.tsMicros);
  const windows = turns.map((t) => ({
    turn: t,
    start: t.tsMicros,
    end: t.tsMicros + Math.max(0, t.durationS) * 1e6,
  }));

  descendants.sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  for (const d of descendants) {
    const ts = d.entry.tsMicros;
    let turn = null;
    if (ts != null) {
      const w = windows.find((x) => ts >= x.start && ts <= x.end);
      if (w) turn = w.turn;
    }
    const child: Child = {
      path: d.entry.path,
      agentId: d.entry.id,
      parentAgentId: d.parentThreadId === session.id ? null : d.parentThreadId,
      // fullId is the linkage key core matches on; the gid is display-only
      // (a 7-char id prefix, which two turns can share).
      spawnedByTurnId: turn ? turn.fullId : null,
      spawnedByTurnGid: turn ? turn.gid : null,
      linkage: turn ? 'time' : 'none',
      usage: rolloutUsage(d.entry.path),
    };
    out.children.push(child);
  }

  return out;
}
