/** Mermaid gitGraph rendering of a Session. */

import type { Session, Turn } from './model';
import { totalsWithSubagents } from './subagents';
import { escQuotes, humanizeDuration, humanizeNumber } from './util';

/** First non-empty line of text, trimmed and truncated to `max` chars. */
function firstLineTrunc(text: string | null | undefined, max: number): string {
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (t) {
      return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).replace(/\s+$/, '')}…` : t;
    }
  }
  return '';
}

/** ` +N agents ↑x ↓y` for a turn that spawned subagents, '' otherwise. */
function subagentsClause(turn: Turn): string {
  const sub = turn.subagents;
  if (!sub.count) return '';
  const out = humanizeNumber(sub.output + sub.thinking);
  const inn = humanizeNumber(sub.input + sub.cacheRead + sub.cacheWrite);
  return ` +${sub.count} agents ↑${out} ↓${inn}`;
}

function commitLine(turn: Turn): string {
  const id = escQuotes(turn.id);
  if (turn.isCommand) {
    return `    commit id: "${id}" type: HIGHLIGHT`;
  }
  const dur = humanizeDuration(turn.durationS);
  const out = humanizeNumber(turn.outputTokens + turn.thinkingTokens);
  const inn = humanizeNumber(turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens);
  const sourced = turn.source && turn.source !== 'origin';
  // Own usage first; a subagent clause is appended, never folded in, using
  // the same words as the tree's `-v` rows (DESIGN.md "Subagent usage").
  const tag = escQuotes(`${dur} · ↑${out} ↓${inn}${sourced ? ' · repo' : ''}${subagentsClause(turn)}`);
  return `    commit id: "${id}" tag: "${tag}"`;
}

/** Session header for `--mermaid`: totals as own + subagents from the same
 * arithmetic the tree header uses, as a `%%` comment line right under
 * `gitGraph LR:` so it is valid Mermaid and ignored by the renderer. Lives in
 * renderMermaid(), not buildGraphLines(): store.ts reuses the latter for the
 * repo README graph over a synthetic session with no id or totals. */
function headerLine(session: Session): string {
  const turns = session.turns;
  const tot = totalsWithSubagents(turns, session.subagentsUnattributed);
  const agents = tot.count ? ` (+${tot.count} agent${tot.count === 1 ? '' : 's'})` : '';
  const sid = String(session.id ?? '')
    .slice(0, 8)
    .replace(/[\r\n]/g, ' ');
  return (
    `    %% session ${sid} · ${turns.length} prompts · ` +
    `↑${humanizeNumber(tot.total.output)} ↓${humanizeNumber(tot.total.input)}${agents}`
  );
}

/** Build the raw `gitGraph LR: ...` lines (no fence) for a session, walking
 * each root's tree oldest-first. Children[0] of a node stays on the current
 * branch (rendered last); older siblings each get their own `rewind-<n>`
 * branch off the parent, rendered immediately, before the current branch's
 * own children continue. Second and later roots become `root-<n>` branches
 * off the very start, right after the first commit on main. */
export function buildGraphLines(session: Pick<Session, 'turns' | 'roots'>): string[] {
  const turnMap = new Map(session.turns.map((t) => [t.fullId, t]));
  const lines = ['gitGraph LR:'];
  let rewindCounter = 0;
  let rootCounter = 0;

  function emitCommit(turn: Turn): void {
    lines.push(commitLine(turn));
  }

  function processChildren(turn: Turn, branch: string): void {
    const children = turn.children
      .map((id) => turnMap.get(id))
      .filter((t): t is Turn => !!t)
      .sort((a, b) => a.tsMicros - b.tsMicros);
    if (!children.length) return;
    // The newest sibling is the path the user kept working on: it stays on
    // the current branch. Older siblings are abandoned rewinds and get side
    // branches.
    const first = children[children.length - 1] as Turn;
    const rest = children.slice(0, -1);
    for (const child of rest) {
      rewindCounter += 1;
      const bname = `rewind-${rewindCounter}`;
      lines.push(`    branch ${bname}`);
      lines.push(`    checkout ${bname}`);
      emitCommit(child);
      processChildren(child, bname);
      lines.push(`    checkout ${branch}`);
    }
    emitCommit(first);
    processChildren(first, branch);
  }

  const roots = session.roots.map((id) => turnMap.get(id)).filter((t): t is Turn => !!t);
  if (roots.length) {
    const root0 = roots[0] as Turn;
    emitCommit(root0);
    for (let j = 1; j < roots.length; j++) {
      const rootJ = roots[j] as Turn;
      rootCounter += 1;
      const bname = `root-${rootCounter}`;
      lines.push(`    branch ${bname}`);
      lines.push(`    checkout ${bname}`);
      emitCommit(rootJ);
      processChildren(rootJ, bname);
      lines.push('    checkout main');
    }
    processChildren(root0, 'main');
  }

  return lines;
}

/** Oldest-first numbered list mapping short ids back to prompts, skipping
 * slash-command turns. */
function buildIdList(session: Session): string {
  const nonCmd = session.turns
    .filter((t) => !t.isCommand)
    .slice()
    .sort((a, b) => a.tsMicros - b.tsMicros);
  return nonCmd.map((t, i) => `${i + 1}. ${t.id}  ${firstLineTrunc(t.prompt, 80)}`).join('\n');
}

/** Full text as printed by `--mermaid`: fenced gitGraph plus (unless `raw`)
 * a numbered id -> prompt list below it. */
export function renderMermaid(session: Session, opts: { raw?: boolean } = {}): string {
  const { raw = false } = opts;
  const graph = buildGraphLines(session);
  const body = [graph[0], headerLine(session), ...graph.slice(1)].join('\n');
  if (raw) return `${body}\n`;
  let out = `\`\`\`mermaid\n${body}\n\`\`\`\n`;
  const list = buildIdList(session);
  // Fenced separately (as plain text, not Markdown) so a prompt's first
  // line in the list is never re-interpreted as Markdown by whatever
  // renders this - same reason the id list itself must not run through a
  // Markdown-sensitive renderer unfenced.
  if (list) out += `\n\`\`\`text\n${list}\n\`\`\`\n`;
  return out;
}

/** Convenience export for embedding: same as the default (fenced + list)
 * `--mermaid` output, as a string. */
export function mermaid(session: Session): string {
  return renderMermaid(session, { raw: false });
}
