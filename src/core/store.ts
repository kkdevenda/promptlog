/**
 * The repo store: `.promptlog/` inside a git repo.
 *
 *   .promptlog/config.json                     config, created with defaults
 *   .promptlog/sessions/<agent>-<sid8>.json    source of truth, one per session
 *   .promptlog/index.jsonl                     derived, one line per prompt
 *   .promptlog/README.md                       derived, mermaid + table
 *
 * Everything written here is redacted. `origin.promptHash` / `responseHash`
 * are sha256 of the ORIGINAL, unredacted text so `src/core/resolve.ts` can
 * tell "transcript still says the same thing" from "transcript was edited".
 *
 * This module owns layout and I/O only: paths, config, the write lock, and
 * atomic writes. `sessionRecords.ts` builds/merges the records that live at
 * those paths; `storeIndex.ts` owns `index.jsonl`; `renderReadme.ts` owns
 * `README.md`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as gitmod from './git';
import { num, rec } from './json';
import type { Turn } from './model';
import type { RedactConfig } from './redact';
import { envHome } from './util';

export const STORE_DIR = '.promptlog';
const VERSION = 1;

export interface StoreConfig {
  version: number;
  enabled: boolean;
  responses: 'final' | 'none';
  redact: RedactConfig;
  notes: boolean;
  readme: boolean;
}

export const DEFAULT_CONFIG: StoreConfig = {
  version: VERSION,
  enabled: true,
  responses: 'final',
  redact: { pasteLines: 40, pasteBytes: 4000, allow: [], deny: [], keepEmails: false },
  notes: false,
  readme: true,
};

export function sha256(s: string | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(s ?? '', 'utf8')
    .digest('hex');
}

export function machineId(): string {
  let user = '';
  try {
    user = os.userInfo().username || '';
  } catch {
    user = process.env.USER || '';
  }
  return sha256(`${os.hostname()}${user}`).slice(0, 12);
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Forward-slash form of `s`: used both for a slash-agnostic prefix
 * comparison and, in `collapseAgainst`, as the actual returned text - a
 * home-collapsed path is portable and always uses forward slashes (see
 * `homeCollapse`), never the host separator. */
function withForwardSlashes(s: string): string {
  return s.replace(/\\/g, '/');
}

/**
 * `target` collapsed against `home`, `null` if `target` isn't under it.
 *
 * Home-collapsed paths are portable text (DESIGN.md "Repo store"): the
 * result is always `~` followed by FORWARD SLASHES, on every platform, never
 * the host separator - a session document, an index line or CLI output must
 * read the same way whether it was written on Windows or not. The
 * comparison itself folds `\` and `/` to the same thing first (a
 * transcript's recorded cwd can use either style relative to
 * `os.homedir()`'s own style, e.g. a Windows home reported with backslashes
 * against a path some tool recorded with forward slashes), so the remainder
 * sliced off `nTarget` (already all forward slashes) is what gets returned.
 */
function collapseAgainst(target: string, home: string): string | null {
  if (!home) return null;
  const nTarget = withForwardSlashes(target);
  const nHome = withForwardSlashes(home).replace(/\/+$/, '');
  if (!nHome) return null;
  if (nTarget === nHome) return '~';
  if (nTarget.startsWith(nHome) && nTarget[nHome.length] === '/') {
    return `~${nTarget.slice(nHome.length)}`;
  }
  return null;
}

/**
 * `/Users/me/x` -> `~/x`, so a stored path is portable between machines.
 *
 * Compared through `realpath` as well as literally: on macOS `$HOME` under
 * `/var/...` and the same directory as `/private/var/...` are one place, and
 * a literal prefix test alone leaves the machine's real home in the record.
 * The comparison also folds `/` and `\` together (see `collapseAgainst`) so
 * a Windows home and a path using either slash style still collapse - and
 * the result is always `~/forward/slash/form`, per DESIGN.md.
 *
 * `home` defaults to `envHome(process.env)`, not a bare `os.homedir()`: on
 * win32 `os.homedir()` reads only `USERPROFILE`, but an injected `HOME`
 * (a sandboxed test, a shell that sets both) must be honoured too, or a
 * path built against that `HOME` never collapses. Trailing and optional, so
 * every existing call site keeps working unchanged.
 */
export function homeCollapse(p: string | null | undefined, home: string = envHome(process.env)): string {
  const s = p ?? '';
  if (!s) return s;
  const direct = collapseAgainst(s, home);
  if (direct !== null) return direct;
  if (!home || !path.isAbsolute(s)) return s;
  const realHome = realpathOr(home);
  const real = realpathOr(s);
  const viaReal = collapseAgainst(real, realHome);
  if (viaReal !== null) return viaReal;
  return s;
}

/**
 * `~/x` -> a platform path, `~\x` accepted too (DESIGN.md "Repo store":
 * `homeExpand` reads either slash style a home-collapsed path might have
 * been written with, since an older record or a hand-edited one could still
 * carry the host separator). `home` defaults to `envHome(process.env)`, for
 * the same reason as `homeCollapse` above.
 */
export function homeExpand(p: string | null | undefined, home: string = envHome(process.env)): string {
  const s = p ?? '';
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(home, ...s.slice(2).split(/[/\\]+/));
  }
  return s;
}

export function findRepoRoot(cwd?: string): string | null {
  return gitmod.repoRoot(cwd || process.cwd());
}

export function storeDir(root: string): string {
  return path.join(root, STORE_DIR);
}
export function sessionsDir(root: string): string {
  return path.join(storeDir(root), 'sessions');
}
export function configPath(root: string): string {
  return path.join(storeDir(root), 'config.json');
}
export function indexPath(root: string): string {
  return path.join(storeDir(root), 'index.jsonl');
}
export function readmePath(root: string): string {
  return path.join(storeDir(root), 'README.md');
}

/** The repo's real git dir (worktrees and submodules use a `.git` file). */
export function gitDirOf(root: string): string {
  const r = gitmod.git(['rev-parse', '--absolute-git-dir'], { cwd: root });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  return path.join(root, '.git');
}

export function lockPath(root: string): string {
  return path.join(gitDirOf(root), 'promptlog.lock');
}

const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 2000;

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // busy-wait is fine as a fallback
  }
}

/**
 * Run `fn` holding an O_EXCL lock file, so two hooks (or a hook and a manual
 * `promptlog sync`) cannot interleave read-modify-write on the session
 * documents. A lock older than 10 s is assumed to be a killed hook and is
 * broken. If the lock cannot be taken at all we still run: losing a record is
 * worse than a rare race, and every write is atomic on its own.
 */
export function withLock<T>(root: string, fn: () => T): T {
  const lock = lockPath(root);
  let held = false;
  const giveUp = Date.now() + LOCK_WAIT_MS;
  while (!held) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      held = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break; // unwritable git dir: proceed unlocked
      let age = Number.POSITIVE_INFINITY;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // vanished between open and stat: retry
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* someone else won */
        }
        continue;
      }
      if (Date.now() >= giveUp) break; // proceed unlocked rather than lose data
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

/** tmp + rename, so a killed hook never leaves half a JSON document. */
export function writeAtomic(file: string, text: string): string {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// OLD's deepMergeDefaults (`Object.assign({}, defaults, target || {})`, both
// at the top level and inside `redact`) kept any key it didn't recognize -
// forward-compat for a config field a newer promptlog wrote and an older
// one is now reading. Spreading `r`/`rr` first, then overwriting the known
// fields with validated values, keeps that.
function mergeStoreDefaults(raw: unknown): StoreConfig {
  const r = rec(raw) ?? {};
  const rr = rec(r.redact) ?? {};
  const strArr = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : fallback;
  return {
    ...r,
    version: num(r.version) ?? DEFAULT_CONFIG.version,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_CONFIG.enabled,
    responses: r.responses === 'none' ? 'none' : DEFAULT_CONFIG.responses,
    redact: {
      ...rr,
      pasteLines: num(rr.pasteLines) ?? DEFAULT_CONFIG.redact.pasteLines,
      pasteBytes: num(rr.pasteBytes) ?? DEFAULT_CONFIG.redact.pasteBytes,
      allow: strArr(rr.allow, DEFAULT_CONFIG.redact.allow),
      deny: strArr(rr.deny, DEFAULT_CONFIG.redact.deny),
      keepEmails: typeof rr.keepEmails === 'boolean' ? rr.keepEmails : DEFAULT_CONFIG.redact.keepEmails,
    },
    notes: typeof r.notes === 'boolean' ? r.notes : DEFAULT_CONFIG.notes,
    readme: typeof r.readme === 'boolean' ? r.readme : DEFAULT_CONFIG.readme,
  };
}

/** Read config.json, creating it with defaults when absent. */
export function ensureConfig(root: string): StoreConfig {
  const p = configPath(root);
  const raw = readJson(p);
  if (!raw) {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as StoreConfig;
    writeAtomic(p, `${JSON.stringify(cfg, null, 2)}\n`);
    return cfg;
  }
  return mergeStoreDefaults(raw);
}

export function readConfig(root: string): StoreConfig {
  const raw = readJson(configPath(root));
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as StoreConfig;
  return mergeStoreDefaults(raw);
}

export function writeConfig(root: string, cfg: unknown): string {
  return writeAtomic(configPath(root), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function shortSession(sessionId: string | null | undefined): string {
  // Must match model.ts's Turn#gid exactly.
  return String(sessionId ?? '').slice(0, 8) || 'unknown0';
}

/** `claude:c86e0429:5043cd5` */
export function makeGid(agent: string, sessionId: string | null | undefined, shortId: string): string {
  return `${agent}:${shortSession(sessionId)}:${shortId}`;
}

export function turnGid(turn: Turn): string {
  return turn.gid;
}

export function sessionDocPath(root: string, agent: string, sessionId: string): string {
  return path.join(sessionsDir(root), `${agent}-${shortSession(sessionId)}.json`);
}

const CACHE_DIR = '.cache';

export function trailerCachePath(root: string): string {
  return path.join(storeDir(root), CACHE_DIR, 'trailers.json');
}

/**
 * Create the store skeleton: sessions dir, config, a local (never committed)
 * index.jsonl, `.promptlog/.gitignore` so the index can never be staged by
 * accident, and the `.gitattributes` merge-driver registrations for the
 * session documents and README.
 */
export function initStore(root: string): StoreConfig {
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  const cfg = ensureConfig(root);
  if (!fs.existsSync(indexPath(root))) writeAtomic(indexPath(root), '');
  ensureGitignore(root);
  ensureGitattributes(root);
  return cfg;
}

/**
 * `.promptlog/.gitignore`: everything in the store that is local cache and
 * must never be committed or merged -
 *
 *   index.jsonl   lazily rebuilt from the session documents
 *   .cache/       the commit-trailer scan cache
 *   .*.tmp        a `writeAtomic` temp file caught mid-rename by `git add -A`
 */
const GITIGNORE_LINES = ['index.jsonl', '.cache/', '.*.tmp'];

export function ensureGitignore(root: string): boolean {
  const file = path.join(storeDir(root), '.gitignore');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const present = new Set(text.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (!missing.length) return false;
  const prefixed = text && !text.endsWith('\n') ? `${text}\n` : text;
  fs.writeFileSync(file, `${prefixed}${missing.join('\n')}\n`, 'utf8');
  return true;
}

export const OLD_INDEX_UNION_LINE = `${STORE_DIR}/index.jsonl merge=union`;
export const SESSIONS_MERGE_LINE = `${STORE_DIR}/sessions/*.json merge=promptlog`;
export const README_MERGE_LINE = `${STORE_DIR}/README.md merge=promptlog-readme`;

/**
 * Keep `.gitattributes` in sync: drop the old `index.jsonl merge=union` line
 * left by a pre-v0.3 `init` (the index is no longer committed at all, so
 * there is nothing left to merge-driver), and make sure the session-document
 * and README union merge drivers are registered. Idempotent: does not
 * rewrite the file when nothing changed.
 */
export function ensureGitattributes(root: string): boolean {
  const file = path.join(root, '.gitattributes');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines = lines.filter((l) => l.trim() !== OLD_INDEX_UNION_LINE);
  for (const wanted of [SESSIONS_MERGE_LINE, README_MERGE_LINE]) {
    if (!lines.some((l) => l.trim() === wanted)) lines.push(wanted);
  }
  const next = lines.length ? `${lines.join('\n')}\n` : '';
  if (next === text) return false;
  fs.writeFileSync(file, next, 'utf8');
  return true;
}
