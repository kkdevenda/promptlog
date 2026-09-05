/**
 * `doctor`. See PLAN-v0.3.md §6/§7 phase 4 and DISTRIBUTION.md.
 *
 * The handler is `async (args, ctx) => exitCode` where
 *   args = { values: {...}, positionals: [...] }   (node:util.parseArgs shape)
 *   ctx  = Ctx (src/core/util.ts)
 * matching the shape of commands/repo.ts.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agents } from '../../agents';
import type { SkillScope } from '../../agents/types';
import { isDir, isFile } from '../fsutil';
import { rec, str } from '../json';
import * as updateCheck from '../updateCheck';
import { type CommandArgs, type Ctx, out } from '../util';
import { bakedEntryPoint, HOOK_NAMES } from './hooks';
import {
  compareVersions,
  findExternalInstalls,
  findManagedInstalls,
  findSkillSourceDir,
  homeOf,
  KNOWN_UNSUPPORTED,
  readRecord,
  skillVersion,
  tildeify,
} from './skill';

function which(bin: string): string | null {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

interface RepoStatus {
  root: string | null;
  configPresent: boolean;
  enabled: string | null;
  hooksInstalled: boolean;
}

function repoStatus(cwd: string, home: string): RepoStatus {
  function git(gitArgs: string[]): string | null {
    try {
      return execFileSync('git', gitArgs, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }
  const root = git(['rev-parse', '--show-toplevel']);
  if (!root) return { root: null, configPresent: false, enabled: null, hooksInstalled: false };

  const configPresent = isFile(path.join(root, '.promptlog', 'config.json'));
  const enabled = git(['config', '--get', 'promptlog.enabled']);

  let hooksInstalled = false;
  const candidates: string[] = [];
  const hooksPath = git(['config', '--get', 'core.hooksPath']);
  if (hooksPath) {
    const dir = hooksPath.startsWith('~') ? path.join(home, hooksPath.slice(1)) : hooksPath;
    candidates.push(path.join(path.isAbsolute(dir) ? dir : path.join(root, dir), 'prepare-commit-msg'));
  }
  candidates.push(path.join(root, '.git', 'hooks', 'prepare-commit-msg'));
  for (const f of candidates) {
    try {
      if (fs.readFileSync(f, 'utf-8').includes('promptlog')) {
        hooksInstalled = true;
        break;
      }
    } catch {
      // not present
    }
  }
  return { root, configPresent, enabled, hooksInstalled };
}

/**
 * Every installed hook file (this repo's effective hooks dir, plus the
 * global `~/.promptlog/hooks`) whose baked promptlog.js path no longer
 * exists on disk (Grok finding P2). The hook file's own `require()` of that
 * path throws before it ever reaches the dispatcher, so this is the only
 * place left to warn about it - one line per broken hook file.
 */
function hookBakedPathWarnings(cwd: string, home: string): string[] {
  function git(gitArgs: string[]): string | null {
    try {
      return execFileSync('git', gitArgs, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }
  const dirs = new Set<string>();
  const root = git(['rev-parse', '--show-toplevel']);
  if (root) {
    const hooksPath = git(['config', '--get', 'core.hooksPath']);
    if (hooksPath) {
      const dir = hooksPath.startsWith('~') ? path.join(home, hooksPath.slice(1)) : hooksPath;
      dirs.add(path.isAbsolute(dir) ? dir : path.join(root, dir));
    } else {
      dirs.add(path.join(root, '.git', 'hooks'));
    }
  }
  dirs.add(path.join(home, '.promptlog', 'hooks'));

  const warnings: string[] = [];
  for (const dir of dirs) {
    for (const name of HOOK_NAMES) {
      const file = path.join(dir, name);
      if (!isFile(file)) continue;
      const baked = bakedEntryPoint(file);
      if (baked && !fs.existsSync(baked)) {
        warnings.push(`${tildeify(file, home)}: baked promptlog.js is missing (${tildeify(baked, home)})`);
      }
    }
  }
  return warnings;
}

export async function doctor(args: CommandArgs, ctx: Ctx): Promise<number> {
  const v = args.values;
  const home = homeOf(ctx);
  const record = readRecord(home);
  const externals = findExternalInstalls(home, ctx.cwd, record);
  const skillSrc = findSkillSourceDir();
  const runningVersion = skillSrc ? skillVersion(skillSrc) : null;
  const outdated = (version: string | null): boolean =>
    runningVersion != null && compareVersions(version, runningVersion) < 0;

  interface SkillInstallInfo {
    path: string;
    version: string | null;
    scope: SkillScope;
    present: boolean;
    external: boolean;
    outdated: boolean;
  }
  interface AgentInfo {
    id: string;
    displayName: string;
    installedOnMachine: boolean;
    parseCapable: boolean;
    skillInstalls: SkillInstallInfo[];
  }

  const agentsInfo: AgentInfo[] = [];
  const seenIds = new Set<string>();
  for (const adapter of agents()) {
    seenIds.add(adapter.id);
    let detected = false;
    try {
      detected = adapter.detectInstalled(home);
    } catch {
      detected = false;
    }
    const skillInstalls: SkillInstallInfo[] = record.installs
      .filter((i) => i.agent === adapter.id)
      .map((i) => ({
        path: i.path,
        version: i.version,
        scope: i.scope,
        present: isDir(i.path),
        external: false,
        outdated: outdated(i.version),
      }));
    for (const ext of externals) {
      if (ext.agent === adapter.id) {
        skillInstalls.push({
          path: ext.path,
          version: ext.version,
          scope: ext.scope,
          present: true,
          external: true,
          outdated: outdated(ext.version),
        });
      }
    }
    agentsInfo.push({
      id: adapter.id,
      displayName: adapter.displayName,
      installedOnMachine: detected,
      parseCapable: adapter.capabilities.parse,
      skillInstalls,
    });
  }
  for (const known of KNOWN_UNSUPPORTED) {
    if (seenIds.has(known.id)) continue;
    agentsInfo.push({
      id: known.id,
      displayName: known.displayName,
      installedOnMachine: isDir(known.dir(home)),
      parseCapable: false,
      skillInstalls: [],
    });
  }

  const binPath = which('promptlog');
  let binVersion: string | null = null;
  if (binPath) {
    try {
      const real = fs.realpathSync(binPath);
      // walk up from the resolved script looking for a package.json with a version
      let dir = path.dirname(real);
      for (let i = 0; i < 6 && dir; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (isFile(pkgPath)) {
          const pkg = rec(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')));
          const version = str(pkg?.version);
          if (version) {
            binVersion = version;
            break;
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // best effort
    }
  }

  const repo = repoStatus(ctx.cwd, home);
  const hookWarnings = hookBakedPathWarnings(ctx.cwd, home);

  const updateCheckDisabled = updateCheck.isDisabled({ env: ctx.env, values: v, home });
  const updateCheckCache = updateCheck.readUpdateCache(home);
  const updateCheckInfo = {
    enabled: !updateCheckDisabled,
    lastChecked:
      updateCheckCache?.checkedAt != null && Number.isFinite(updateCheckCache.checkedAt)
        ? new Date(updateCheckCache.checkedAt).toISOString()
        : null,
    latestSeen: updateCheckCache?.latest ?? null,
  };

  const recordedAndExternalPaths = new Set<string>([
    ...record.installs.map((i) => i.path),
    ...externals.map((e) => e.path),
  ]);
  const managedInstalls = findManagedInstalls(home, recordedAndExternalPaths).map((m) => ({
    ...m,
    outdated: outdated(m.version),
  }));

  const info = {
    agents: agentsInfo,
    managedInstalls,
    path: { binary: binPath, version: binVersion },
    repo,
    hookWarnings,
    updateCheck: updateCheckInfo,
  };

  if (v.json) {
    out(ctx, JSON.stringify(info, null, 2));
    return 0;
  }

  out(ctx, 'agents:');
  for (const a of agentsInfo) {
    const installedNote = a.installedOnMachine ? 'installed on machine' : 'not detected';
    out(ctx, `  ${a.displayName.padEnd(14)} ${installedNote}`);
    if (!a.parseCapable) {
      out(ctx, '                 not supported yet');
      continue;
    }
    if (!a.skillInstalls.length) {
      out(ctx, '                 skill: not installed');
    }
    for (const s of a.skillInstalls) {
      const label = s.external ? 'installed (external)' : 'skill';
      const note = !s.present
        ? ' (missing on disk)'
        : s.outdated
          ? ' (outdated; run `promptlog skill update`)'
          : '';
      out(ctx, `                 ${label}: ${tildeify(s.path, home)} v${s.version || '?'}${note}`);
    }
  }
  if (managedInstalls.length) {
    out(ctx, '  managed by other tools:');
    for (const m of managedInstalls) {
      const note = m.outdated ? ' (outdated; upgrade via the command below)' : '';
      out(ctx, `                 ${m.label}: ${tildeify(m.path, home)} v${m.version || '?'}${note}`);
      out(ctx, `                   upgrade: ${m.command}`);
    }
  }
  out(ctx, '');
  out(ctx, `PATH binary:     ${binPath ? `${binPath} v${binVersion || '?'}` : 'not found'}`);
  out(ctx, '');
  if (repo.root) {
    out(ctx, `repo:            ${repo.root}`);
    out(ctx, `  .promptlog/config.json present: ${repo.configPresent}`);
    out(ctx, `  promptlog.enabled:              ${repo.enabled == null ? '(not set)' : repo.enabled}`);
    out(ctx, `  hooks installed:                ${repo.hooksInstalled}`);
  } else {
    out(ctx, 'repo:            not inside a git repository');
  }
  if (hookWarnings.length) {
    out(ctx, '');
    out(ctx, 'hook warnings:');
    for (const w of hookWarnings) out(ctx, `  ${w}`);
  }
  out(ctx, '');
  out(ctx, `update check:    ${updateCheckInfo.enabled ? 'on' : 'off'}`);
  out(ctx, `  last checked:  ${updateCheckInfo.lastChecked || '(never)'}`);
  out(ctx, `  latest seen:   ${updateCheckInfo.latestSeen || '(none)'}`);

  return 0;
}
