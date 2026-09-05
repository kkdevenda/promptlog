/** git-log --graph style rendering of a Session. */

import path from 'node:path';
import type { Session, Turn } from './model';
import { mostCommon } from './model';
import { totalsWithSubagents } from './subagents';
import { Colors, firstLine, humanizeDuration, humanizeNumber, localHHMM, microsToDate } from './util';

/** The marker a row carries when the prompt spawned subagents whose tokens are
 * NOT in that row's numbers. One column wide, so a row's layout is unchanged. */
export const SUBAGENT_MARK = '⁺';

function useColor(noColor: boolean): boolean {
  if (noColor) return false;
  if (process.env.NO_COLOR) return false;
  return !!process.stdout?.isTTY;
}

/** Like firstLine(), but also returns everything after that line (paragraph
 * breaks intact) so `--full` can flow it into the body with no dropped or
 * duplicated text. */
function firstLineAndRest(text: string | null | undefined): { line: string; rest: string } {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  let idx = 0;
  while (idx < lines.length && !(lines[idx] ?? '').trim()) idx++;
  if (idx >= lines.length) return { line: '', rest: '' };
  return { line: (lines[idx] ?? '').trim(), rest: lines.slice(idx + 1).join('\n') };
}

function terminalWidth(): number {
  const cols = process.stdout?.columns;
  return cols && cols > 0 ? cols : 120;
}

function clampWidth(w: number): number {
  return Math.max(60, Math.min(400, w));
}

/** dim `[repo]` / `[modified]` tag for a non-origin turn.source, or
 * `[pending]` when `--responses` is on and the turn has no response yet. */
function sourceOrPendingTag(turn: Turn, opts: { responses: boolean; colors: Colors }): string {
  if (turn.source && turn.source !== 'origin') {
    const label = turn.source === 'origin-modified' ? 'modified' : 'repo';
    return opts.colors.dim(`[${label}] `);
  }
  if (opts.responses && turn.responsePending) {
    return opts.colors.dim('[pending] ');
  }
  return '';
}

export type LaneCell = '* ' | '| ' | '/ ' | '  ';
export type LaneRow = [Turn | null, number, LaneCell[]];

/** Assign a lane (column) to each turn walking newest-first, git-log style.
 * Returns rows of [turn, laneIdx, cells]. Connector rows (turn=null) carry
 * the `|/` glyphs where sibling branches rejoin their parent. */
export function buildLanes(turnsNewestFirst: Turn[]): LaneRow[] {
  const lanes: Array<string | null> = []; // fullId each lane is waiting for
  const rows: LaneRow[] = [];
  for (const t of turnsNewestFirst) {
    const matches: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === t.fullId) matches.push(i);
    }
    let laneIdx: number;
    let extra: number[];
    if (matches.length) {
      laneIdx = matches[0] as number;
      extra = matches.slice(1);
    } else {
      laneIdx = lanes.length;
      extra = [];
      lanes.push(null);
    }

    if (extra.length) {
      // draw a |/ row before the node where branches rejoin
      const cells: LaneCell[] = [];
      for (let i = 0; i < lanes.length; i++) {
        if (i === laneIdx) cells.push('| ');
        else if (extra.includes(i)) cells.push('/ ');
        else if (lanes[i] !== null) cells.push('| ');
        else cells.push('  ');
      }
      rows.push([null, laneIdx, cells]);
      for (const i of extra) lanes[i] = null;
      while (lanes.length && lanes[lanes.length - 1] === null && lanes.length - 1 > laneIdx) {
        lanes.pop();
      }
    }

    const cells: LaneCell[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i === laneIdx) cells.push('* ');
      else if (lanes[i] !== null) cells.push('| ');
      else cells.push('  ');
    }
    rows.push([t, laneIdx, cells]);
    lanes[laneIdx] = t.parentId;
  }

  return rows;
}

export interface RenderTreeOptions {
  reverse?: boolean;
  limit?: number | null;
  verbose?: boolean;
  noColor?: boolean;
  responses?: boolean;
  full?: boolean;
  width?: number | null;
}

export function renderTree(session: Session, opts: RenderTreeOptions = {}): string {
  const {
    reverse = false,
    limit = null,
    verbose = false,
    noColor = false,
    responses = false,
    full = false,
    width = null,
  } = opts;
  const colors = new Colors(useColor(noColor));
  const lines: string[] = [];

  const fullCount = session.turns.length;
  let turns = session.turns.slice();
  if (limit) {
    turns = turns.slice(-limit);
  }

  // Rows show OWN usage; the header and the totals row show own + subagents
  // and say so (DESIGN.md "Subagent usage"). `tot.*.output` already includes
  // thinking, matching the rows' ↑ (outputTokens + thinkingTokens).
  const tot = totalsWithSubagents(turns, session.subagentsUnattributed);
  const totalOut = tot.own.output;
  const totalIn = tot.own.input;
  const totalDuration = turns.reduce((s, t) => s + t.durationS, 0);
  const started = session.startedMicros;
  const startedStr = started != null ? localYMDHMFromMicros(started) : '?';
  const header =
    `session ${colors.cyan(session.id.slice(0, 8))} · ${session.agent} · ${session.cwd} · ` +
    `${startedStr} · ${turns.length} prompts · ` +
    `${humanizeDuration(totalDuration)} · ↑${humanizeNumber(tot.total.output)} ↓${humanizeNumber(tot.total.input)}` +
    (tot.count ? ` (+${tot.count} agent${tot.count === 1 ? '' : 's'})` : '');
  lines.push(header);
  lines.push('');

  const newestFirst = turns.slice().sort((a, b) => b.tsMicros - a.tsMicros);
  const rows = buildLanes(newestFirst);
  const orderedRows = reverse ? rows.slice().reverse() : rows;

  const termWidth = width != null ? clampWidth(width) : terminalWidth();
  let lastPrefixLen = 0;

  for (const [turn, , cells] of orderedRows) {
    const prefix = cells.join('');
    lastPrefixLen = prefix.length;
    if (turn === null) {
      let glyphs = cells.map((c) => c[0]).join('');
      glyphs = glyphs.replace(/\s+$/, '');
      lines.push(reverse ? glyphs.split('/').join('\\') : glyphs);
      continue;
    }
    const timeS = localHHMM(turn.tsMicros);
    const durS = humanizeDuration(turn.durationS);
    const outS = humanizeNumber(turn.outputTokens + turn.thinkingTokens);
    const inS = humanizeNumber(turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens);
    const toolsS = String(turn.toolCalls);

    const idPart = colors.yellow(turn.id);
    const timePart = colors.dim(timeS);
    const durPart = padEnd(durS, 7);
    const outPart = colors.green(`↑${padStart(outS, 5)}`);
    const inPart = colors.blue(`↓${padStart(inS, 5)}`);
    const toolPart = colors.magenta(`\u{1F527}${padStart(toolsS, 3)}`);

    const tag = sourceOrPendingTag(turn, { responses, colors });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes to measure visible width.
    const tagVisibleLen = tag ? tag.replace(/\x1b\[[0-9;]*m/g, '').length : 0;

    // A turn's own numbers never include its subagents'. Normal mode says so
    // with one dim character after the ↓ value; -v spells the numbers out.
    const sub = turn.subagents;
    const mark = sub.count && !verbose ? colors.dim(SUBAGENT_MARK) : '';
    const markLen = sub.count && !verbose ? 1 : 0;
    const agentsBits =
      sub.count && verbose
        ? ` +${sub.count} agents ↑${humanizeNumber(sub.output + sub.thinking)} ↓${humanizeNumber(sub.input + sub.cacheRead + sub.cacheWrite)}`
        : '';
    const agentsPart = agentsBits ? colors.dim(agentsBits) : '';

    const meta = `${prefix}${idPart}  ${timePart}  ${durPart}  ${outPart}  ${inPart}${mark}  ${toolPart}${agentsPart}  ${tag}`;
    const metaVisibleLen =
      prefix.length +
      7 +
      2 +
      5 +
      2 +
      7 +
      2 +
      6 +
      2 +
      6 +
      markLen +
      2 +
      5 +
      agentsBits.length +
      2 +
      tagVisibleLen;
    const remaining = Math.max(10, termWidth - metaVisibleLen);

    let promptLine: string;
    let bodyText: string | null = null; // rest of the prompt to flow into the body (full mode, non-command)
    if (full) {
      // Cut at the first line break or width, never with an ellipsis. The
      // remainder flows into the body, except for a command turn, which
      // never has a body (the remainder is simply dropped there).
      const { line, rest } = firstLineAndRest(turn.prompt);
      if (line.length > remaining) {
        // Break at a word boundary when one exists in the last part of the
        // line; a hard cut only for a single very long token.
        let cut = line.lastIndexOf(' ', remaining);
        if (cut < Math.floor(remaining * 0.6)) cut = remaining;
        promptLine = line.slice(0, cut).replace(/\s+$/, '');
        bodyText = turn.isCommand ? null : line.slice(cut).replace(/^\s+/, '') + (rest ? `\n${rest}` : '');
      } else {
        promptLine = line;
        bodyText = turn.isCommand ? null : rest || null;
      }
    } else {
      promptLine = firstLine(turn.prompt);
      if (promptLine.length > remaining) {
        promptLine = `${promptLine.slice(0, Math.max(0, remaining - 1)).replace(/\s+$/, '')}…`;
      }
    }
    if (turn.isCommand) promptLine = colors.dim(promptLine);

    lines.push(`${meta}${promptLine}`);

    if (full && bodyText) {
      const bodyIndent = ' '.repeat(metaVisibleLen);
      for (const wline of wrapText(bodyText, Math.max(20, termWidth - metaVisibleLen))) {
        lines.push(`${bodyIndent}${colors.dim(wline)}`);
      }
    }

    if (responses) {
      const indent = full ? ' '.repeat(metaVisibleLen) : ' '.repeat(prefix.length + 2);
      if (turn.responsePending) {
        // already shown as the [pending] tag above
      } else if (turn.response) {
        if (full) lines.push(`${indent}${colors.dim('── response ──')}`);
        if (verbose || full) {
          for (const wline of wrapText(turn.response, Math.max(20, termWidth - indent.length))) {
            lines.push(`${indent}${colors.dim(wline)}`);
          }
        } else {
          const rline = firstLine(turn.response);
          if (rline) lines.push(`${indent}${colors.dim(rline)}`);
        }
      }
    }

    if (verbose) {
      const indent = ' '.repeat(prefix.length + 2);
      if (turn.toolNames.size) {
        const toolBits = mostCommon(turn.toolNames)
          .map(([name, cnt]) => `${name}×${cnt}`)
          .join(' ');
        lines.push(`${indent}${colors.dim('tools:')} ${toolBits}`);
      }
      if (turn.files.size) {
        const relFiles: string[] = [];
        for (const f of [...turn.files].sort().slice(0, 5)) {
          // A null session.cwd (no `cwd` recorded for this transcript) keeps
          // the absolute filename, matching OLD's `path.relative(null, f)`
          // throw-and-fall-back rather than relativizing against ''.
          if (session.cwd == null) {
            relFiles.push(f);
            continue;
          }
          try {
            relFiles.push(path.relative(session.cwd, f));
          } catch {
            relFiles.push(f);
          }
        }
        lines.push(`${indent}${colors.dim('files:')} ${relFiles.join(', ')}`);
      }
      if (turn.models.size) {
        lines.push(`${indent}${colors.dim('models:')} ${[...turn.models].sort().join(', ')}`);
      }
      if (turn.cacheReadTokens || turn.cacheWriteTokens) {
        lines.push(
          `${indent}${colors.dim('cache:')} read=${humanizeNumber(turn.cacheReadTokens)} ` +
            `write=${humanizeNumber(turn.cacheWriteTokens)}`,
        );
      }
      if (turn.thinkingTokens) {
        lines.push(`${indent}${colors.dim('thinking:')} ${humanizeNumber(turn.thinkingTokens)} tokens`);
      }
    }
  }

  if (turns.length) {
    const cmdCount = turns.filter((t) => t.isCommand).length;
    const toolsSum = turns.reduce((s, t) => s + t.toolCalls, 0);
    const minTs = Math.min(...turns.map((t) => t.tsMicros));
    const maxTs = Math.max(...turns.map((t) => t.tsMicros));
    const wallSpanS = (maxTs - minTs) / 1e6;

    let countStr = String(turns.length);
    if (turns.length !== fullCount) countStr += ` of ${fullCount}`;
    countStr += ' prompts';
    if (cmdCount) countStr += ` (${cmdCount} cmd)`;

    // Two durations side by side need names: span = first to last prompt,
    // active = sum of the agent's turn times.
    const timeStr = `span ${humanizeDuration(wallSpanS)}`;
    const durStr = `active ${humanizeDuration(totalDuration)}`;
    const outStr = `↑${padStart(humanizeNumber(totalOut), 5)}`;
    const inStr = `↓${padStart(humanizeNumber(totalIn), 5)}`;
    const toolStr = `\u{1F527}${padStart(String(toolsSum), 3)}`;

    // One line while nothing spawned a subagent; three when something did,
    // so "own", "what the agents spent" and "the truth" are all visible and
    // none of them has to be inferred from the others.
    const head = `${countStr}  ${timeStr}  ${durStr}`;
    const totalsLines: string[] = [];
    if (tot.count) {
      const label = (text: string) => padEnd(text, displayWidth(`subagents (${tot.count})`));
      const numbers = (o: number, i: number, tools: number | null) =>
        `↑${padStart(humanizeNumber(o), 5)}  ↓${padStart(humanizeNumber(i), 5)}` +
        (tools == null ? '' : `  \u{1F527}${padStart(String(tools), 3)}`);
      totalsLines.push(`${label('own')}  ${head}  ${numbers(tot.own.output, tot.own.input, toolsSum)}`);
      const pad = ' '.repeat(displayWidth(head));
      totalsLines.push(
        `${label(`subagents (${tot.count})`)}  ${pad}  ${numbers(tot.sub.output, tot.sub.input, null)}`,
      );
      totalsLines.push(`${label('total')}  ${pad}  ${numbers(tot.total.output, tot.total.input, null)}`);
    } else {
      totalsLines.push(`${countStr}  ${timeStr}  ${durStr}  ${outStr}  ${inStr}  ${toolStr}`);
    }
    const ruleWidth = Math.max(...totalsLines.map(displayWidth));

    lines.push(colors.dim('─'.repeat(ruleWidth)));
    for (const l of totalsLines) lines.push(colors.dim(`${' '.repeat(lastPrefixLen)}${l}`));
  }

  return `${lines.join('\n')}\n`;
}

/** visible column width of a plain (no-ANSI) string, counting emoji/wide
 * symbols (e.g. the 🔧 tool glyph) as two columns like a real terminal. */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += cp >= 0x1f300 || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1;
  }
  return w;
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let cur = '';
    for (const w of words) {
      if (cur && cur.length + 1 + w.length > width) {
        out.push(cur);
        cur = w;
      } else {
        cur = cur ? `${cur} ${w}` : w;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function localYMDHMFromMicros(micros: number): string {
  const d = microsToDate(micros);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Render just the Nth most recent non-command prompt verbatim, plus a
 * single metrics line. */
export function renderLast(
  session: Session,
  n: number,
  opts: { colorsEnabled?: boolean; responses?: boolean } = {},
): string {
  const { colorsEnabled = true, responses = false } = opts;
  const colors = new Colors(colorsEnabled);
  const nonCmd = session.turns.filter((t) => !t.isCommand);
  const nonCmdSorted = nonCmd.slice().sort((a, b) => b.tsMicros - a.tsMicros);
  if (n < 1 || n > nonCmdSorted.length) return '';
  const turn = nonCmdSorted[n - 1] as Turn;
  return renderSingleLast(turn, colors, { responses });
}

function renderSingleLast(turn: Turn, colors: Colors, opts: { responses?: boolean } = {}): string {
  const { responses = false } = opts;
  const outS = humanizeNumber(turn.outputTokens + turn.thinkingTokens);
  const inS = humanizeNumber(turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens);
  // Own usage, then the subagents' as a separate clause: never silently
  // folded into the turn's own out/in.
  const sub = turn.subagents;
  const subS = sub.count
    ? ` · +${sub.count} agents ↑${humanizeNumber(sub.output + sub.thinking)} ↓${humanizeNumber(sub.input + sub.cacheRead + sub.cacheWrite)}`
    : '';
  const metrics =
    `[${colors.yellow(turn.id)} · ${colors.dim(localHHMM(turn.tsMicros))} · ` +
    `${humanizeDuration(turn.durationS)} · ${colors.green(`↑${outS} out`)} · ` +
    `${colors.blue(`↓${inS} in`)} · ${turn.toolCalls} tools${colors.dim(subS)}]`;
  let out = `${turn.prompt}\n\n${metrics}\n`;
  if (responses) {
    out += '\n── response ──\n';
    if (turn.responsePending) {
      out += `${colors.dim('[pending]')}\n`;
    } else if (turn.response) {
      out += `${turn.response}\n`;
    } else {
      out += `${colors.dim('(no response captured)')}\n`;
    }
  }
  return out;
}

export function renderLastAll(
  session: Session,
  opts: { colorsEnabled?: boolean; responses?: boolean } = {},
): string {
  const { colorsEnabled = true, responses = false } = opts;
  const colors = new Colors(colorsEnabled);
  const nonCmd = session.turns.filter((t) => !t.isCommand);
  const nonCmdSortedOldest = nonCmd.slice().sort((a, b) => a.tsMicros - b.tsMicros);
  const out: string[] = [];
  nonCmdSortedOldest.forEach((turn, idx) => {
    out.push(`--- ${idx + 1} ---`);
    out.push(renderSingleLast(turn, colors, { responses }));
  });
  return out.join('\n');
}
