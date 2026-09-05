import path from 'node:path';
import { expect, test } from 'vitest';
import { parseClaudeSession } from '../src/agents/claude/parser';
import { Session, Turn, zeroSubagents } from '../src/core/model';
import { renderFragment, renderHtml, safeIdSuffix } from '../src/core/renderHtml';
import { renderMermaid } from '../src/core/renderMermaid';
import { renderStatus, statusStats } from '../src/core/renderStatus';
import { renderTree } from '../src/core/renderTree';
import { totalsWithSubagents } from '../src/core/subagents';
import { humanizeNumber } from '../src/core/util';

const BRANCH_FIXTURE = path.join(__dirname, 'fixtures', 'claude', 'branch.jsonl');

function loadBranchSession(): Session {
  return parseClaudeSession(BRANCH_FIXTURE);
}

test('mermaid: branch fixture has a rewind branch, a checkout main, and one commit per turn', () => {
  const session = loadBranchSession();
  const out = renderMermaid(session, { raw: true });

  expect(out.includes('branch rewind-1')).toBeTruthy();
  expect(out.includes('checkout main')).toBeTruthy();

  const commitCount = (out.match(/^\s*commit /gm) ?? []).length;
  expect(commitCount).toBe(session.turns.length);

  // main exists before anything branches off it, and every checkout targets
  // a branch name that was declared (main, or a `branch X` seen earlier).
  const lines = out.split('\n');
  const declared = new Set(['main']);
  for (const line of lines) {
    const b = line.match(/^\s*branch (\S+)/);
    if (b?.[1]) declared.add(b[1]);
    const c = line.match(/^\s*checkout (\S+)/);
    if (c?.[1]) expect(declared.has(c[1])).toBeTruthy();
  }
});

test('mermaid: default output is fenced and lists ids oldest-first', () => {
  const session = loadBranchSession();
  const out = renderMermaid(session);
  expect(out.startsWith('```mermaid\n')).toBeTruthy();
  expect(out.includes('```\n')).toBeTruthy();
  const listLines = out.split('\n').filter((l) => /^\d+\. /.test(l));
  expect(listLines.length).toBe(session.turns.filter((t) => !t.isCommand).length);
  expect(listLines[0]).toContain('first prompt');
});

test('fragment: no doctype/html/body, exactly one scoped root div, every rule scoped', () => {
  const session = loadBranchSession();
  const frag = renderFragment(session);

  expect(/<!doctype/i.test(frag)).toBeFalsy();
  expect(/<html/i.test(frag)).toBeFalsy();
  expect(/<body/i.test(frag)).toBeFalsy();

  const sid = session.id.slice(0, 8);
  const rootId = `promptlog-${sid}`;
  const rootMatches = frag.match(new RegExp(`<div id="${rootId}">`, 'g')) ?? [];
  expect(rootMatches.length).toBe(1);

  const styleMatch = frag.match(/<style>([\s\S]*?)<\/style>/);
  expect(styleMatch).toBeTruthy();
  const css = styleMatch?.[1] ?? '';
  // Every selector immediately preceding a `{` must reference the scoped
  // root id, except an `@media` wrapper line, which nests a scoped
  // selector inside its own braces.
  const selectorRe = /([^{}]+)\{/g;
  let m: RegExpExecArray | null;
  let count = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: iterating regex matches.
  while ((m = selectorRe.exec(css))) {
    const selector = (m[1] ?? '').trim();
    count += 1;
    const ok = selector.includes(`#${rootId}`) || selector.startsWith('@media');
    expect(ok).toBeTruthy();
  }
  expect(count > 5).toBeTruthy(); // expected several CSS rules
});

test('--html output starts with a doctype', () => {
  const session = loadBranchSession();
  const out = renderHtml(session);
  expect(out.startsWith('<!doctype html>')).toBeTruthy();
});

test('fragment: one .turn-row per non-connector turn, plus at least one connector row', () => {
  const session = loadBranchSession();
  const frag = renderFragment(session);

  const turnRowMatches = frag.match(/class="turn-row/g) ?? [];
  expect(turnRowMatches.length).toBe(session.turns.length);

  const connectorMatches = frag.match(/connector-cell/g) ?? [];
  expect(connectorMatches.length > 0).toBeTruthy(); // expected at least one connector row
});

test('fragment: redaction placeholders are wrapped in scoped <mark>', () => {
  const t = new Turn({
    id: 'abc1234',
    fullId: 'u1',
    parentId: null,
    agent: 'claude',
    tsMicros: 1788000000000000,
    prompt: 'the key is [redacted:aws-key:1a5d] and the mail [redacted:email:99ff] too',
  });
  t.response = 'I used [redacted:gh-token:beef].';
  const session = new Session({
    id: 'c86e0429-3e3b-4f17-8262-35a6f0c85599',
    agent: 'claude',
    path: '/x',
    cwd: '/y',
    startedMicros: 1788000000000000,
    turns: [t],
    roots: ['u1'],
  });
  const frag = renderFragment(session, { responses: true });

  const marks = frag.match(/<mark class="redacted"[^>]*>[^<]*<\/mark>/g) ?? [];
  expect(marks.length).toBe(3); // every placeholder marked (prompt + response)
  expect(marks[0]).toMatch(/data-kind="aws-key"/);
  expect(marks[0]).toMatch(/>\[redacted:aws-key:1a5d\]<\/mark>/); // the placeholder text is preserved
  expect(frag).toMatch(/#promptlog-[0-9a-f]{8} mark\.redacted \{/); // CSS is scoped to the fragment root

  // Non-placeholder text is untouched, and nothing is double-escaped.
  expect(frag).toMatch(/the key is <mark/);
  expect(frag).not.toMatch(/&lt;mark/);
});

test('fragment: a bracket that only looks like a placeholder is not marked', () => {
  const t = new Turn({
    id: 'abc1234',
    fullId: 'u1',
    parentId: null,
    agent: 'claude',
    tsMicros: 1788000000000000,
    prompt:
      'see [redacted] and [redacted:WAY-TOO-LONG-A-KIND-NAME-INDEED-YES-REALLY:zz] and <script>x</script>',
  });
  const session = new Session({
    id: 'c86e0429-3e3b-4f17-8262-35a6f0c85599',
    agent: 'claude',
    path: '/x',
    cwd: '/y',
    startedMicros: 1788000000000000,
    turns: [t],
    roots: ['u1'],
  });
  const frag = renderFragment(session);
  expect((frag.match(/<mark class="redacted"/g) ?? []).length).toBe(0);
  expect(frag).not.toMatch(/<script>x<\/script>/); // still escaped
  expect(frag).toMatch(/&lt;script&gt;/);
});

test('tree --full: branch fixture renders without error and keeps the totals row', () => {
  const session = loadBranchSession();
  const out = renderTree(session, { noColor: true, full: true, responses: true });
  const lines = out.split('\n');
  expect(lines[lines.length - 3]).toMatch(/^─+$/);
  expect(lines[lines.length - 2]).toMatch(/\b5 prompts\b/);
});

test('tree: totals row sums durations and tokens for all 5 prompts', () => {
  const session = loadBranchSession();
  const out = renderTree(session, { noColor: true });
  const lines = out.split('\n');
  const totalsLine = lines[lines.length - 2] ?? '';

  // 5 turns, each 60s / 100 out / 10 in tokens.
  expect(totalsLine).toMatch(/\b5 prompts\b/);
  expect(totalsLine).toMatch(/5m/); // sum of turn durations (5 * 1m)
  expect(totalsLine).toMatch(/↑\s*500/); // sum of output tokens
  expect(totalsLine).toMatch(/↓\s*50/); // sum of input tokens

  // a thin rule sits directly above the totals line.
  const ruleLine = lines[lines.length - 3] ?? '';
  expect(ruleLine).toMatch(/^─+$/);
});

function makeFullFixtureSession(): { session: Session; prompt: string; turn: Turn } {
  const para1 =
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight nine ten';
  const para2 =
    'second paragraph here with more words to fill out the four hundred character budget nicely and completely so wrapping across many continuation lines can be verified thoroughly end to end';
  const prompt = `${para1}\n\n${para2}`;
  expect(prompt.length >= 400).toBeTruthy();

  const t = new Turn({
    id: 'full0001'.slice(0, 7),
    fullId: 'u1',
    parentId: null,
    agent: 'claude',
    tsMicros: 1788000000000000,
    prompt,
  });
  t.response =
    'a short response text that is also long enough to wrap across a couple of continuation lines when printed in full mode';
  const cmd = new Turn({
    id: 'cmd00001'.slice(0, 7),
    fullId: 'u2',
    parentId: 'u1',
    agent: 'claude',
    tsMicros: 1788000000001000,
    prompt: `/some-command ${'with-a-very-long-argument-list '.repeat(10)}end-of-args`,
    isCommand: true,
  });
  const session = new Session({
    id: 'c86e0429-3e3b-4f17-8262-35a6f0c85599',
    agent: 'claude',
    path: '/x',
    cwd: '/y',
    startedMicros: 1788000000000000,
    turns: [t, cmd],
    roots: ['u1'],
  });
  return { session, prompt, turn: t };
}

test('tree --full: every word of a long multi-paragraph prompt appears, no … on that node', () => {
  const { session, prompt } = makeFullFixtureSession();
  const out = renderTree(session, { noColor: true, full: true });

  expect(out.includes('…')).toBeFalsy(); // no ellipsis truncation anywhere with --full

  // The node-line/body cut is a raw width cut (not word-boundary aware), so
  // a word can straddle the cut between the node line and its first
  // continuation line. Compare with whitespace stripped so re-flowed
  // spacing/line-breaks don't matter, only that no character was dropped.
  const lines = out.split('\n');
  const nodeIdx = lines.findIndex((l) => l.includes('alpha bravo') || l.includes(' alpha'));
  expect(nodeIdx >= 0).toBeTruthy(); // expected to find the node line
  const nodeLine = lines[nodeIdx] ?? '';
  const col = nodeLine.indexOf('alpha');
  const region = [nodeLine.slice(col)];
  for (let i = nodeIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!/^\s/.test(line) && line !== '') break; // end of this turn's block
    region.push(line);
  }
  const flattened = region.join('').replace(/\s+/g, '');
  expect(flattened).toBe(prompt.replace(/\s+/g, '')); // no dropped or duplicated characters
});

test('tree --full: continuation lines start at the prompt column', () => {
  const { session } = makeFullFixtureSession();
  const out = renderTree(session, { noColor: true, full: true, width: 100 });
  const lines = out.split('\n');

  const nodeLineIdx = lines.findIndex((l) => l.includes('alpha bravo'));
  expect(nodeLineIdx >= 0).toBeTruthy(); // expected to find the node line for the long prompt
  const nodeLine = lines[nodeLineIdx] ?? '';
  const col = nodeLine.indexOf('alpha');
  expect(col > 0).toBeTruthy(); // expected to locate where the prompt text starts

  const continuation = lines[nodeLineIdx + 1];
  expect(continuation).toBeTruthy(); // expected a continuation line after the node line
  const leadingSpaces = (continuation ?? '').match(/^ */)?.[0].length ?? 0;
  expect(leadingSpaces).toBe(col); // continuation line should start at the prompt column
});

test('tree --full --width 80 wraps body lines to <= 80 visible columns', () => {
  const { session } = makeFullFixtureSession();
  const out = renderTree(session, { noColor: true, full: true, width: 80 });
  for (const line of out.split('\n')) {
    expect(line.length <= 80).toBeTruthy();
  }
});

test('tree --full --responses shows a response marker and the full response text', () => {
  const { session, turn } = makeFullFixtureSession();
  const out = renderTree(session, { noColor: true, full: true, responses: true });
  expect(out.includes('── response ──')).toBeTruthy();
  for (const w of (turn.response ?? '').split(/\s+/).filter(Boolean)) {
    expect(out.includes(w)).toBeTruthy();
  }
});

test('tree --full: slash-command turns have no body', () => {
  const { session } = makeFullFixtureSession();
  const out = renderTree(session, { noColor: true, full: true });
  const lines = out.split('\n');
  const cmdIdx = lines.findIndex((l) => l.includes('/some-command'));
  expect(cmdIdx >= 0).toBeTruthy(); // expected to find the command node line
  expect(!lines.includes('end-of-args') && !lines.some((l) => /^\s+.*end-of-args/.test(l))).toBeTruthy(); // command body text should never flow onto a continuation line
  // the very next line should be the totals rule or another node/connector
  // line, never an indented continuation of the command's own text.
  const next = lines[cmdIdx + 1];
  expect(next !== undefined).toBeTruthy();
  expect(!/^\s+with-a-very-long/.test(next ?? '')).toBeTruthy();
});

test('tree: -n 2 shows totals for the shown turns, annotated "2 of 5"', () => {
  const session = loadBranchSession();
  const out = renderTree(session, { noColor: true, limit: 2 });
  const lines = out.split('\n');
  const totalsLine = lines[lines.length - 2] ?? '';

  expect(totalsLine).toMatch(/\b2 of 5 prompts\b/);
  expect(totalsLine).toMatch(/↑\s*200/); // sum of output tokens for the 2 shown turns
  expect(totalsLine).toMatch(/↓\s*20/); // sum of input tokens for the 2 shown turns
});

// --------------------------------------------------------------------------
// Renderer contract: one session, every surface, the same totals
// --------------------------------------------------------------------------

/** Two turns with subagent blocks attached by hand, plus one unattributed
 * child on the session, so own != total and the `+N agents` count is 3. */
function makeSubagentSession(): {
  session: Session;
  expect: {
    ownOut: number;
    subOut: number;
    totalOut: number;
    ownIn: number;
    subIn: number;
    totalIn: number;
    agents: number;
  };
} {
  const t1 = new Turn({
    id: 'aaa1111',
    fullId: 'u1',
    parentId: null,
    agent: 'claude',
    tsMicros: 1788000000000000,
    prompt: 'first prompt',
  });
  t1.outputTokens = 1000;
  t1.thinkingTokens = 200;
  t1.inputTokens = 10;
  t1.cacheReadTokens = 20;
  t1.cacheWriteTokens = 30;
  t1.durationS = 60;
  t1.subagents = {
    ...zeroSubagents(),
    count: 2,
    output: 100,
    thinking: 10,
    input: 50,
    cacheRead: 5,
    cacheWrite: 1,
    linkage: 'exact',
  };
  const t2 = new Turn({
    id: 'bbb2222',
    fullId: 'u2',
    parentId: 'u1',
    agent: 'claude',
    tsMicros: 1788000060000000,
    prompt: 'second prompt',
  });
  t2.outputTokens = 2000;
  t2.thinkingTokens = 300;
  t2.inputTokens = 40;
  t2.durationS = 30;
  t1.children = ['u2']; // the parser fills this in; Mermaid walks the tree by it
  const session = new Session({
    id: 'c86e0429-3e3b-4f17-8262-35a6f0c85599',
    agent: 'claude',
    path: '/x',
    cwd: '/y',
    startedMicros: 1788000000000000,
    turns: [t1, t2],
    roots: ['u1'],
  });
  session.subagentsUnattributed = { ...zeroSubagents(), count: 1, output: 400, thinking: 40, input: 7 };
  // own ↑ = 1000+200 + 2000+300 = 3500; sub ↑ = 100+10 + 400+40 = 550; total 4050.
  // own ↓ = 10+20+30 + 40 = 100; sub ↓ = 50+5+1 + 7 = 63; total 163.
  return {
    session,
    expect: { ownOut: 3500, subOut: 550, totalOut: 4050, ownIn: 100, subIn: 63, totalIn: 163, agents: 3 },
  };
}

test('contract: tree header, status line, status JSON, HTML header and Mermaid header all report the same ↑ total and agent count', () => {
  const { session, expect: e } = makeSubagentSession();

  const tot = totalsWithSubagents(session.turns, session.subagentsUnattributed);
  expect(tot.own.output).toBe(e.ownOut); // own output includes thinking
  expect(tot.sub.output).toBe(e.subOut); // subagent output includes thinking (attributed + unattributed)
  expect(tot.total.output).toBe(e.totalOut);
  expect(tot.own.input).toBe(e.ownIn);
  expect(tot.sub.input).toBe(e.subIn);
  expect(tot.total.input).toBe(e.totalIn);
  expect(tot.count).toBe(e.agents);

  const up = `↑${humanizeNumber(e.totalOut)}`;
  const down = `↓${humanizeNumber(e.totalIn)}`;
  const agents = `+${e.agents} agents`;

  // tree header
  const treeHead = renderTree(session, { noColor: true, width: 200 }).split('\n')[0] ?? '';
  expect(treeHead.includes(`${up} ${down} (${agents})`)).toBeTruthy();

  // status line + JSON
  const status = renderStatus(session);
  expect(status.includes(`${up} ${down}`)).toBeTruthy();
  expect(status).toMatch(new RegExp(`· \\+${e.agents} agents$`));
  const stats = statusStats(session);
  expect(stats.out).toBe(e.totalOut);
  expect(stats.ownOut).toBe(e.ownOut);
  expect(stats.subagentOut).toBe(e.subOut);
  expect(stats.in).toBe(e.totalIn);
  expect(stats.ownIn).toBe(e.ownIn);
  expect(stats.subagentIn).toBe(e.subIn);
  expect(stats.subagents).toBe(e.agents);
  expect(stats.out).toBe(stats.ownOut + stats.subagentOut); // JSON fields are one definition

  // HTML header + per-card clause
  const frag = renderFragment(session);
  const headerHtml = frag.match(/<div class="header">([^<]*)<\/div>/)?.[1] ?? '';
  expect(headerHtml.includes(`${up} ${down} (${agents})`)).toBeTruthy();
  expect(frag).toMatch(/<span class="agents">\+2 agents ↑110 ↓56<\/span>/); // card shows its own subagents compactly
  expect((frag.match(/class="agents"/g) ?? []).length).toBe(1); // only the spawning card carries the clause
  expect(frag).toMatch(/<span class="tok out">↑1\.2k<\/span>/); // card rows keep own ↑ as the primary number

  // Mermaid header comment + per-commit clause
  const mm = renderMermaid(session, { raw: true });
  const mmHead = mm.split('\n')[1] ?? '';
  expect(mmHead).toMatch(/^\s*%% session c86e0429 · 2 prompts · /);
  expect(mmHead.includes(`${up} ${down} (${agents})`)).toBeTruthy();
  expect(mm).toMatch(/commit id: "aaa1111" tag: "1m · ↑1\.2k ↓60 \+2 agents ↑110 ↓56"/);
  expect(mm).toMatch(/commit id: "bbb2222" tag: "30s · ↑2\.3k ↓40"$/m);
});

test('contract: with no subagents, no renderer mentions agents and totals equal own', () => {
  const { session } = makeSubagentSession();
  for (const t of session.turns) t.subagents = zeroSubagents();
  session.subagentsUnattributed = zeroSubagents();

  expect(renderTree(session, { noColor: true, width: 200 })).not.toMatch(/agents/);
  expect(renderStatus(session)).not.toMatch(/agents/);
  // The stylesheet always declares the `.agents` rule; the content must not use it.
  expect(renderFragment(session).replace(/<style>[\s\S]*?<\/style>/, '')).not.toMatch(/agents/);
  expect(renderMermaid(session, { raw: true })).not.toMatch(/agents/);
  const stats = statusStats(session);
  expect(stats.out).toBe(stats.ownOut);
  expect(stats.out).toBe(3500); // own output includes thinking even without subagents
});

// --------------------------------------------------------------------------
// Fragment scope: a hostile session id cannot escape the CSS/JS scope
// --------------------------------------------------------------------------

test('fragment: a session id with CSS/HTML metacharacters yields a strict-alphabet root id and never leaks into <style> or <script>', () => {
  const hostile = 'x{}body<script>';
  const t = new Turn({
    id: 'abc1234',
    fullId: 'u1',
    parentId: null,
    agent: 'claude',
    tsMicros: 1788000000000000,
    prompt: 'hello',
  });
  const session = new Session({
    id: hostile,
    agent: 'claude',
    path: '/x',
    cwd: '/y',
    startedMicros: 1788000000000000,
    turns: [t],
    roots: ['u1'],
  });
  const frag = renderFragment(session);

  const m = frag.match(/<div id="(promptlog-[^"]*)">/);
  expect(m).toBeTruthy(); // root div present
  const rootId = m?.[1] ?? '';
  expect(rootId).toMatch(/^promptlog-[A-Za-z0-9_-]+$/);
  expect(rootId).toBe(`promptlog-${safeIdSuffix(hostile)}`);

  const css = frag.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  expect(css.includes('{}body')).toBeFalsy(); // id text does not appear in the stylesheet
  expect(css.includes('<script>')).toBeFalsy();
  // Every selector still scoped to the safe root id.
  const selectorRe = /([^{}]+)\{/g;
  let s: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: iterating regex matches.
  while ((s = selectorRe.exec(css))) {
    const sel = (s[1] ?? '').trim();
    expect(sel.includes(`#${rootId}`) || sel.startsWith('@media')).toBeTruthy();
  }

  const js = frag.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  expect(js.includes('{}body')).toBeFalsy(); // id text does not appear in the script
  expect(js.includes(`getElementById(${JSON.stringify(rootId)})`)).toBeTruthy();

  // The raw id never appears unescaped anywhere in the fragment; the header
  // shows its first 8 chars escaped.
  expect(frag.includes('<script>x')).toBeFalsy(); // no unescaped script tag from the id
  expect(frag.includes(hostile)).toBeFalsy(); // raw hostile id absent
  expect(frag).toMatch(/session x\{\}body&lt; · claude/);

  // The <title> of the full document is escaped too.
  const doc = renderHtml(session);
  expect(doc).toMatch(/<title>promptlog: x\{\}body&lt;<\/title>/);
});

test('safeIdSuffix: clean prefixes pass through, anything else falls back to a stable sha256 prefix', () => {
  expect(safeIdSuffix('c86e0429-3e3b-4f17')).toBe('c86e0429');
  expect(safeIdSuffix('abc_-XYZ')).toBe('abc_-XYZ');
  expect(safeIdSuffix('abcd')).toBe('abcd');
  expect(safeIdSuffix('abc')).toMatch(/^[0-9a-f]{8}$/); // shorter than 4 -> hash
  expect(safeIdSuffix('x{}body<script>')).toMatch(/^[0-9a-f]{8}$/);
  expect(safeIdSuffix('abcdefg.')).toMatch(/^[0-9a-f]{8}$/); // one dropped char -> hash
  expect(safeIdSuffix('x{}body<script>')).toBe(safeIdSuffix('x{}body<script>')); // stable
  expect(safeIdSuffix('')).toMatch(/^[0-9a-f]{8}$/);
  expect(safeIdSuffix(null)).toMatch(/^[0-9a-f]{8}$/);
});
