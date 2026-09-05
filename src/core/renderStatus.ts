/**
 * A single condensed status line for a session, meant to be spliced into a
 * host's own status line (see `promptlog status` / `promptlog statusline`
 * and README.md "Status line"). Host-neutral: nothing here knows about any
 * particular agent's transcript format.
 */

import type { Session } from './model';
import { totalsWithSubagents } from './subagents';
import { Colors, firstLine, humanizeDuration, humanizeNumber } from './util';

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

export interface StatusStats {
  prompts: number;
  commands: number;
  activeS: number;
  spanS: number;
  out: number;
  in: number;
  tools: number;
  lastPrompt: string | null;
  ownOut: number;
  ownIn: number;
  subagents: number;
  subagentOut: number;
  subagentIn: number;
}

/** Aggregate stats over every turn of the session, shared by the plain-text
 * line and the --json shape. */
export function statusStats(session: Session): StatusStats {
  const turns = session.turns;
  const prompts = turns.length;
  const commands = turns.filter((t) => t.isCommand).length;
  const activeS = turns.reduce((s, t) => s + t.durationS, 0);
  let spanS = 0;
  if (turns.length) {
    const minTs = Math.min(...turns.map((t) => t.tsMicros));
    const maxTs = Math.max(...turns.map((t) => t.tsMicros));
    spanS = (maxTs - minTs) / 1e6;
  }
  // `out`/`in` are the TRUE totals - own plus every subagent this session
  // spawned - because a status line has room for one number and a number
  // that silently omits work that was really done is the wrong one. The
  // split is kept alongside so nothing has to be inferred: ownOut/ownIn and
  // subagentOut/subagentIn/subagents. Every "out" field (out, ownOut,
  // subagentOut) means output + thinking tokens - the definition
  // totalsWithSubagents() applies and every renderer's rows display - so
  // nothing here adds thinking on top.
  const t = totalsWithSubagents(turns, session.subagentsUnattributed);
  const out = t.total.output;
  const inTok = t.total.input;
  const tools = turns.reduce((s, x) => s + x.toolCalls, 0);

  let lastPrompt: string | null = null;
  if (turns.length) {
    const newest = turns.slice().sort((a, b) => b.tsMicros - a.tsMicros)[0];
    lastPrompt = newest ? truncate(firstLine(newest.prompt), 60) : null;
  }

  return {
    prompts,
    commands,
    activeS,
    spanS,
    out,
    in: inTok,
    tools,
    lastPrompt,
    ownOut: t.own.output,
    ownIn: t.own.input,
    subagents: t.count,
    subagentOut: t.sub.output,
    subagentIn: t.sub.input,
  };
}

/** One line, no trailing newline: `🌳 33 prompts · active 4h59m ·
 * ↑194.5k ↓53.4M · 🔧170`, with ` · +N agents` appended when the session
 * spawned subagents (whose usage is already inside those ↑/↓ totals; ↑ is
 * output + thinking).
 * `colors` is a Colors instance (see core/util.ts); omit or pass a disabled
 * one for plain output (`--no-color`). */
export function renderStatus(session: Session, opts: { colors?: Colors } = {}): string {
  const c = opts.colors ?? new Colors(false);
  const stats = statusStats(session);
  const outPart = c.green(`↑${humanizeNumber(stats.out)}`);
  const inPart = c.blue(`↓${humanizeNumber(stats.in)}`);
  const toolPart = c.magenta(`\u{1F527}${stats.tools}`);
  const parts = [
    `\u{1F333} ${stats.prompts} prompts`,
    `active ${humanizeDuration(stats.activeS)}`,
    `${outPart} ${inPart}`,
    toolPart,
  ];
  if (stats.subagents) parts.push(c.dim(`+${stats.subagents} agent${stats.subagents === 1 ? '' : 's'}`));
  return parts.join(' · ');
}

export interface StatusJson extends StatusStats {
  sessionId: string | null;
  agent: string | null;
}

/** The `--json` shape for `promptlog status`/`statusline`: `stats` plus
 * whatever the caller knows about which session this is. */
export function statusJson(
  session: Session,
  opts: { sessionId?: string | null; agent?: string | null } = {},
): StatusJson {
  const stats = statusStats(session);
  return {
    ...stats,
    sessionId: opts.sessionId ?? session.id ?? null,
    agent: opts.agent ?? session.agent ?? null,
  };
}
