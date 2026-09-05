/**
 * `init` / `enable` / `disable`, and everything to do with `.gitattributes`
 * and the merge drivers it points at: registering them (`init`) and running
 * them (`merge-driver` / `merge-readme`, invoked by git itself).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from '../git';
import { errorMessage, isRecord } from '../json';
import { mergeSessionDocs } from '../merge';
import { entryPoint } from '../paths';
import type { SessionDoc } from '../records';
import { renderReadme } from '../renderReadme';
import {
  configPath,
  ensureConfig,
  findRepoRoot,
  initStore,
  readConfig,
  readmePath,
  STORE_DIR,
  writeConfig,
} from '../store';
import { reindex as storeReindex } from '../storeIndex';
import { type CommandArgs, type Ctx, err, out } from '../util';
import { bakedChainDir, effectiveHooksPath, holdsOurDispatchers, installHooks, samePath } from './hooks';
import { positionalsAfter, requireRoot, vals } from './repo';

/** POSIX shell single-quote a string for embedding in a `git config` value. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The `merge.<name>.driver` command line for `<action>` (`merge-driver` or
 * `merge-readme`), baking in the same absolute entry point the hooks use:
 * `<entry> <action> %O %A %B`. Git expands `%O`/`%A`/`%B` itself before
 * handing the line to `sh -c`.
 */
export function mergeDriverCommand(action: string): string {
  return `node ${shQuote(entryPoint())} ${action} %O %A %B`;
}

/**
 * Register the `.gitattributes` merge drivers `.gitattributes` itself points
 * at: `merge.promptlog.driver` for session documents, `merge.promptlog-
 * readme.driver` for the derived README. Best effort - a repo whose git
 * predates custom merge drivers just falls back to a text merge, which
 * conflicts more often but never corrupts a record.
 */
export function registerMergeDrivers(root: string): void {
  git.configSetLocal(root, 'merge.promptlog.name', 'promptlog session-document merge driver');
  git.configSetLocal(root, 'merge.promptlog.driver', mergeDriverCommand('merge-driver'));
  git.configSetLocal(root, 'merge.promptlog-readme.name', 'promptlog README merge driver');
  git.configSetLocal(root, 'merge.promptlog-readme.driver', mergeDriverCommand('merge-readme'));
}

export async function init(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;

  const config = initStore(root);
  if (values.notes) {
    config.notes = true;
    writeConfig(root, config);
    git.notesConfigure(root);
  }

  // The index is a local, lazily rebuilt cache and must never be committed:
  // drop it from a prior version's commit if it is still tracked.
  // `--ignore-unmatch` makes this a no-op the vast majority of the time (a
  // fresh `init`, or one already run under v0.3).
  git.git(['rm', '--cached', '-q', '--ignore-unmatch', `${STORE_DIR}/index.jsonl`], { cwd: root });
  registerMergeDrivers(root);

  // Hooks. promptlog only ever writes into $GIT_DIR/hooks or
  // ~/.promptlog/hooks. When core.hooksPath already points somewhere else
  // (husky, lefthook, a hand-rolled hook manager - at any config scope),
  // git ignores $GIT_DIR/hooks entirely, so a plain install there would be
  // a silent no-op; and a global install that just overwrote
  // core.hooksPath would silence that manager. Either way we take
  // core.hooksPath over and bake the previous directory in as
  // PROMPTLOG_CHAIN_DIR, so its hooks keep running through the dispatcher.
  let hookDir: string;
  if (values.global) {
    hookDir = path.join(os.homedir(), '.promptlog', 'hooks');
    const prevRaw = git.git(['config', '--global', '--path', '--get', 'core.hooksPath'], { cwd: root });
    let prev = prevRaw.ok && prevRaw.stdout.trim() ? prevRaw.stdout.trim() : null;
    if (prev && !path.isAbsolute(prev)) {
      // Relative to whichever worktree happens to be current - meaningless
      // as a user-wide setting, but not ours to second-guess: chained as
      // written.
      err(ctx, `promptlog: global core.hooksPath "${prev}" is relative; chaining to it as written`);
    }
    if (prev && samePath(prev, hookDir)) prev = null;
    installHooks(hookDir, { renameExisting: false, chainDir: prev || bakedChainDir(hookDir) });
    const r = git.git(['config', '--global', 'core.hooksPath', hookDir], { cwd: root });
    if (!r.ok) {
      err(ctx, `promptlog: could not set core.hooksPath: ${r.stderr.trim()}`);
      return 1;
    }
    if (prev)
      out(
        ctx,
        `promptlog: core.hooksPath was ${prev}; git now uses ${hookDir} and chains to the previous hooks`,
      );
  } else {
    const gd = git.git(['rev-parse', '--git-dir'], { cwd: root });
    const gitDir = gd.ok ? path.resolve(root, gd.stdout.trim()) : path.join(root, '.git');
    hookDir = path.join(gitDir, 'hooks');
    const prev = effectiveHooksPath(root);
    if (!prev || samePath(prev, hookDir)) {
      installHooks(hookDir, { renameExisting: true, chainDir: bakedChainDir(hookDir) });
    } else if (holdsOurDispatchers(prev)) {
      // Our own (global) dispatchers already run here and already chain
      // .git/hooks/<name>; a second copy would only record every commit
      // twice.
      out(ctx, `promptlog: hooks already active via ${prev} (core.hooksPath); nothing to install`);
      hookDir = prev;
    } else {
      installHooks(hookDir, { renameExisting: true, chainDir: prev });
      const r = git.git(['config', '--local', 'core.hooksPath', hookDir], { cwd: root });
      if (!r.ok) {
        err(ctx, `promptlog: could not set core.hooksPath: ${r.stderr.trim()}`);
        return 1;
      }
      out(
        ctx,
        `promptlog: core.hooksPath was ${prev}; this repo now uses ${hookDir} and chains to the previous hooks`,
      );
    }
  }

  git.configSetLocal(root, 'promptlog.enabled', 'true');
  storeReindex(root);
  if (config.readme !== false) renderReadme(root);

  out(ctx, `promptlog: store at ${path.join(root, STORE_DIR)}`);
  out(ctx, `promptlog: hooks in ${hookDir}${values.global ? ' (global core.hooksPath)' : ''}`);
  out(ctx, 'promptlog: promptlog.enabled=true for this repo');
  if (values.notes) out(ctx, `promptlog: mirroring to ${git.NOTES_REF}`);
  return 0;
}

export async function enable(_args: CommandArgs, ctx: Ctx): Promise<number> {
  const root = requireRoot(ctx);
  if (!root) return 1;
  git.configSetLocal(root, 'promptlog.enabled', 'true');
  const cfg = ensureConfig(root);
  cfg.enabled = true;
  writeConfig(root, cfg);
  out(ctx, 'promptlog: enabled for this repo');
  return 0;
}

export async function disable(_args: CommandArgs, ctx: Ctx): Promise<number> {
  const root = requireRoot(ctx);
  if (!root) return 1;
  git.configSetLocal(root, 'promptlog.enabled', 'false');
  if (fs.existsSync(configPath(root))) {
    const cfg = readConfig(root);
    cfg.enabled = false;
    writeConfig(root, cfg);
  }
  out(ctx, 'promptlog: disabled for this repo');
  return 0;
}

// ------------------------------------------------------------ merge drivers

interface ReadDocResult {
  doc?: Partial<SessionDoc> | null;
  failed?: boolean;
}

/**
 * Read one of git's three blobs.
 *
 *   { doc }            parsed (or legitimately absent: `%O` does not exist
 *                      for an add/add merge, and git can hand us an empty
 *                      blob for a file created on both sides)
 *   { failed: true }   the file exists, has content, and is NOT a session
 *                      document
 *
 * The distinction is the whole safety property of this driver: falling
 * back to `{}` for an unreadable blob turns a corrupt merge into a silent
 * "resolution" that DISCARDS every turn on that side.
 */
function readSessionDocBlob(f: string | undefined, { required }: { required: boolean }): ReadDocResult {
  if (!f) return required ? { failed: true } : { doc: null };
  let text: string;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    // A missing base is normal; a missing ours/theirs is not.
    return required ? { failed: true } : { doc: null };
  }
  if (!text.trim()) return { doc: null }; // empty blob: nothing to union in
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { failed: true };
  }
  // Deliberately lenient, matching OLD: a merge input only has to be a
  // record - mergeSessionDocs reads every field defensively, so it need
  // not be a COMPLETE session document the way `readSessionDoc()` (store.ts,
  // strict) requires for our own on-disk files.
  if (!isRecord(raw)) return { failed: true };
  return { doc: raw as Partial<SessionDoc> }; // narrowed as far as isRecord can; see comment above
}

/**
 * `promptlog merge-driver <base> <ours> <theirs>` - the `merge.promptlog
 * .driver` command `.gitattributes` registers for `.promptlog/sessions/*
 * .json`. Reads the three blobs git handed us (`base` may not exist: an
 * add/add case), unions them with `src/core/merge.ts`, and writes the
 * result back to `ours` - which git treats as the merge resolution when
 * this process exits 0.
 *
 * Any failure to read or merge the documents leaves `ours` untouched and
 * exits non-zero: git falls back to its normal conflict handling rather
 * than risk silently dropping a session's turns.
 */
export async function mergeDriver(args: CommandArgs, ctx: Ctx): Promise<number> {
  const rest = positionalsAfter(args, 'merge-driver');
  const [baseFile, oursFile, theirsFile] = rest;
  if (!oursFile) {
    err(ctx, 'usage: promptlog merge-driver <base> <ours> <theirs>');
    return 2;
  }

  const base = readSessionDocBlob(baseFile, { required: false });
  const ours = readSessionDocBlob(oursFile, { required: true });
  const theirs = readSessionDocBlob(theirsFile, { required: true });
  for (const [name, r] of [
    ['base', base],
    ['ours', ours],
    ['theirs', theirs],
  ] as const) {
    if (!r.failed) continue;
    // Leave `ours` exactly as git wrote it and fail: git then reports a
    // normal merge conflict for a human to look at, which is the only
    // honest outcome for a session document we cannot read.
    err(ctx, `promptlog: merge-driver: ${name} is not a readable session document, leaving the conflict`);
    return 1;
  }
  let merged: Partial<SessionDoc>;
  try {
    merged = mergeSessionDocs(base.doc ?? null, ours.doc ?? {}, theirs.doc ?? {});
  } catch (e) {
    err(ctx, `promptlog: merge-driver failed (${errorMessage(e)})`);
    return 1;
  }
  try {
    fs.writeFileSync(oursFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch (e) {
    err(ctx, `promptlog: merge-driver could not write the result (${errorMessage(e)})`);
    return 1;
  }
  return 0;
}

/**
 * `promptlog merge-readme <base> <ours> <theirs>` - the `merge.promptlog
 * -readme.driver` command for `.promptlog/README.md`. The README is
 * entirely derived, so the driver ignores the three text blobs it is
 * handed and just regenerates it from whatever session documents are on
 * disk at merge time, writing the result to `ours`. A commit's own
 * `post-commit` hook regenerates it properly afterwards regardless, so
 * this only needs to avoid a spurious text conflict, not be exact.
 */
export async function mergeReadme(args: CommandArgs, ctx: Ctx): Promise<number> {
  const rest = positionalsAfter(args, 'merge-readme');
  const [, oursFile] = rest;
  const root = findRepoRoot(ctx.cwd);
  if (!root || !oursFile) {
    err(ctx, 'usage: promptlog merge-readme <base> <ours> <theirs>');
    return 2;
  }
  try {
    renderReadme(root);
    fs.writeFileSync(oursFile, fs.readFileSync(readmePath(root), 'utf8'), 'utf8');
  } catch (e) {
    err(ctx, `promptlog: merge-readme failed (${errorMessage(e)})`);
    return 1;
  }
  return 0;
}
