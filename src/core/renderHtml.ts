/** HTML rendering of a Session: a self-contained fragment (renderFragment),
 * and a full standalone document that wraps it (renderHtml).
 *
 * Layout: a single CSS grid (`[lanes] auto [card] 1fr`), one row per turn
 * (plus short connector rows where branches rejoin), so the lane graph and
 * the prompt cards can never drift out of alignment - the grid itself does
 * the aligning. Lanes are computed with the same algorithm renderTree.ts
 * uses for the terminal git-log-style graph (`buildLanes`), so the two
 * views agree on topology. */

import crypto from 'node:crypto';
import type { Session, Turn } from './model';
import { mostCommon } from './model';
import type { LaneCell } from './renderTree';
import { buildLanes } from './renderTree';
import { totalsWithSubagents } from './subagents';
import { firstLine, humanizeDuration, humanizeNumber, localHHMM, localYMDHM, sourceLabel } from './util';

const LANE_COLORS = ['#e07b39', '#4c9f70', '#3a86ff', '#c0392b', '#8e44ad', '#16a085', '#d4a017', '#e84393'];

const MAX_FRAGMENT_BYTES = 900 * 1024;
const TRUNCATED_PROMPT_LEN = 2000;
const MAX_TURNS_WHEN_HUGE = 200;

const LANE_W = 18; // px per lane column
const CONNECTOR_H = 14; // px, connector row height

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Highlight redaction placeholders, per DESIGN.md "Origin resolution"
 * ("Redacted spans are highlighted in HTML (`<mark>`)").
 *
 * Runs on ALREADY-ESCAPED text, so the placeholder is matched in its escaped
 * form and only our own markup is ever inserted. The kind is exposed as a
 * data attribute rather than interpolated into a class name.
 */
const REDACTED_RE = /\[redacted:([a-z0-9-]{1,32}):([0-9a-f]{1,8})\]/gi;

function markRedactions(escaped: string): string {
  return String(escaped).replace(
    REDACTED_RE,
    (m, kind, hash4) =>
      `<mark class="redacted" data-kind="${escapeHtml(kind)}" title="redacted ${escapeHtml(kind)} (${escapeHtml(hash4)})">${m}</mark>`,
  );
}

/**
 * The suffix of the fragment's root element id (`promptlog-<suffix>`). It is
 * interpolated raw into CSS selectors (`#promptlog-… {`) and the script, so
 * it must come from a strict alphabet: a session id is read from a
 * transcript and is not otherwise validated, and one like `x{}body` would
 * escape the CSS scope. The first 8 chars are used when every one of them is
 * `[A-Za-z0-9_-]` (and there are at least 4); otherwise the first 8 hex of
 * sha256(id), which is still stable per session.
 */
export function safeIdSuffix(sessionId: string | null | undefined): string {
  const prefix = String(sessionId ?? '').slice(0, 8);
  const kept = prefix.replace(/[^A-Za-z0-9_-]/g, '');
  if (kept.length >= 4 && kept.length === prefix.length) return kept;
  return crypto
    .createHash('sha256')
    .update(String(sessionId ?? ''))
    .digest('hex')
    .slice(0, 8);
}

function truncateText(text: string, maxLen: number | null): string {
  if (maxLen == null || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n…[truncated]`;
}

/** Render the lanes-column SVG for one grid row. `cells` is the array
 * buildLanes produced for this row ('* ', '| ', '/ ' or '  ' per lane).
 * `laneIdx` is the lane this row's own turn (or, for a connector row, the
 * lane the merge targets) occupies. `maxLanes` fixes the column width so
 * every row's SVG is the same pixel width and lanes line up vertically.
 * `isConnector` selects a short fixed-height glyph-only row; otherwise the
 * SVG stretches to the full (variable) height of the card next to it. */
function renderLaneSvg(opts: {
  cells: LaneCell[];
  laneIdx: number;
  maxLanes: number;
  isConnector: boolean;
  color?: string;
}): string {
  const { cells, laneIdx, maxLanes, isConnector, color } = opts;
  const w = LANE_W * maxLanes;
  const x = (i: number) => LANE_W * i + LANE_W / 2;
  const parts: string[] = [];
  if (isConnector) {
    const h = CONNECTOR_H;
    cells.forEach((cell, i) => {
      if (cell === '| ') {
        const c = LANE_COLORS[i % LANE_COLORS.length];
        parts.push(`<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${h}" stroke="${c}" stroke-width="2"/>`);
      } else if (cell === '/ ') {
        const c = LANE_COLORS[i % LANE_COLORS.length];
        // Displayed oldest-first (top-down); mirrors the CLI's `/` -> `\`
        // flip for --reverse, so the merge reads the right way visually.
        parts.push(
          `<line x1="${x(i)}" y1="${h}" x2="${x(laneIdx)}" y2="0" stroke="${c}" stroke-width="2" opacity="0.7"/>`,
        );
      }
    });
    return `<svg class="lanesvg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
  }
  cells.forEach((cell, i) => {
    if (cell === '  ') return;
    const c = LANE_COLORS[i % LANE_COLORS.length];
    parts.push(`<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="100%" stroke="${c}" stroke-width="2"/>`);
  });
  parts.push(`<circle cx="${x(laneIdx)}" cy="50%" r="6" fill="${color}" class="node" />`);
  return `<svg class="lanesvg" width="${w}" height="100%" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

/** Build the `#promptlog-<sid>` fragment (no doctype/html/head/body) for the
 * given (already oldest-first) subset of turns. `promptMaxLen` truncates
 * each prompt's text; `noteHtml`, if given, is rendered as an extra card at
 * the top (used when older turns were dropped to stay under the size cap). */
function buildFragment(
  session: Session,
  turns: Turn[],
  sid: string,
  opts: { promptMaxLen?: number | null; noteHtml?: string; responses?: boolean } = {},
): string {
  const { promptMaxLen = null, noteHtml = '', responses = false } = opts;
  // `sid` is already the strict-alphabet suffix from safeIdSuffix(); nothing
  // else from the session is ever placed in a selector or the script.
  const rootId = `promptlog-${sid}`;
  const n = turns.length;

  const newestFirst = turns.slice().sort((a, b) => b.tsMicros - a.tsMicros);
  const rows = buildLanes(newestFirst).slice().reverse(); // oldest-first, top-down
  const maxLanes = Math.max(1, ...rows.map(([, , cells]) => cells.length));

  const maxDur = turns.length ? Math.max(...turns.map((t) => t.durationS)) || 1 : 1;

  let cardIdx = 0;
  const rowsHtml = rows.map(([turn, laneIdx, cells]) => {
    if (turn === null) {
      const lanesHtml = renderLaneSvg({ cells, laneIdx, maxLanes, isConnector: true });
      return `<div class="lane-cell connector-cell">${lanesHtml}</div><div class="connector-spacer"></div>`;
    }

    const i = cardIdx++;
    const color = LANE_COLORS[laneIdx % LANE_COLORS.length];
    const lanesHtml = renderLaneSvg({ cells, laneIdx, maxLanes, isConnector: false, color });
    const lanesCol = `<div class="lane-cell" data-card="card-${i}">${lanesHtml}</div>`;

    const pctDur = Math.max(2, Math.round((100 * turn.durationS) / maxDur));
    const durBar =
      `<span class="durbar" title="${turn.durationS.toFixed(3)}s">` +
      `<span class="durbar-fill" style="width:${pctDur}%"></span></span>`;

    if (turn.isCommand) {
      const cmdText = escapeHtml(firstLine(truncateText(turn.prompt, promptMaxLen)));
      const content = `
<div class="turn-row cmd-row" id="card-${i}">
  <span class="badge">cmd</span>
  <span class="idtag">${escapeHtml(turn.id)}</span>
  <span class="cmdtext">${cmdText}</span>
  <span class="ts">${localYMDHM(turn.tsMicros)}</span>
</div>`;
      return lanesCol + content;
    }

    const promptEsc = markRedactions(escapeHtml(truncateText(turn.prompt, promptMaxLen)));
    const toolsBits = mostCommon(turn.toolNames)
      .map(([k, v]) => `${escapeHtml(k)}×${v}`)
      .join(' ');
    const filesBits = [...turn.files]
      .sort()
      .slice(0, 5)
      .map((f) => escapeHtml(f))
      .join(', ');
    const modelsBits = [...turn.models]
      .sort()
      .map((m) => escapeHtml(m))
      .join(', ');
    const srcLabel = sourceLabel(turn);
    const srcChip = srcLabel ? `<span class="chip chip-${srcLabel}">${srcLabel}</span>` : '';

    // Own usage is the card's primary ↑/↓; subagents are a separate muted
    // clause with the same words as the tree's `-v` rows, never folded in.
    const sub = turn.subagents;
    const agentsHtml = sub.count
      ? `<span class="agents">+${sub.count} agents ↑${humanizeNumber(sub.output + sub.thinking)} ` +
        `↓${humanizeNumber(sub.input + sub.cacheRead + sub.cacheWrite)}</span>`
      : '';

    let responseHtml = '';
    if (responses) {
      if (turn.responsePending) {
        responseHtml = '<div class="detail response-pending">response pending…</div>';
      } else if (turn.response) {
        const respEsc = markRedactions(escapeHtml(truncateText(turn.response, promptMaxLen)));
        responseHtml = `
    <details class="response">
      <summary>response</summary>
      <pre class="response-text">${respEsc}</pre>
    </details>`;
      }
    }

    const content = `
<div class="turn-row" id="card-${i}">
  <div class="card">
    <div class="card-head">
      <span class="idtag">${escapeHtml(turn.id)}</span>
      ${srcChip}
      <span class="ts">${localHHMM(turn.tsMicros)}</span>
      <span class="dur">${humanizeDuration(turn.durationS)}</span>
      ${durBar}
      <span class="tok out">↑${humanizeNumber(turn.outputTokens + turn.thinkingTokens)}</span>
      <span class="tok in">↓${humanizeNumber(turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens)}</span>
      <span class="tools">🔧${turn.toolCalls}</span>
      ${agentsHtml}
    </div>
    <pre class="prompt">${promptEsc}</pre>
    <button class="show-toggle" type="button">Show all</button>
    ${toolsBits ? `<div class="detail">tools: ${toolsBits}</div>` : ''}
    ${filesBits ? `<div class="detail">files: ${filesBits}</div>` : ''}
    ${modelsBits ? `<div class="detail">models: ${modelsBits}</div>` : ''}
    ${responseHtml}
  </div>
</div>`;
    return lanesCol + content;
  });

  // Header totals are own + subagents from the shared arithmetic (DESIGN.md
  // "Subagent usage"), exactly as the tree header reports them.
  const tot = totalsWithSubagents(turns, session.subagentsUnattributed);
  const totalDur = turns.reduce((s, t) => s + t.durationS, 0);
  const totalTools = turns.reduce((s, t) => s + t.toolCalls, 0);
  const agentsNote = tot.count ? ` (+${tot.count} agent${tot.count === 1 ? '' : 's'})` : '';

  const started = session.startedMicros != null ? localYMDHM(session.startedMicros) : '?';
  const header =
    `session ${escapeHtml(String(session.id).slice(0, 8))} · ${escapeHtml(session.agent)} · ` +
    `${escapeHtml(session.cwd ?? '')} · ${started} · ${n} prompts · ` +
    `${humanizeDuration(totalDur)} · ↑${humanizeNumber(tot.total.output)} ↓${humanizeNumber(tot.total.input)}${agentsNote} · ` +
    `🔧${totalTools} tool calls`;

  const lanesColW = LANE_W * maxLanes;

  // Every selector below is scoped by `#rootId`, except the @media wrapper
  // lines themselves (which nest a `#rootId`-scoped selector inside).
  const style = `<style>
#${rootId} {
  --bg:#f7f5f0; --fg:#1f2430; --muted:#6b7280; --card:#ffffff; --border:#e3e0d8;
  --accent:#3a86ff; --accent2:#4c9f70; --idcolor:#c98a1e;
  background: var(--bg); color: var(--fg); display: block;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; border-radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) #${rootId} { --bg:#15181f; --fg:#e7e9ee; --muted:#9aa1ac; --card:#1d212b; --border:#2a2f3a; }
}
:root[data-theme="dark"] #${rootId} { --bg:#15181f; --fg:#e7e9ee; --muted:#9aa1ac; --card:#1d212b; --border:#2a2f3a; }
#${rootId} * { box-sizing: border-box; }
#${rootId} h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
#${rootId} .header { font-size: 13px; color: var(--muted); margin-bottom: 16px; font-variant-numeric: tabular-nums; }
#${rootId} .note { font-size: 12px; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
#${rootId} .grid { display: grid; grid-template-columns: [lanes] ${lanesColW}px [card] 1fr; align-items: stretch; }
#${rootId} .lane-cell { grid-column: lanes; position: relative; align-self: stretch; cursor: pointer; }
#${rootId} .lane-cell.connector-cell { cursor: default; height: ${CONNECTOR_H}px; }
#${rootId} .lanesvg { display: block; }
#${rootId} .lanesvg .node { cursor: pointer; }
#${rootId} .lane-cell:hover .node { stroke: var(--fg); stroke-width: 2; }
#${rootId} .connector-spacer { grid-column: card; height: ${CONNECTOR_H}px; }
#${rootId} .turn-row { grid-column: card; padding: 3px 0; scroll-margin-top: 20px; }
#${rootId} .turn-row.highlight .card { background: color-mix(in srgb, var(--accent) 15%, var(--card)); }
#${rootId} .turn-row.highlight.cmd-row { background: color-mix(in srgb, var(--accent) 15%, var(--bg)); }
#${rootId} .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; transition: background .3s ease; }
#${rootId} .card-head { display: flex; gap: 10px; align-items: center; font-size: 12px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
#${rootId} .idtag { color: var(--idcolor); font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#${rootId} .badge { font-size: 10px; background: var(--border); padding: 1px 6px; border-radius: 4px; }
#${rootId} .ts, #${rootId} .dur { color: var(--muted); }
#${rootId} .tok.out { color: var(--accent2); }
#${rootId} .tok.in { color: var(--accent); }
#${rootId} .agents { color: var(--muted); font-size: 11px; }
#${rootId} .durbar { width: 60px; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; display: inline-block; }
#${rootId} .durbar-fill { display: block; height: 100%; background: var(--accent); }
#${rootId} mark.redacted { background: var(--redacted-bg, #fff3bf); color: inherit; border-radius: 3px; padding: 0 2px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); font-style: normal; }
@media (prefers-color-scheme: dark) { #${rootId} mark.redacted { background: #4a3a00; color: #ffe9a3; } }
#${rootId} .prompt { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; line-height: 1.45; margin: 8px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; position: relative; }
#${rootId} .prompt.clamped { max-height: calc(1.45em * 6); overflow: hidden; }
#${rootId} .prompt.clamped::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 22px; background: linear-gradient(to bottom, transparent, var(--card)); }
#${rootId} .card.expanded .prompt.clamped { max-height: none; }
#${rootId} .card.expanded .prompt.clamped::after { display: none; }
#${rootId} .show-toggle { display: none; font-size: 11px; color: var(--accent); cursor: pointer; margin-top: 4px; background: none; border: none; padding: 0; font-family: inherit; }
#${rootId} .show-toggle.visible { display: inline-block; }
#${rootId} .detail { font-size: 11px; color: var(--muted); margin-top: 4px; }
#${rootId} .cmd-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); padding: 4px 2px; }
#${rootId} .cmd-row .cmdtext { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
#${rootId} .cmd-row .ts { margin-left: auto; }
#${rootId} .chip { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 10px; background: var(--border); color: var(--muted); }
#${rootId} .chip-modified { color: #b8860b; }
#${rootId} .chip-repo { color: var(--accent); }
#${rootId} .response-pending { font-style: italic; }
#${rootId} .response { margin-top: 6px; font-size: 12px; }
#${rootId} .response summary { cursor: pointer; color: var(--muted); }
#${rootId} .response-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; line-height: 1.45; margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>`;

  const script = `<script>
(function() {
  var root = document.getElementById(${JSON.stringify(rootId)});
  if (!root) return;
  root.querySelectorAll('.lane-cell[data-card]').forEach(function(el) {
    el.addEventListener('click', function() {
      var id = el.getAttribute('data-card');
      var row = root.querySelector('#' + id);
      if (!row) return;
      row.scrollIntoView({behavior: 'smooth', block: 'center'});
      root.querySelectorAll('.turn-row.highlight').forEach(function(c) { c.classList.remove('highlight'); });
      row.classList.add('highlight');
      setTimeout(function() { row.classList.remove('highlight'); }, 2000);
    });
  });
  root.querySelectorAll('.card').forEach(function(card) {
    var pre = card.querySelector('.prompt');
    var toggle = card.querySelector('.show-toggle');
    if (!pre || !toggle) return;
    pre.classList.add('clamped');
    if (pre.scrollHeight - pre.clientHeight > 4) {
      toggle.classList.add('visible');
      toggle.textContent = 'Show all';
      toggle.addEventListener('click', function() {
        var expanded = card.classList.toggle('expanded');
        toggle.textContent = expanded ? 'Show less' : 'Show all';
      });
    } else {
      pre.classList.remove('clamped');
    }
  });
})();
</script>`;

  return `<div id="${rootId}">
${style}
<h1>promptlog</h1>
<div class="header">${header}</div>
${noteHtml}
<div class="grid">
${rowsHtml.join('\n')}
</div>
${script}
</div>`;
}

function computeFragment(
  session: Session,
  sid: string,
  opts: { promptMaxLen?: number | null; maxTurns?: number | null; responses?: boolean } = {},
): string {
  const { promptMaxLen = null, maxTurns = null, responses = false } = opts;
  let turns = session.turns.slice().sort((a, b) => a.tsMicros - b.tsMicros);
  let noteHtml = '';
  if (maxTurns != null && turns.length > maxTurns) {
    const total = turns.length;
    turns = turns.slice(-maxTurns);
    noteHtml = `<div class="note">Showing the newest ${maxTurns} of ${total} turns — older turns were omitted to keep this report under the size limit.</div>`;
  }
  return buildFragment(session, turns, sid, { promptMaxLen, noteHtml, responses });
}

/** Body content only: a single `#promptlog-<sessionid8>` div with a scoped
 * `<style>`, the lane graph + card grid, and a `<script>` - no
 * doctype/html/head/body. Caps its own size: truncates long prompts, then
 * (if still too big) keeps only the newest 200 turns. */
export function renderFragment(session: Session, opts: { responses?: boolean } = {}): string {
  const { responses = false } = opts;
  const sid = safeIdSuffix(session.id);
  let frag = computeFragment(session, sid, { responses });
  if (Buffer.byteLength(frag, 'utf-8') > MAX_FRAGMENT_BYTES) {
    frag = computeFragment(session, sid, { promptMaxLen: TRUNCATED_PROMPT_LEN, responses });
  }
  if (Buffer.byteLength(frag, 'utf-8') > MAX_FRAGMENT_BYTES) {
    frag = computeFragment(session, sid, {
      promptMaxLen: TRUNCATED_PROMPT_LEN,
      maxTurns: MAX_TURNS_WHEN_HUGE,
      responses,
    });
  }
  return frag;
}

/** Full standalone document (doctype/head/body) wrapping renderFragment(). */
export function renderHtml(session: Session, opts: { responses?: boolean } = {}): string {
  const { responses = false } = opts;
  const sid = escapeHtml(String(session.id).slice(0, 8));
  const fragment = renderFragment(session, { responses });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>promptlog: ${sid}</title>
</head>
<body>
${fragment}
</body>
</html>
`;
}
