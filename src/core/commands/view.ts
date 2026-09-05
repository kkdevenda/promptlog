/**
 * View commands: read-only rendering of the current session - `tree`,
 * `graph`, `last`, `sessions`, `env`, `json`, `mermaid`, `html`, `fragment`,
 * `show`, `grep`, `files`. Each handler resolves and parses its own session
 * (unlike OLD's `cli.js`, which resolved once and switched on the
 * subcommand); `commands/repo.ts`'s independent, transcript-free
 * `show`/`grep`/`files` (the "recall after the transcript aged out" path)
 * and its "── from repo ──" composition with these live-transcript results
 * are cli.ts's job, not this module's.
 */

import fs from 'node:fs';
import path from 'node:path';
import { byId } from '../../agents';
import * as git from '../git';
import { errorMessage, str } from '../json';
import type { Session, Turn } from '../model';
import { renderFragment, renderHtml } from '../renderHtml';
import { renderMermaid } from '../renderMermaid';
import { renderLast, renderLastAll, renderTree } from '../renderTree';
import { listCandidateSessions, resolveSession } from '../session';
import { attachSubagents } from '../subagents';
import {
  Colors,
  type CommandArgs,
  type Ctx,
  envHome,
  err,
  firstLine,
  humanizeDuration,
  humanizeNumber,
  localHHMM,
  localYMDHM,
  sourceLabel,
} from '../util';

function homeOf(ctx: Ctx): string {
  return envHome(ctx.env);
}

/** Parse a `-n`/`--width`-style flag: absent -> null, present -> the parsed
 * int (possibly NaN - the caller reports that). */
function parseIntFlag(v: unknown): number | null {
  const s = str(v);
  return s === null ? null : Number.parseInt(s, 10);
}

function useColor(ctx: Ctx, values: Record<string, unknown>): boolean {
  return !(values['no-color'] || ctx.env.NO_COLOR);
}

type SessionAttempt = { session: Session } | { error: string } | null;

/** Resolve + parse + attachSubagents for the current invocation: null when
 * nothing resolves, `{ error }` when a transcript was found but failed to
 * parse. */
function tryCurrentSession(values: Record<string, unknown>, ctx: Ctx): SessionAttempt {
  const resolved = resolveSession({
    agent: str(values.agent) || 'auto',
    session: str(values.session),
    cwd: ctx.cwd,
    env: ctx.env,
    home: homeOf(ctx),
  });
  if (!resolved.agent || !resolved.path) return null;
  const adapter = byId(resolved.agent);
  if (!adapter) return null;
  try {
    return { session: attachSubagents(adapter.parse(resolved.path), { home: homeOf(ctx), adapter }) };
  } catch (e) {
    return { error: `promptlog: failed to parse ${resolved.path}: ${errorMessage(e)}` };
  }
}

/** Resolve the current session and report why not, exactly as OLD's `cli.js`
 * did: "no session found" when nothing resolves, "failed to parse <path>:
 * <message>" when a transcript was found but couldn't be parsed. */
function parseCurrentSession(values: Record<string, unknown>, ctx: Ctx): Session | null {
  const attempt = tryCurrentSession(values, ctx);
  if (attempt === null) {
    err(ctx, 'promptlog: no session found');
    return null;
  }
  if ('error' in attempt) {
    err(ctx, attempt.error);
    return null;
  }
  return attempt.session;
}

/** Silent variant for cli.ts's `show`/`grep`/`files` repo-fallback branch,
 * which decides its own messaging ("no live transcript; searching the repo
 * only") when a live session isn't usable - and, when it is, passes the
 * already-parsed session through instead of resolving it twice. */
export function resolveCurrentSession(values: Record<string, unknown>, ctx: Ctx): Session | null {
  const attempt = tryCurrentSession(values, ctx);
  return attempt && 'session' in attempt ? attempt.session : null;
}

function writeFileOutput(ctx: Ctx, target: string, content: string): void {
  if (target === '-') {
    ctx.stdout.write(content);
  } else {
    fs.writeFileSync(target, content, { encoding: 'utf-8' });
    ctx.stdout.write(`${path.resolve(target)}\n`);
  }
}

// ------------------------------------------------------------------ tree / graph / last

export async function tree(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const found = parseCurrentSession(v, ctx);
  if (!found) return 1;
  const n = parseIntFlag(v.n);
  if (v.n !== undefined && Number.isNaN(n)) {
    err(ctx, `promptlog: argument -n: invalid int value: '${str(v.n)}'`);
    return 2;
  }
  let width: number | null = null;
  if (v.width !== undefined) {
    width = parseIntFlag(v.width);
    if (Number.isNaN(width)) {
      err(ctx, `promptlog: argument --width: invalid int value: '${str(v.width)}'`);
      return 2;
    }
  }
  ctx.stdout.write(
    renderTree(found, {
      reverse: Boolean(v.reverse),
      limit: n,
      verbose: Boolean(v.verbose),
      noColor: !useColor(ctx, v),
      responses: Boolean(v.responses),
      full: Boolean(v.full),
      width,
    }),
  );
  return 0;
}

export async function graph(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const found = parseCurrentSession(v, ctx);
  if (!found) return 1;
  const n = parseIntFlag(v.n);
  if (v.n !== undefined && Number.isNaN(n)) {
    err(ctx, `promptlog: argument -n: invalid int value: '${str(v.n)}'`);
    return 2;
  }
  let width: number | null = null;
  if (v.width !== undefined) {
    width = parseIntFlag(v.width);
    if (Number.isNaN(width)) {
      err(ctx, `promptlog: argument --width: invalid int value: '${str(v.width)}'`);
      return 2;
    }
  }
  const format = str(v.format) || 'auto';
  if (!['auto', 'ascii', 'mermaid'].includes(format)) {
    err(
      ctx,
      `promptlog: argument --format: invalid choice: '${format}' (choose from 'auto', 'ascii', 'mermaid')`,
    );
    return 2;
  }
  // One visual layout for every host (DESIGN.md "Agent surfaces"): 'auto'
  // always means ASCII now. Mermaid is explicit-only, via `--format mermaid`
  // or the `mermaid` subcommand - it rendered badly when auto-picked for a
  // "desktop" ui().
  const resolvedFormat = format === 'auto' ? 'ascii' : format;
  if (resolvedFormat === 'mermaid') {
    ctx.stdout.write(renderMermaid(found, { raw: Boolean(v.raw) }));
  } else {
    const outp = renderTree(found, {
      reverse: Boolean(v.reverse),
      limit: n,
      verbose: Boolean(v.verbose),
      noColor: !useColor(ctx, v),
      responses: Boolean(v.responses),
      full: Boolean(v.full),
      width,
    });
    ctx.stdout.write(v.fenced ? `\`\`\`text\n${outp}\`\`\`\n` : outp);
  }
  return 0;
}

export async function last(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const found = parseCurrentSession(v, ctx);
  if (!found) return 1;
  const colorsEnabled = useColor(ctx, v) && Boolean((ctx.stdout as { isTTY?: boolean }).isTTY);
  const responses = Boolean(v.responses);
  const arg = args.positionals[0];
  let outp: string;
  if (arg === 'all') {
    outp = renderLastAll(found, { colorsEnabled, responses });
  } else {
    const n = arg !== undefined ? Number.parseInt(arg, 10) : 1;
    if (arg !== undefined && (Number.isNaN(n) || !/^-?\d+$/.test(arg))) {
      err(ctx, "promptlog: last expects a number or 'all'");
      return 1;
    }
    const got = renderLast(found, n, { colorsEnabled, responses });
    if (!got) {
      err(ctx, 'promptlog: no such prompt');
      return 1;
    }
    outp = got;
  }
  ctx.stdout.write(outp);
  return 0;
}

// ------------------------------------------------------------------ json / mermaid / html / fragment

export async function json(args: CommandArgs, ctx: Ctx): Promise<number> {
  const found = parseCurrentSession(args.values, ctx);
  if (!found) return 1;
  ctx.stdout.write(`${JSON.stringify(found.toJSON(), null, 2)}\n`);
  return 0;
}

export async function mermaid(args: CommandArgs, ctx: Ctx): Promise<number> {
  const found = parseCurrentSession(args.values, ctx);
  if (!found) return 1;
  ctx.stdout.write(renderMermaid(found, { raw: Boolean(args.values.raw) }));
  return 0;
}

export async function html(args: CommandArgs, ctx: Ctx): Promise<number> {
  const found = parseCurrentSession(args.values, ctx);
  if (!found) return 1;
  const target = args.positionals[0];
  if (!target) {
    err(ctx, 'promptlog: html requires a file argument (or -)');
    return 2;
  }
  writeFileOutput(ctx, target, renderHtml(found, { responses: Boolean(args.values.responses) }));
  return 0;
}

export async function fragment(args: CommandArgs, ctx: Ctx): Promise<number> {
  const found = parseCurrentSession(args.values, ctx);
  if (!found) return 1;
  const target = args.positionals[0];
  if (!target) {
    err(ctx, 'promptlog: fragment requires a file argument (or -)');
    return 2;
  }
  writeFileOutput(ctx, target, renderFragment(found, { responses: Boolean(args.values.responses) }));
  return 0;
}

// ------------------------------------------------------------------ sessions

interface SessionSummary {
  id: string;
  agent: string;
  started: string | null;
  prompts: number;
  outputTokens: number;
  path: string;
}

/** Every transcript recorded for this project, across every registered
 * adapter (or only `--agent X`): a project is routinely worked on from more
 * than one agent, so this aggregates rather than stopping at the first
 * adapter that has files. */
export async function sessions(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const agent = str(v.agent);
  const located = listCandidateSessions({ cwd: ctx.cwd, home: homeOf(ctx) }).filter(
    (c) => !agent || agent === 'auto' || c.agent === agent,
  );
  if (!located.length) {
    err(ctx, 'promptlog: no sessions found for this project');
    return 1;
  }

  const summaries: Array<SessionSummary & { startedMicros: number | null }> = [];
  for (const loc of located) {
    const adapter = byId(loc.agent);
    if (!adapter) continue;
    let sess: Session;
    try {
      sess = adapter.parse(loc.path);
    } catch {
      continue;
    }
    summaries.push({
      id: sess.id,
      agent: loc.agent,
      started: sess.startedMicros != null ? localYMDHM(sess.startedMicros) : null,
      prompts: sess.turns.length,
      outputTokens: sess.turns.reduce((s, t) => s + t.outputTokens, 0),
      path: loc.path,
      startedMicros: sess.startedMicros,
    });
  }
  // Newest first across agents; sessions with no timestamp sink to the end.
  summaries.sort((a, b) => {
    if (a.startedMicros == null && b.startedMicros == null) return 0;
    if (a.startedMicros == null) return 1;
    if (b.startedMicros == null) return -1;
    return b.startedMicros - a.startedMicros;
  });

  if (v.json) {
    const clean: SessionSummary[] = summaries.map(({ startedMicros: _startedMicros, ...rest }) => rest);
    ctx.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
    return 0;
  }
  const agentWidth = Math.max(...summaries.map((s) => s.agent.length));
  for (const s of summaries) {
    ctx.stdout.write(
      `${s.id.slice(0, 8)}  ${s.agent.padEnd(agentWidth)}  ${s.started || '?'}  ${s.prompts} prompts  ${s.outputTokens} output tokens  ${s.path}\n`,
    );
  }
  return 0;
}

// ------------------------------------------------------------------ env

/** Does a hook dispatcher file for "prepare-commit-msg" exist and mention
 * "promptlog"? Checked in `.git/hooks/` and, if `core.hooksPath` is set,
 * there too. */
function hookInstalled(repoRootPath: string, home: string): boolean {
  const candidates: string[] = [];
  const hooksPath = git.configGet(repoRootPath, 'core.hooksPath');
  if (hooksPath) {
    const dir = hooksPath.startsWith('~') ? path.join(home, hooksPath.slice(1)) : hooksPath;
    candidates.push(
      path.join(path.isAbsolute(dir) ? dir : path.join(repoRootPath, dir), 'prepare-commit-msg'),
    );
  }
  candidates.push(path.join(repoRootPath, '.git', 'hooks', 'prepare-commit-msg'));
  for (const f of candidates) {
    try {
      if (fs.readFileSync(f, 'utf-8').includes('promptlog')) return true;
    } catch {
      // not present
    }
  }
  return false;
}

interface EnvInfo {
  agent: string | null;
  session: string | null;
  how: string | null;
  transcript: string | null;
  ui: string;
  repoRoot: string | null;
  enabled: string | null;
  hooksInstalled: boolean;
}

export async function env(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const resolved = resolveSession({
    agent: str(v.agent) || 'auto',
    session: str(v.session),
    cwd: ctx.cwd,
    env: ctx.env,
    home: homeOf(ctx),
  });
  const root = git.repoRoot(ctx.cwd);
  const enabled = root ? git.configGet(root, 'promptlog.enabled') : null;
  const hooks = root ? hookInstalled(root, homeOf(ctx)) : false;

  // `ui` mirrors what `graph`'s auto-format picks from: parse the resolved
  // transcript (best-effort - env should never fail just because ui() needs
  // a parsed session) and ask the adapter. 'unknown' when nothing resolved,
  // parsing failed, or the adapter has no signal.
  let ui = 'unknown';
  if (resolved.agent && resolved.path) {
    const adapter = byId(resolved.agent);
    if (adapter) {
      try {
        const session = adapter.parse(resolved.path);
        ui = adapter.ui({ session, env: ctx.env }) || 'unknown';
      } catch {
        ui = 'unknown';
      }
    }
  }

  const info: EnvInfo = {
    agent: resolved.agent,
    session: resolved.sessionId,
    how: resolved.how,
    transcript: resolved.path,
    ui,
    repoRoot: root,
    enabled,
    hooksInstalled: hooks,
  };

  if (v.json) {
    ctx.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return 0;
  }

  ctx.stdout.write(`agent:            ${info.agent || '(none found)'}\n`);
  ctx.stdout.write(`session:          ${info.session || '?'}\n`);
  ctx.stdout.write(`how:              ${info.how || '?'}\n`);
  ctx.stdout.write(`transcript:       ${info.transcript || '?'}\n`);
  ctx.stdout.write(`ui:               ${info.ui}\n`);
  ctx.stdout.write(`repo root:        ${info.repoRoot || 'not a git repo'}\n`);
  ctx.stdout.write(`promptlog.enabled: ${info.enabled == null ? '(not set)' : info.enabled}\n`);
  ctx.stdout.write(`hooks installed:  ${info.hooksInstalled}\n`);
  return 0;
}

// ------------------------------------------------------------------ show / grep / files
//
// Transcript-side only: searches the turns of the already-resolved current
// Session. cli.ts also calls commands/repo.ts's matching function (when the
// live transcript search found nothing, or in addition to it) and prints a
// divider between the two result sets - composing two independent command
// modules is cli.ts's job, not this one's.

/** Find the turn a `show <gid|shortId>` argument refers to, or null. It may
 * be a bare short id, a full id, a full-id prefix, or a global id
 * (`agent:sessionId8:shortId`) - only the trailing short id component of a
 * gid is matched against this session's turns. */
function findTurnForArg(session: Session, arg: string | undefined): Turn | null {
  if (!arg) return null;
  let needle = arg;
  const gidMatch = /^[a-zA-Z0-9_-]+:[0-9a-fA-F]+:([0-9a-zA-Z]+)$/.exec(arg);
  if (gidMatch) needle = gidMatch[1] as string;
  for (const t of session.turns) {
    if (t.id === needle || t.fullId === needle) return t;
  }
  for (const t of session.turns) {
    if (t.fullId?.startsWith(needle)) return t;
  }
  return null;
}

/** True if `arg` looks like a git commit sha (and isn't a known turn id) -
 * per DESIGN.md, a sha argument to `show` goes only to the repo side. */
function looksLikeSha(session: Session, arg: string | undefined): boolean {
  if (!arg) return false;
  if (!/^[0-9a-f]{7,40}$/i.test(arg)) return false;
  return findTurnForArg(session, arg) === null;
}

/** ` · +N agents ↑x ↓y` when the turn spawned subagents, else ''. The turn's
 * own out/in stay its own: this is an extra clause, never folded in. */
function subagentsClause(turn: Turn): string {
  const s = turn.subagents;
  if (!s.count) return '';
  return ` · +${s.count} agents ↑${humanizeNumber(s.output + s.thinking)} ↓${humanizeNumber(s.input + s.cacheRead + s.cacheWrite)}`;
}

function metricsLine(turn: Turn, colors: Colors): string {
  const outS = humanizeNumber(turn.outputTokens + turn.thinkingTokens);
  const inS = humanizeNumber(turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens);
  return (
    `[${colors.yellow(turn.id)} · ${colors.dim(localHHMM(turn.tsMicros))} · ` +
    `${humanizeDuration(turn.durationS)} · ${colors.green(`↑${outS} out`)} · ` +
    `${colors.blue(`↓${inS} in`)} · ${turn.toolCalls} tools${colors.dim(subagentsClause(turn))}]`
  );
}

/** Render `show` output for one turn: prompt, metrics line, source label,
 * and (with --responses) the response. */
function renderShow(
  turn: Turn,
  { responses = false, colors }: { responses?: boolean; colors: Colors },
): string {
  const lines: string[] = [];
  const tag = sourceLabel(turn);
  if (tag) lines.push(colors.dim(`[${tag}]`));
  lines.push(turn.prompt);
  lines.push('');
  lines.push(metricsLine(turn, colors));
  lines.push(colors.dim(`gid: ${turn.gid}`));
  if (responses) {
    lines.push('');
    lines.push('── response ──');
    if (turn.responsePending) {
      lines.push(colors.dim('[pending]'));
    } else if (turn.response) {
      lines.push(turn.response);
    } else {
      lines.push(colors.dim('(no response captured)'));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `grep <regex>`: turns whose prompt (or, with --responses, response)
 * matches. */
function renderGrep(
  session: Session,
  pattern: string,
  { responses = false, colors }: { responses?: boolean; colors: Colors },
): { text?: string; error?: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return { error: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }
  const matches = session.turns.filter((t) => {
    if (re.test(t.prompt)) return true;
    if (responses && t.response && re.test(t.response)) return true;
    return false;
  });
  if (!matches.length) return { text: '' };
  const lines: string[] = [];
  for (const t of matches) {
    const tag = sourceLabel(t);
    const tagStr = tag ? colors.dim(`[${tag}] `) : '';
    lines.push(
      `${colors.yellow(t.id)}  ${colors.dim(localHHMM(t.tsMicros))}  ${tagStr}${firstLine(t.prompt)}`,
    );
  }
  return { text: `${lines.join('\n')}\n` };
}

/** `files <path>`: turns whose recorded `files` set contains a path equal to
 * or ending with the given path (so a relative path matches an absolute
 * one). */
function renderFiles(session: Session, filePath: string, { colors }: { colors: Colors }): { text: string } {
  if (!filePath) return { text: '' };
  const needle = filePath.replace(/\/+$/, '');
  const matches = session.turns.filter((t) => {
    for (const f of t.files) {
      if (f === needle || f.endsWith(`/${needle}`) || path.basename(f) === needle) return true;
    }
    return false;
  });
  if (!matches.length) return { text: '' };
  const lines: string[] = [];
  for (const t of matches) {
    const tag = sourceLabel(t);
    const tagStr = tag ? colors.dim(`[${tag}] `) : '';
    lines.push(
      `${colors.yellow(t.id)}  ${colors.dim(localHHMM(t.tsMicros))}  ${tagStr}${firstLine(t.prompt)}`,
    );
  }
  return { text: `${lines.join('\n')}\n` };
}

/** `session`, when given, is a session cli.ts already resolved and parsed
 * (its show/grep/files repo-fallback branch) - passing it through skips a
 * second resolve+parse of the same transcript. */
export async function show(args: CommandArgs, ctx: Ctx, session?: Session): Promise<number> {
  const v = args.values;
  const found = session ?? parseCurrentSession(v, ctx);
  const arg = args.positionals[0];
  if (!found) return 1;
  const colors = new Colors(useColor(ctx, v));
  if (looksLikeSha(found, arg)) return 1; // a sha goes only to the repo side
  const turn = findTurnForArg(found, arg);
  if (!turn) {
    if (arg) err(ctx, `promptlog: no matching prompt for '${arg}' in the current transcript`);
    return 1;
  }
  ctx.stdout.write(renderShow(turn, { responses: Boolean(v.responses), colors }));
  return 0;
}

export async function grep(args: CommandArgs, ctx: Ctx, session?: Session): Promise<number> {
  const v = args.values;
  const pattern = args.positionals[0];
  if (!pattern) {
    err(ctx, 'promptlog: grep requires a regex argument');
    return 2;
  }
  const found = session ?? parseCurrentSession(v, ctx);
  if (!found) return 1;
  const colors = new Colors(useColor(ctx, v));
  const result = renderGrep(found, pattern, { responses: Boolean(v.responses), colors });
  if (result.error) {
    err(ctx, `promptlog: ${result.error}`);
    return 2;
  }
  if (result.text) {
    ctx.stdout.write(result.text);
    return 0;
  }
  return 1;
}

export async function files(args: CommandArgs, ctx: Ctx, session?: Session): Promise<number> {
  const v = args.values;
  const filePath = args.positionals[0];
  if (!filePath) {
    err(ctx, 'promptlog: files requires a path argument');
    return 2;
  }
  const found = session ?? parseCurrentSession(v, ctx);
  if (!found) return 1;
  const colors = new Colors(useColor(ctx, v));
  const result = renderFiles(found, filePath, { colors });
  if (result.text) {
    ctx.stdout.write(result.text);
    return 0;
  }
  return 1;
}

// Re-exported so a test can exercise the pure transcript-search functions
// without spawning the CLI.
export { findTurnForArg, looksLikeSha, renderFiles, renderGrep, renderShow };
