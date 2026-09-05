/**
 * Fold an adapter's subagent transcripts into a parsed Session
 * (DESIGN.md "Subagent usage").
 *
 * Core never reads a transcript format itself: it asks the adapter for
 * `children(session, {home})` and only does the bookkeeping. Two rules govern
 * that bookkeeping, and the tests in test/subagents.test.ts assert both as
 * equalities rather than trusting the code:
 *
 *   CONSERVATION   sum over turns of (own + subagents) + subagentsUnattributed
 *                  == deduped usage over every transcript of the session.
 *   ONCE           sum of turn.subagents.count + subagentsUnattributed.count
 *                  == the number of subagent transcripts read.
 *
 * A turn's OWN token fields are never touched. Rows show own usage; only
 * headline totals show own + subagents, and they say so.
 */

import { byId } from '../agents/index';
import type { Adapter, Child } from '../agents/types';
import { addSubagentUsage, type Session, type SubagentUsage, type Turn, zeroSubagents } from './model';

/** Turn one adapter child entry into the shape addSubagentUsage() consumes. */
function blockFor(child: Child): Partial<SubagentUsage> {
  const u = child.usage;
  return {
    count: 1,
    output: u.output,
    input: u.input,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    thinking: u.thinking,
    // 'none' describes the linkage failing, not a kind of linkage: a child we
    // could not tie to a turn contributes no linkage label to any bucket.
    linkage: child.linkage !== 'none' ? child.linkage : null,
  };
}

/** Zero every subagent field on the session so attaching starts from a
 * clean slate: the counters below are accumulated, and without this a second
 * call would double them. */
function resetSubagents(session: Session): void {
  for (const t of session.turns) t.subagents = zeroSubagents();
  session.subagentsUnattributed = zeroSubagents();
  session.subagentFiles = 0;
  session.subagentDuplicateIds = 0;
}

/**
 * Populate `session.turns[].subagents`, `session.subagentsUnattributed`,
 * `session.subagentFiles` and `session.subagentDuplicateIds` in place, and
 * return the session. Idempotent: every one of those is reset first, so
 * calling it twice yields exactly what calling it once does.
 *
 * Linkage: a child entry names the top-level turn that spawned it by
 * `spawnedByTurnId`, the Turn's collision-resistant `fullId`. Its
 * `spawnedByTurnGid` is display-only - a gid embeds a 7-char id prefix, and
 * two turns whose uuids share that prefix have the same gid, so matching on
 * it can credit the wrong turn. An adapter that provides only
 * `spawnedByTurnGid` (legacy) is matched by gid ONLY when that gid names one
 * turn in the session; if it is ambiguous, the child is left unattributed
 * rather than guessed.
 *
 * Fails open: an adapter with no `children()`, a missing subagents directory,
 * an unreadable file or a throwing adapter all leave the zero values in place
 * and never raise. A missing number is reported as zero, never guessed.
 */
export function attachSubagents(
  session: Session,
  { home = null, adapter = null }: { home?: string | null; adapter?: Adapter | null } = {},
): Session {
  const a = adapter ?? byId(session.agent);
  if (!a) return session;

  let result: ReturnType<Adapter['children']>;
  try {
    result = a.children(session, { home });
  } catch {
    return session;
  }
  resetSubagents(session);
  const kids = result.children;
  session.subagentDuplicateIds = result.duplicates;
  if (!kids.length) return session;

  const byFullId = new Map<string, Turn>();
  const byGid = new Map<string, Turn | null>(); // null once a second turn claims it
  for (const t of session.turns) {
    byFullId.set(t.fullId, t);
    byGid.set(t.gid, byGid.has(t.gid) ? null : t);
  }

  for (const kid of kids) {
    const block = blockFor(kid);
    let turn: Turn | null = null;
    if (kid.spawnedByTurnId) turn = byFullId.get(kid.spawnedByTurnId) ?? null;
    else if (kid.spawnedByTurnGid) turn = byGid.get(kid.spawnedByTurnGid) ?? null;
    if (turn) addSubagentUsage(turn.subagents, block);
    else addSubagentUsage(session.subagentsUnattributed, block);
    session.subagentFiles += 1;
  }
  return session;
}

export interface UsagePair {
  output: number;
  input: number;
}

export interface TotalsWithSubagents {
  own: UsagePair;
  sub: UsagePair & { count: number };
  total: UsagePair;
  count: number;
}

/** Own + subagent totals for a list of turns, plus the subagent count. The
 * one place the headline arithmetic lives, so `tree`, `status`, `last`,
 * `html`, `mermaid` and `json` cannot disagree about it. `unattributed` is
 * the session-level bucket (pass `session.subagentsUnattributed`); it belongs
 * in the totals because the tokens were spent, even though no row can claim
 * them.
 *
 * "output" here means output + thinking tokens, for own and subagent usage
 * alike - the same definition every row already displays, so a header can
 * never disagree with the sum of its rows. Callers must not add thinking
 * again. "input" means input + cache read + cache write. */
export function totalsWithSubagents(
  turns: readonly Pick<
    Turn,
    'outputTokens' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'thinkingTokens' | 'subagents'
  >[],
  unattributed: SubagentUsage | null = null,
): TotalsWithSubagents {
  const u = unattributed ?? zeroSubagents();
  const own = { output: 0, input: 0 };
  const sub = { output: 0, input: 0, count: 0 };
  for (const t of turns) {
    own.output += t.outputTokens + t.thinkingTokens;
    own.input += t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
    const s = t.subagents;
    sub.output += s.output + s.thinking;
    sub.input += s.input + s.cacheRead + s.cacheWrite;
    sub.count += s.count;
  }
  sub.output += u.output + u.thinking;
  sub.input += u.input + u.cacheRead + u.cacheWrite;
  sub.count += u.count;
  return {
    own,
    sub,
    total: { output: own.output + sub.output, input: own.input + sub.input },
    count: sub.count,
  };
}
