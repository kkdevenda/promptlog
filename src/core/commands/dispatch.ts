/**
 * `promptlog dispatch <hook> [--chain-dir D] [git hook args...]`: the body of
 * the generated hook files (see `installHooks` in `./repo.ts`). This is a
 * one-for-one Node port of the old shell hook dispatcher, so that a git hook
 * never depends on a POSIX shell being available - Git for Windows runs a
 * hook file through its shebang, and ours is `#!/usr/bin/env node`.
 *
 * Contract (DESIGN.md "Hooks"), same as the shell version:
 *   * promptlog's own work runs only when `git config --get promptlog.enabled`
 *     is true in this repo, and never at PROMPTLOG_DISPATCH_DEPTH >= 1;
 *   * it runs under a hard 2 s watchdog and its exit status is ignored;
 *   * whatever hook was there before still runs, in order, and ITS status is
 *     ours;
 *   * stdin is read only for hooks that are actually defined to receive it -
 *     reading it unconditionally would make `sleep 20 | git commit` hang.
 *
 * Re-entrancy: a chained hook (or promptlog's own `--amend`) can run git
 * again and re-enter this dispatcher. PROMPTLOG_DISPATCH_DEPTH suppresses
 * promptlog's own work at depth >= 1 but never suppresses chaining, and the
 * self-chain check compares canonical (symlink-resolved) paths, because git
 * may invoke the hook by a relative path.
 */

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as git from '../git';
import { entryPoint } from '../paths';
import { type CommandArgs, type Ctx, err } from '../util';

/** Hooks that actually receive data on stdin; everything else gets none. */
const STDIN_HOOKS = new Set([
  'post-rewrite',
  'pre-push',
  'post-receive',
  'pre-receive',
  'reference-transaction',
]);

const OWN_WATCHDOG_MS = 2000;

/** Absolute, symlink-resolved directory + literal basename for `p`, or null. */
function canon(p: string): string | null {
  try {
    const dir = fs.realpathSync(path.dirname(p));
    return path.join(dir, path.basename(p));
  } catch {
    return null;
  }
}

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function parseDepth(v: string | undefined): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * `PROMPTLOG_GIT_CMD`: the command line of our parent process, i.e. git
 * itself - the only signal that distinguishes `git commit --amend -m msg`
 * from a plain `commit -m` (DESIGN.md "The active turn"). Advisory only: any
 * failure yields ''.
 */
function computeGitCmd(): string {
  try {
    const ppid = process.ppid;
    if (!ppid) return '';
    if (process.platform === 'win32') {
      const r = spawnSync('wmic', ['process', 'where', `ProcessId=${ppid}`, 'get', 'CommandLine', '/value'], {
        timeout: 800,
        encoding: 'utf8',
      });
      if (r.status === 0 && r.stdout) {
        const m = /CommandLine=(.*)/.exec(r.stdout);
        if (m?.[1]) return m[1].trim();
      }
      // wmic is deprecated/absent on newer Windows builds; PowerShell's
      // Get-CimInstance is the fallback.
      const ps = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`],
        { timeout: 800, encoding: 'utf8' },
      );
      return ps.status === 0 && ps.stdout ? ps.stdout.trim() : '';
    }
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(ppid)], { timeout: 800, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return (r.stdout.split('\n')[0] ?? '').trim();
    return '';
  } catch {
    return '';
  }
}

/** Run a chained hook file (or `lefthook run <hook>`); never throws. */
function runChained(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: Buffer | undefined },
): number {
  const spawnOptions: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin ? 'pipe' : 'ignore', 'inherit', 'inherit'],
    input: opts.stdin,
  };
  let r: SpawnSyncReturns<string | Buffer>;
  try {
    r = spawnSync(file, args, spawnOptions);
  } catch {
    return 0;
  }
  if (r.error) return 0; // e.g. ENOENT (lefthook not on PATH): not a failure to report
  return r.status ?? 0;
}

/** Run `promptlog hook <name> [args]` as a child of the same bundle, 2 s
 * watchdog, stderr filtered to promptlog's own `promptlog:`-prefixed lines,
 * status always ignored. */
function runOwnWork(
  hookName: string,
  hookArgs: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin: Buffer | undefined },
  ctx: Ctx,
): void {
  try {
    const r = spawnSync(process.execPath, [entryPoint(), 'hook', hookName, ...hookArgs], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: OWN_WATCHDOG_MS,
      killSignal: 'SIGKILL',
      stdio: [opts.stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      input: opts.stdin,
      encoding: 'utf8',
    });
    const stderr = typeof r.stderr === 'string' ? r.stderr : '';
    for (const line of stderr.split('\n')) {
      if (line.startsWith('promptlog:')) err(ctx, line);
    }
  } catch {
    /* promptlog's own failures never block the commit */
  }
}

function readStdinSync(): Buffer {
  try {
    return fs.readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

export async function dispatch(args: CommandArgs, ctx: Ctx): Promise<number> {
  const positionals = args.positionals ?? [];
  const hookName = positionals[0];
  const hookArgs = positionals.slice(1);
  if (!hookName) return 0;
  const chainDirRaw =
    typeof args.values['chain-dir'] === 'string' ? (args.values['chain-dir'] as string) : '';

  try {
    return runDispatch(hookName, hookArgs, chainDirRaw, ctx);
  } catch {
    // A bug in the dispatcher itself must never block a commit.
    return 0;
  }
}

function runDispatch(hookName: string, hookArgs: string[], chainDirRaw: string, ctx: Ctx): number {
  const cwd = ctx.cwd;
  const env = ctx.env;

  const depth = parseDepth(env.PROMPTLOG_DISPATCH_DEPTH);
  const skipPromptlog = depth >= 1;
  const nextEnv: NodeJS.ProcessEnv = { ...env, PROMPTLOG_DISPATCH_DEPTH: String(depth + 1) };
  if (!nextEnv.PROMPTLOG_GIT_CMD) nextEnv.PROMPTLOG_GIT_CMD = computeGitCmd();

  const gdAbs = git.git(['rev-parse', '--absolute-git-dir'], { cwd });
  const gdRel = gdAbs.ok ? gdAbs : git.git(['rev-parse', '--git-dir'], { cwd });
  const gitDirRaw = gdRel.ok ? gdRel.stdout.trim() : '';
  if (!gitDirRaw) return 0;
  const gitDir = canon(path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(cwd, gitDirRaw)) ?? gitDirRaw;

  const topRaw = git.git(['rev-parse', '--show-toplevel'], { cwd });
  const top = topRaw.ok && topRaw.stdout.trim() ? topRaw.stdout.trim() : cwd;

  const takesStdin = STDIN_HOOKS.has(hookName);
  const stdinBuf = takesStdin ? readStdinSync() : undefined;

  if (!skipPromptlog && git.isEnabled(cwd)) {
    runOwnWork(hookName, hookArgs, { cwd, env: nextEnv, stdin: stdinBuf }, ctx);
  }

  // ---- chain to whatever else wants this hook ----------------------------
  let status = 0;
  const runOpts = { cwd, env: nextEnv, stdin: stdinBuf };
  const chain = (file: string, args: string[]): void => {
    const rc = runChained(file, args, runOpts);
    if (rc !== 0) status = rc;
  };

  const selfAbs = canon(process.argv[1] ?? '');
  const own = path.join(gitDir, 'hooks', hookName);
  const ownAbs = canon(own);

  let chainedOwn = false;
  let chainedOwnFile = false;
  const legacy = path.join(gitDir, 'hooks', `${hookName}.legacy`);
  if (isExecutable(legacy)) {
    chain(legacy, hookArgs);
    chainedOwn = true;
    for (let n = 1; n <= 20; n += 1) {
      const p = `${legacy}.${n}`;
      if (!isExecutable(p)) break;
      chain(p, hookArgs);
    }
  } else if (isExecutable(own) && ownAbs && ownAbs !== selfAbs) {
    chain(own, hookArgs);
    chainedOwn = true;
    chainedOwnFile = true;
  }

  // The hooks directory core.hooksPath pointed at before promptlog took it
  // over. Chained once, by canonical path, and never when it is this very
  // file or the .git/hooks/<name> already chained above.
  let chainDirAbs: string | null = null;
  if (chainDirRaw) {
    try {
      chainDirAbs = fs.realpathSync(chainDirRaw);
    } catch {
      chainDirAbs = null;
    }
    if (chainDirAbs) {
      const candidate = path.join(chainDirAbs, hookName);
      if (isExecutable(candidate)) {
        const candAbs = canon(candidate);
        if (candAbs && candAbs !== selfAbs && (!chainedOwnFile || candAbs !== ownAbs)) {
          chain(candidate, hookArgs);
          chainedOwn = true;
        }
      }
    }
  }

  // Skip the direct .husky/<name> chain when the previous hooks directory is
  // itself inside .husky: husky's own shim in that directory runs it already.
  let huskyAbs: string | null = null;
  try {
    huskyAbs = fs.realpathSync(path.join(top, '.husky'));
  } catch {
    huskyAbs = null;
  }
  const inHusky = Boolean(
    huskyAbs && chainDirAbs && (chainDirAbs === huskyAbs || chainDirAbs.startsWith(`${huskyAbs}${path.sep}`)),
  );
  if (!inHusky) {
    const huskyHook = path.join(top, '.husky', hookName);
    if (isExecutable(huskyHook)) chain(huskyHook, hookArgs);
  }

  // lefthook installs its own .git/hooks/<name>; if we already chained that,
  // running `lefthook run` too would fire every lefthook command twice.
  if (!chainedOwn) {
    const hasLefthookConfig = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'].some((f) =>
      fs.existsSync(path.join(top, f)),
    );
    if (hasLefthookConfig) chain('lefthook', ['run', hookName]);
  }

  return status;
}
