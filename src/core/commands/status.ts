/**
 * `promptlog status` / `promptlog statusline` (see docs/DESIGN.md "Agent
 * surfaces" / README.md "Status line"). Host-neutral: Claude's statusLine
 * JSON shape is known only to src/agents/claude/statusline.ts, asked
 * through `capabilities.statusline` + `parseStatusInput` like any other
 * adapter capability.
 *
 * `statusline` must never break a status line: any error here is swallowed
 * and the command exits 0 printing nothing.
 */

import { agents, byId } from '../../agents';
import { rec, str } from '../json';
import { renderStatus, statusJson } from '../renderStatus';
import { resolveSession } from '../session';
import { attachSubagents } from '../subagents';
import { Colors, type CommandArgs, type Ctx, envHome, err } from '../util';

function homeOf(ctx: Ctx): string {
  return envHome(ctx.env);
}

export async function status(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const resolved = resolveSession({
    agent: str(v.agent) || 'auto',
    session: str(v.session),
    cwd: ctx.cwd,
    env: ctx.env,
    home: homeOf(ctx),
  });
  if (!resolved.agent || !resolved.path) {
    err(ctx, 'promptlog: no session found');
    return 1;
  }
  const adapter = byId(resolved.agent);
  if (!adapter) {
    err(ctx, 'promptlog: no session found');
    return 1;
  }
  let session: ReturnType<typeof adapter.parse>;
  try {
    session = attachSubagents(adapter.parse(resolved.path), { home: homeOf(ctx), adapter });
  } catch (e) {
    err(ctx, `promptlog: failed to parse ${resolved.path}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (v.json) {
    ctx.stdout.write(
      `${JSON.stringify(statusJson(session, { sessionId: resolved.sessionId, agent: resolved.agent }))}\n`,
    );
    return 0;
  }
  const noColor = Boolean(v['no-color']) || Boolean(ctx.env.NO_COLOR);
  const colors = new Colors(!noColor && Boolean((ctx.stdout as { isTTY?: boolean }).isTTY));
  ctx.stdout.write(`${renderStatus(session, { colors })}\n`);
  return 0;
}

/** Total time budget for `statusline`, milliseconds (DESIGN.md: "skip the
 * Cursor sidecar etc." - a status line must return fast). */
const DEADLINE_MS = 300;

/** Read all of stdin as utf-8, giving up (returning whatever arrived so
 * far) after `timeoutMs` rather than blocking forever on a stdin that
 * never closes. */
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    try {
      const stdin = process.stdin;
      stdin.setEncoding('utf-8');
      stdin.on('data', (chunk: string) => {
        data += chunk;
      });
      stdin.on('end', finish);
      stdin.on('error', finish);
      stdin.resume();
    } catch {
      finish();
    }
  });
}

/** Best-effort cwd guess from arbitrary stdin JSON, used only for the
 * "nothing recognised the input" fallback. */
function cwdFromJson(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = rec(data);
  if (!d) return null;
  return str(d.cwd) ?? str(rec(d.workspace)?.current_dir);
}

/** `promptlog statusline`: read stdin, ask every adapter that declares
 * `capabilities.statusline === true` to recognise it, resolve that session,
 * and print `renderStatus`. Falls back to `status` behaviour (using any cwd
 * found in the stdin JSON) when nothing recognises the input. Never throws,
 * never prints a stack trace, always exits 0 - a status line must never
 * break the host's own status line. */
export async function statusline(_args: CommandArgs, ctx: Ctx): Promise<number> {
  const start = Date.now();
  try {
    const remaining = () => Math.max(0, DEADLINE_MS - (Date.now() - start));
    const text = await readStdin(remaining());

    let matched: { agentId: string; sessionId: string; cwd: string | null } | null = null;
    for (const adapter of agents()) {
      if (!adapter.capabilities.statusline || !adapter.parseStatusInput) continue;
      let result: ReturnType<NonNullable<typeof adapter.parseStatusInput>> = null;
      try {
        result = adapter.parseStatusInput(text);
      } catch {
        result = null;
      }
      if (result?.sessionId) {
        matched = { agentId: adapter.id, sessionId: result.sessionId, cwd: result.cwd || null };
        break;
      }
    }

    const home = homeOf(ctx);
    const resolved = matched
      ? resolveSession({
          agent: matched.agentId,
          session: matched.sessionId,
          cwd: matched.cwd || ctx.cwd,
          env: ctx.env,
          home,
        })
      : resolveSession({
          agent: 'auto',
          session: null,
          cwd: cwdFromJson(text) || ctx.cwd,
          env: ctx.env,
          home,
        });

    if (!resolved.agent || !resolved.path) return 0;
    const adapter = byId(resolved.agent);
    if (!adapter) return 0;
    const session = attachSubagents(adapter.parse(resolved.path), { home, adapter });
    const colors = new Colors(false);
    ctx.stdout.write(`${renderStatus(session, { colors })}\n`);
    return 0;
  } catch {
    return 0;
  }
}
