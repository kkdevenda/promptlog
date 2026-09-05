/**
 * Distribution-facing subcommands: `skill install|update|uninstall`.
 * See PLAN-v0.3.md §6/§7 phase 4 and DISTRIBUTION.md.
 *
 * Every handler is `async (args, ctx) => exitCode` where
 *   args = { values: {...}, positionals: [...] }   (node:util.parseArgs shape)
 *   ctx  = Ctx (src/core/util.ts)
 * matching the shape of commands/repo.ts.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agents, byId } from '../../agents';
import type { SkillScope } from '../../agents/types';
import { isDir, isFile } from '../fsutil';
import { arr, rec, str } from '../json';
import { skillDir } from '../paths';
import * as updateCheck from '../updateCheck';
import { type CommandArgs, type Ctx, envHome, err, out } from '../util';

const RECORD_DIR_NAME = '.promptlog';
const RECORD_FILE_NAME = 'skill-installs.json';
const STALENESS_STAMP_NAME = 'skill-staleness-checked';

// Known agent home directories that are not (yet) backed by an adapter in
// src/agents/. Reported by `skill install` and `doctor` as "detected, not
// supported yet"; never installed into. Keyed by id so that once an adapter
// with the same id is registered, it takes over and this entry is skipped
// automatically.
export const KNOWN_UNSUPPORTED: Array<{ id: string; displayName: string; dir: (home: string) => string }> = [
  { id: 'agents', displayName: 'Agents (~/.agents)', dir: (home) => path.join(home, '.agents') },
  { id: 'copilot', displayName: 'Copilot', dir: (home) => path.join(home, '.copilot') },
  { id: 'windsurf', displayName: 'Windsurf', dir: (home) => path.join(home, '.windsurf') },
  { id: 'opencode', displayName: 'OpenCode', dir: (home) => path.join(home, '.config', 'opencode') },
];

// ------------------------------------------------------------------ plumbing

export function homeOf(ctx: Ctx): string {
  return envHome(ctx.env);
}

export function tildeify(p: string, home: string): string {
  if (home && p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  if (home && p === home) return '~';
  return p;
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Copy `skillSrc` into `dest` atomically: build the full copy at a sibling
 * `<dest>.new` first, and only remove whatever was at `dest` (if anything)
 * once that copy has fully succeeded, then rename the new copy into place.
 * A failure partway through `copyDir` leaves the old `dest` untouched and
 * only a stray `<dest>.new` to clean up next time, never a half-written
 * `dest`.
 */
function installAtomic(skillSrc: string, dest: string): void {
  const tmp = `${dest}.new`;
  rmrf(tmp);
  copyDir(skillSrc, tmp);
  rmrf(dest);
  fs.renameSync(tmp, dest);
}

/*
 * A project-scope install (`--project`) copies the WHOLE skill, scripts/
 * included, into the repo's `.claude/skills/`, `.codex/skills/`,
 * `.cursor/skills/`. That is deliberate: a teammate's fresh clone must be
 * able to run `node .claude/skills/promptlog/scripts/promptlog.js` with
 * nothing preinstalled - SKILL.md tells the agent to run exactly that, and a
 * skill dir with no runtime is a broken skill. Users who do not want the
 * vendored runtime in their repository ignore it from their own root
 * .gitignore; the installer never writes one.
 */

/**
 * Locate the packed skill directory (the one containing SKILL.md and
 * scripts/promptlog.js) via `skillDir()`, so install works identically
 * whether we're running from a dev checkout or from an installed copy.
 */
export function findSkillSourceDir(): string | null {
  const dir = skillDir();
  return isFile(path.join(dir, 'SKILL.md')) ? dir : null;
}

/** Version to record/report: package.json's version if reachable two levels
 * above the skill dir (both in a dev checkout and an installed copy, package
 * root is skillDir/../..), else the SKILL.md frontmatter's `metadata.version`
 * (this is what an externally-installed copy - marketplace, npx skills add -
 * falls back to, since it has no sibling package.json). */
export function skillVersion(dir: string): string | null {
  try {
    const pkgPath = path.join(dir, '..', '..', 'package.json');
    const pkg = rec(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')));
    const version = str(pkg?.version);
    if (version) return version;
  } catch {
    // fall through
  }
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    // `metadata.version` (indented under `metadata:`) only.
    const m = /^[ \t]+version:\s*([0-9][^\s]*)/m.exec(md);
    if (m) return m[1] as string;
  } catch {
    // fall through
  }
  return null;
}

/** -1 / 0 / 1, comparing dotted version strings numerically per segment
 * (missing/non-numeric segments count as 0). Good enough for "is the copy
 * I'm running from behind" - not a full semver implementation (no
 * prerelease/build metadata handling), which this never needs. */
export function compareVersions(a: string | null, b: string | null): -1 | 0 | 1 {
  const pa = String(a || '0').split('.');
  const pb = String(b || '0').split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.parseInt(pa[i] as string, 10) || 0;
    const y = Number.parseInt(pb[i] as string, 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isPromptlogSkillDir(dir: string): boolean {
  try {
    const md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    return /^name:\s*promptlog\s*$/m.test(md);
  } catch {
    return false;
  }
}

function recordFilePath(home: string): string {
  return path.join(home, RECORD_DIR_NAME, RECORD_FILE_NAME);
}

interface InstallEntry {
  agent: string;
  scope: SkillScope;
  path: string;
  version: string | null;
  ts: string;
}

interface SkillInstallRecord {
  installs: InstallEntry[];
  shim: string | null;
}

export function readRecord(home: string): SkillInstallRecord {
  try {
    const raw = fs.readFileSync(recordFilePath(home), 'utf-8');
    const data = rec(JSON.parse(raw));
    const installs = arr(data?.installs)
      .map((i) => rec(i))
      .filter((i): i is NonNullable<typeof i> => i != null)
      .map(
        (i): InstallEntry => ({
          agent: str(i.agent) ?? '',
          scope: i.scope === 'project' ? 'project' : 'user',
          path: str(i.path) ?? '',
          version: str(i.version),
          ts: str(i.ts) ?? '',
        }),
      );
    return { installs, shim: str(data?.shim) };
  } catch {
    return { installs: [], shim: null };
  }
}

function writeRecord(home: string, record: SkillInstallRecord): void {
  const dir = path.dirname(recordFilePath(home));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordFilePath(home), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

/** Runs `node <dest>/scripts/promptlog.js env --json` from inside `dest`,
 * per PLAN-v0.3 §6: the installer self-checks each freshly installed copy. */
function selfCheck(dest: string): { ok: boolean; error?: string } {
  try {
    const script = path.join(dest, 'scripts', 'promptlog.js');
    const stdout = execFileSync(process.execPath, [script, 'env', '--json'], {
      cwd: dest,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    JSON.parse(stdout); // just confirm it ran and produced valid json
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One line, never a stack trace, for anything that goes wrong installing
 * into (or updating/removing) a single destination. */
function shortErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ExternalInstall {
  agent: string;
  displayName: string;
  scope: SkillScope;
  path: string;
  version: string | null;
}

/**
 * Skill directories that are already a promptlog skill (verified via
 * isPromptlogSkillDir) but are not among our own recorded installs - i.e.
 * they arrived via another channel (marketplace install, `npx skills add`,
 * a teammate's `--project` checkout, ...). Probed across both scopes for
 * every registered adapter. Never mutated by this function.
 */
export function findExternalInstalls(
  home: string,
  cwd: string,
  record: SkillInstallRecord,
): ExternalInstall[] {
  const recordedPaths = new Set(record.installs.map((i) => i.path));
  const externals: ExternalInstall[] = [];
  for (const adapter of agents()) {
    if (!adapter.capabilities.parse) continue;
    for (const scope of ['user', 'project'] as const) {
      let dirs: string[];
      try {
        dirs = adapter.skillDirs(scope, home, cwd) || [];
      } catch {
        dirs = [];
      }
      for (const dir of dirs) {
        const dest = path.join(dir, 'promptlog');
        if (recordedPaths.has(dest)) continue;
        if (!isDir(dest) || !isPromptlogSkillDir(dest)) continue;
        externals.push({
          agent: adapter.id,
          displayName: adapter.displayName,
          scope,
          path: dest,
          version: skillVersion(dest),
        });
      }
    }
  }
  return externals;
}

interface ManagedInstall {
  label: string;
  path: string;
  version: string | null;
  command: string;
}

/** Directories under which a plugin manager - not us - owns the skill copy's
 * lifecycle: `promptlog skill update` must list these, never overwrite them.
 * Kept in sync with `updateCheck.pluginManagerCommand`, which is what
 * classifies a given path as manager-owned (or not). */
function pluginManagerRoots(home: string): Array<{ label: string; root: string }> {
  return [
    { label: 'Claude Code (plugin)', root: path.join(home, '.claude', 'plugins') },
    { label: 'Codex CLI (plugin)', root: path.join(home, '.codex', 'plugins', 'cache') },
    { label: 'skills.sh', root: path.join(home, '.agents', 'skills') },
  ];
}

/** Every directory at or under `root` (bounded depth, so a huge cache tree
 * cannot make this run away) that directly contains a `SKILL.md` - the
 * search stops at the first one found down any branch, since a skill dir's
 * own subdirectories (scripts/, etc.) are never themselves skill dirs. */
function findSkillMdDirs(root: string, maxDepth = 8): string[] {
  const found: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      found.push(dir);
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  }
  if (isDir(root)) walk(root, 0);
  return found;
}

/**
 * Promptlog skill copies living inside a plugin manager's own cache/managed
 * directory (marketplace installs, skills.sh) - found by walking each
 * `pluginManagerRoots()` root directly, since these are not among any
 * adapter's `skillDirs()`. Never installed into or removed: `skill update`
 * and `doctor` list them with the owning manager's own upgrade command
 * (`updateCheck.pluginManagerCommand`) instead. `exclude` skips paths
 * already accounted for elsewhere (recorded installs, `findExternalInstalls`
 * results) so nothing is ever listed twice.
 */
export function findManagedInstalls(home: string, exclude: Set<string>): ManagedInstall[] {
  const managed: ManagedInstall[] = [];
  const seen = new Set<string>();
  for (const { label, root } of pluginManagerRoots(home)) {
    for (const dir of findSkillMdDirs(root)) {
      if (exclude.has(dir) || seen.has(dir)) continue;
      if (!isPromptlogSkillDir(dir)) continue;
      const command = updateCheck.pluginManagerCommand({ dirname: dir, home });
      if (!command) continue; // shouldn't happen given the root, but never guess
      seen.add(dir);
      managed.push({ label, path: dir, version: skillVersion(dir), command });
    }
  }
  return managed;
}

/**
 * PLAN-v0.3 §6 staleness hint: at most once a day (a date stamp file under
 * ~/.promptlog/), compare the version of the skill dir this invocation is
 * running from against the highest version among recorded installs and the
 * package itself; if this copy is behind, print one dim stderr line. Never
 * makes a network call, and never lets a problem here affect the real
 * command - every failure is swallowed.
 */
export function maybeStalenessHint(ctx: Ctx): void {
  try {
    const home = homeOf(ctx);
    const stampPath = path.join(home, RECORD_DIR_NAME, STALENESS_STAMP_NAME);
    const today = new Date().toISOString().slice(0, 10);
    let last: string | null = null;
    try {
      last = fs.readFileSync(stampPath, 'utf-8').trim();
    } catch {
      // no stamp yet
    }
    if (last === today) return;
    try {
      fs.mkdirSync(path.dirname(stampPath), { recursive: true });
      fs.writeFileSync(stampPath, today, 'utf-8');
    } catch {
      // best effort; still fine to check this run even if we can't record it
    }

    const skillSrc = findSkillSourceDir();
    if (!skillSrc) return;
    const running = skillVersion(skillSrc);
    if (!running) return;

    let highest = running;
    const record = readRecord(home);
    for (const entry of record.installs) {
      if (entry.version && compareVersions(entry.version, highest) > 0) highest = entry.version;
    }

    if (compareVersions(running, highest) < 0) {
      const line = `promptlog: skill ${running}, ${highest} installed elsewhere, run \`promptlog skill update\``;
      const dim = !ctx.env.NO_COLOR && Boolean((ctx.stderr as { isTTY?: boolean }).isTTY);
      err(ctx, dim ? `\x1b[2m${line}\x1b[0m` : line);
    }
  } catch {
    // the hint must never break a real command
  }
}

// ------------------------------------------------------------------ install

/**
 * Where `--path` writes the shim: a POSIX `sh` script named `promptlog` in
 * `~/.local/bin` everywhere except Windows, where it is `promptlog.cmd` in
 * `%LOCALAPPDATA%\promptlog\bin` (falling back to `~/.local/bin` when
 * `LOCALAPPDATA` is unset - some minimal shells don't have it).
 */
export function shimDir(home: string, { platform = process.platform, env = process.env } = {}): string {
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'promptlog', 'bin');
  }
  return path.join(home, '.local', 'bin');
}

/** The shim's filename: `promptlog.cmd` on Windows (so `cmd.exe` finds it
 * without a `.exe`/`.bat` extension check), `promptlog` everywhere else. */
export function shimName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'promptlog.cmd' : 'promptlog';
}

/** The shim's contents: a `.cmd` batch file on Windows, a POSIX `sh` script
 * everywhere else. `platform` is a parameter (not read from `process`
 * directly) so both bodies are unit-testable on any host. */
export function shimBody(script: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `@echo off\r\nnode "${script}" %*\r\n`;
  return `#!/usr/bin/env sh\nexec node "${script}" "$@"\n`;
}

export async function install(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const home = homeOf(ctx);
  const scope: SkillScope = v.project ? 'project' : 'user';
  const explicitAgents = v.agents
    ? String(v.agents)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const skillSrc = findSkillSourceDir();
  if (!skillSrc) {
    err(
      ctx,
      'promptlog: could not locate the packed skill directory (skills/promptlog) relative to this script',
    );
    return 1;
  }
  const version = skillVersion(skillSrc) || '0.0.0';

  const record = readRecord(home);
  const seenIds = new Set<string>();
  let anyInstalled = false;
  let exitCode = 0;

  for (const adapter of agents()) {
    seenIds.add(adapter.id);
    const detected = (() => {
      try {
        return adapter.detectInstalled(home);
      } catch {
        return false;
      }
    })();
    const named = !!explicitAgents?.includes(adapter.id);
    if (!detected && !named) continue;

    if (!adapter.capabilities.parse) {
      out(ctx, `${adapter.displayName}  detected, not supported yet`);
      continue;
    }

    let dirs: string[];
    try {
      dirs = adapter.skillDirs(scope, home, ctx.cwd) || [];
    } catch (e) {
      err(ctx, `${adapter.displayName}  error resolving skill directory: ${shortErrorMessage(e)}`);
      exitCode = 1;
      continue;
    }
    for (const dir of dirs) {
      const dest = path.join(dir, 'promptlog');

      // BLOCKER fix: never destroy a directory that isn't already ours.
      if (isDir(dest) && !isPromptlogSkillDir(dest)) {
        err(
          ctx,
          `${adapter.displayName}  refused: ${tildeify(dest, home)} already exists and is not a promptlog skill`,
        );
        exitCode = 1;
        continue;
      }

      try {
        installAtomic(skillSrc, dest);
        anyInstalled = true;

        record.installs = record.installs.filter((i) => i.path !== dest);
        record.installs.push({ agent: adapter.id, scope, path: dest, version, ts: new Date().toISOString() });

        const check = selfCheck(dest);
        out(
          ctx,
          `${adapter.displayName}  ${check.ok ? 'ok' : 'error'}  ${tildeify(dest, home)}  v${version}`,
        );
        if (!check.ok) exitCode = 1;
      } catch (e) {
        err(
          ctx,
          `${adapter.displayName}  error installing into ${tildeify(dest, home)}: ${shortErrorMessage(e)}`,
        );
        exitCode = 1;
      }
    }
  }

  for (const known of KNOWN_UNSUPPORTED) {
    if (seenIds.has(known.id)) continue; // an adapter now covers this id
    if (isDir(known.dir(home))) {
      out(ctx, `${known.displayName}  detected, not supported yet`);
    }
  }

  writeRecord(home, record);

  if (v.path) {
    const preferred =
      record.installs.find((i) => i.agent === 'claude') || record.installs.find((i) => i.agent === 'codex');
    if (preferred) {
      const binDir = shimDir(home);
      fs.mkdirSync(binDir, { recursive: true });
      const shimPath = path.join(binDir, shimName());
      const script = path.join(preferred.path, 'scripts', 'promptlog.js');
      try {
        if (process.platform === 'win32') {
          fs.writeFileSync(shimPath, shimBody(script));
        } else {
          fs.writeFileSync(shimPath, shimBody(script), { mode: 0o755 });
          fs.chmodSync(shimPath, 0o755);
        }
        record.shim = shimPath;
        writeRecord(home, record);
        // The path this prints is the PATH hint: it names wherever the shim
        // actually landed (~/.local/bin, or %LOCALAPPDATA%\promptlog\bin on
        // Windows), so add that directory, not a hardcoded one.
        out(ctx, `wrote shim: ${tildeify(shimPath, home)}`);
      } catch (e) {
        err(ctx, `promptlog: could not write shim ${tildeify(shimPath, home)}: ${shortErrorMessage(e)}`);
        exitCode = 1;
      }
    } else {
      err(ctx, 'promptlog: --path requested but nothing was installed to shim to');
      exitCode = 1;
    }
  }

  if (!anyInstalled && !v.path) {
    out(ctx, 'promptlog: no supported agents detected on this machine');
  }
  return exitCode;
}

// ------------------------------------------------------------------ update

/**
 * `promptlog skill update` refreshes every promptlog skill copy it can
 * find - both the ones it installed itself (`~/.promptlog/skill-installs.
 * json`) and external copies discovered the same way `skill install` looks
 * for a name clash (every registered adapter's `skillDirs('user'/'project')`
 * that already hold a promptlog `SKILL.md`) - matching what used to be
 * `--all`-only behaviour; `--all` is now a no-op alias kept for one release.
 * A copy inside a plugin manager's own cache (`findManagedInstalls`) is
 * never touched: it is listed with that manager's upgrade command instead.
 * `--dry-run` prints every line this command would print - "would update"
 * or "managed by <command>" - and writes nothing.
 */
export async function update(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const dryRun = Boolean(v['dry-run']);
  const home = homeOf(ctx);
  const skillSrc = findSkillSourceDir();
  if (!skillSrc) {
    err(
      ctx,
      'promptlog: could not locate the packed skill directory (skills/promptlog) relative to this script',
    );
    return 1;
  }
  const version = skillVersion(skillSrc) || '0.0.0';
  const record = readRecord(home);
  let exitCode = 0;

  if (!record.installs.length) {
    out(ctx, 'promptlog: nothing recorded to update; run `promptlog skill install` first');
  }

  /** One update line: `<label>  <path>  v<from> → v<to>[  would update|updated[ (self-check error)]]`. */
  function reportUpdate(label: string, dest: string, from: string | null, ok: boolean | null): void {
    const versions = `v${from || '?'} → v${version}`;
    const status = dryRun ? 'would update' : ok ? 'updated' : 'updated (self-check error)';
    out(ctx, `${label}  ${tildeify(dest, home)}  ${versions}  ${status}`);
  }

  function reportManaged(
    label: string,
    dest: string,
    installedVersion: string | null,
    command: string,
  ): void {
    out(ctx, `${label}  ${tildeify(dest, home)}  v${installedVersion || '?'}  managed by ${command}`);
  }

  const alreadyManaged = (dest: string): string | null =>
    updateCheck.pluginManagerCommand({ dirname: dest, home });

  for (const entry of record.installs) {
    const adapter = byId(entry.agent);
    const displayName = adapter ? adapter.displayName : entry.agent;
    const managedCommand = alreadyManaged(entry.path);
    if (managedCommand) {
      reportManaged(displayName, entry.path, entry.version, managedCommand);
      continue;
    }
    if (dryRun) {
      reportUpdate(displayName, entry.path, entry.version, null);
      continue;
    }
    try {
      installAtomic(skillSrc, entry.path);
      entry.version = version;
      entry.ts = new Date().toISOString();
      const check = selfCheck(entry.path);
      reportUpdate(displayName, entry.path, entry.version, check.ok);
      if (!check.ok) exitCode = 1;
    } catch (e) {
      err(ctx, `${displayName}  error updating ${tildeify(entry.path, home)}: ${shortErrorMessage(e)}`);
      exitCode = 1;
    }
  }
  if (!dryRun) writeRecord(home, record);

  const externals = findExternalInstalls(home, ctx.cwd, record);
  for (const ext of externals) {
    const managedCommand = alreadyManaged(ext.path);
    if (managedCommand) {
      reportManaged(ext.displayName, ext.path, ext.version, managedCommand);
      continue;
    }
    if (dryRun) {
      reportUpdate(ext.displayName, ext.path, ext.version, null);
      continue;
    }
    try {
      installAtomic(skillSrc, ext.path);
      const check = selfCheck(ext.path);
      reportUpdate(ext.displayName, ext.path, ext.version, check.ok);
      if (!check.ok) exitCode = 1;
    } catch (e) {
      err(
        ctx,
        `${ext.displayName}  error updating external ${tildeify(ext.path, home)}: ${shortErrorMessage(e)}`,
      );
      exitCode = 1;
    }
  }

  const exclude = new Set<string>([...record.installs.map((i) => i.path), ...externals.map((e) => e.path)]);
  for (const managed of findManagedInstalls(home, exclude)) {
    reportManaged(managed.label, managed.path, managed.version, managed.command);
  }

  return exitCode;
}

// ------------------------------------------------------------------ uninstall

export async function uninstall(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const home = homeOf(ctx);
  const record = readRecord(home);

  const kept: InstallEntry[] = [];
  for (const entry of record.installs) {
    if (!isDir(entry.path)) {
      // already gone; drop it from the record silently
      continue;
    }
    if (!isPromptlogSkillDir(entry.path)) {
      err(
        ctx,
        `promptlog: refusing to remove ${tildeify(entry.path, home)}: SKILL.md there is not promptlog's`,
      );
      kept.push(entry);
      continue;
    }
    try {
      rmrf(entry.path);
      out(ctx, `removed ${tildeify(entry.path, home)}`);
    } catch (e) {
      err(ctx, `promptlog: could not remove ${tildeify(entry.path, home)}: ${shortErrorMessage(e)}`);
      kept.push(entry);
    }
  }
  record.installs = kept;

  if (record.shim) {
    if (isFile(record.shim)) {
      try {
        rmrf(record.shim);
        out(ctx, `removed shim: ${tildeify(record.shim, home)}`);
      } catch (e) {
        err(ctx, `promptlog: could not remove shim ${tildeify(record.shim, home)}: ${shortErrorMessage(e)}`);
      }
    }
    record.shim = null;
  }

  writeRecord(home, record);

  const externals = findExternalInstalls(home, ctx.cwd, record);
  for (const ext of externals) {
    if (v.all) {
      try {
        rmrf(ext.path);
        out(ctx, `removed external: ${tildeify(ext.path, home)}`);
      } catch (e) {
        err(ctx, `promptlog: could not remove external ${tildeify(ext.path, home)}: ${shortErrorMessage(e)}`);
      }
    } else {
      out(
        ctx,
        `${ext.displayName}  installed (external)  ${tildeify(ext.path, home)}  v${ext.version || '?'}  (left alone; pass --all to remove it too)`,
      );
    }
  }

  return 0;
}
