/**
 * Published-version update check. See README.md "Privacy" and
 * docs/DESIGN.md "Agent surfaces" for the user-facing contract; this module
 * is the implementation.
 *
 * Rules (non-negotiable - keep this comment and the docs in sync):
 *  - runs ONLY for the interactive view commands: tree, graph, last,
 *    skill-entry (which resolves to one of the others before dispatch),
 *    status, doctor, sessions. Never for hook, statusline, trailers, sync,
 *    review, init, merge-driver, or any other repo/distribution command.
 *  - at most once per 24h, tracked in ~/.promptlog/update-check.json. The
 *    cache is CLAIMED before fetching (checkedAt: now, pending: true, latest
 *    carried over from the previous check) so a concurrent run sees a fresh
 *    stamp and makes no request: at most one fetch per 24h per home
 *    directory, barring a write race in the same millisecond.
 *  - when the cache is stale: up to two origin requests - the npm registry,
 *    then the GitHub-hosted SKILL.md only if npm fails - each following at
 *    most one redirect, each bounded by an absolute deadline (TIMEOUT_MS)
 *    and a response-size cap (MAX_BODY_BYTES). Any failure is silent -
 *    record checkedAt with latest:null and move on.
 *  - off switches: PROMPTLOG_NO_UPDATE_CHECK=1, ~/.promptlog/config.json
 *    {"updateCheck": false}, or --no-update-check.
 *  - presents as at most one dim line appended to the command's stdout.
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { arr, get, rec, str, tryParse } from './json';
import { scriptsDir } from './paths';
import { type Ctx, envHome } from './util';
import { findVersion } from './version';

const HOME_DIR_NAME = '.promptlog';
const CACHE_FILE_NAME = 'update-check.json';
const CONFIG_FILE_NAME = 'config.json';
const INSTALL_RECORD_FILE_NAME = 'skill-installs.json';

const NPM_URL = 'https://registry.npmjs.org/@kkdevenda/promptlog/latest';
const GITHUB_FALLBACK_URL =
  'https://raw.githubusercontent.com/kkdevenda/promptlog/main/skills/promptlog/SKILL.md';
export const TIMEOUT_MS = 1500;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The subcommands, after `skill-entry` and other legacy aliases have been
// resolved to a real subcommand, that the update check runs for.
const ELIGIBLE_SUBCOMMANDS = new Set(['tree', 'graph', 'last', 'status', 'doctor', 'sessions']);

// ------------------------------------------------------------------ home files

export function cachePath(home: string): string {
  return path.join(home, HOME_DIR_NAME, CACHE_FILE_NAME);
}
export function configPath(home: string): string {
  return path.join(home, HOME_DIR_NAME, CONFIG_FILE_NAME);
}
function installRecordPath(home: string): string {
  return path.join(home, HOME_DIR_NAME, INSTALL_RECORD_FILE_NAME);
}

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** Read ~/.promptlog/config.json (the read helper referenced by the update-
 * check off switch). Returns {} on any error - missing file, bad JSON,
 * whatever - so callers never need their own try/catch. */
export function readHomeConfig(home: string): Record<string, unknown> {
  return rec(readJsonSafe(configPath(home))) ?? {};
}

export interface UpdateCache {
  checkedAt: number;
  latest: string | null;
  source: string | null;
  pending?: boolean;
}

export function readUpdateCache(home: string): UpdateCache | null {
  const data = rec(readJsonSafe(cachePath(home)));
  if (!data) return null;
  const checkedAt = get(data, 'checkedAt');
  return {
    checkedAt: typeof checkedAt === 'number' ? checkedAt : Number.NaN,
    latest: str(get(data, 'latest')),
    source: str(get(data, 'source')),
    pending: get(data, 'pending') === true ? true : undefined,
  };
}

function writeUpdateCache(home: string, data: UpdateCache): void {
  try {
    const p = cachePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  } catch {
    // best effort; never break the real command over a cache write
  }
}

interface InstallEntry {
  agent?: string;
  path?: string;
}

function readInstallRecord(home: string): InstallEntry[] {
  const data = rec(readJsonSafe(installRecordPath(home)));
  const out: InstallEntry[] = [];
  for (const raw of arr(data?.installs)) {
    const i = rec(raw);
    if (i) out.push({ agent: str(i.agent) ?? undefined, path: str(i.path) ?? undefined });
  }
  return out;
}

// ------------------------------------------------------------------ eligibility / off switch

export function isEligibleSubcommand(subcommand: string): boolean {
  return ELIGIBLE_SUBCOMMANDS.has(subcommand);
}

/** True if the update check is switched off by any of: env var, repo/home
 * config, or the --no-update-check flag. */
export function isDisabled({
  env,
  values,
  home,
}: {
  env?: NodeJS.ProcessEnv;
  values?: Record<string, unknown>;
  home: string;
}): boolean {
  if (env && String(env.PROMPTLOG_NO_UPDATE_CHECK) === '1') return true;
  if (values && values['no-update-check'] === true) return true;
  const cfg = readHomeConfig(home);
  if (cfg.updateCheck === false) return true;
  return false;
}

// ------------------------------------------------------------------ semver compare

interface Semver {
  main: number[];
  pre: string[] | null;
}

/** Parse a dotted version into {main:[maj,min,patch,...], pre:[...]|null}.
 * Non-numeric/missing main segments count as 0; a build-metadata suffix
 * (+...) is dropped entirely (never part of precedence). */
function parseSemver(v: string): Semver {
  let s = String(v || '0').trim();
  s = s.replace(/^v/i, '');
  s = s.split('+')[0] as string;
  const [mainPart, ...preParts] = s.split('-');
  const main = (mainPart as string).split('.').map((seg) => Number.parseInt(seg, 10) || 0);
  const pre = preParts.length ? preParts.join('-').split('.') : null;
  return { main, pre };
}

/** -1 / 0 / 1, comparing two version strings by semver precedence: numeric
 * main-version segments first, then a version with no prerelease outranks
 * one with a prerelease, else prerelease identifiers compare
 * numerically-if-both-numeric else lexically. No dependency on semver
 * packages; good enough for "is a newer version published", not a full
 * spec implementation of build-metadata edge cases. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.main.length, pb.main.length);
  for (let i = 0; i < len; i++) {
    const x = pa.main[i] ?? 0;
    const y = pb.main[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  const plen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < plen; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? Number.parseInt(x, 10) : null;
    const yn = /^\d+$/.test(y) ? Number.parseInt(y, 10) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ------------------------------------------------------------------ install-command detection

/** Walk up from `dirname` a handful of levels looking for a `.skills-lock`
 * file (skills.sh's marker), the way version.ts walks up looking for
 * package.json/SKILL.md. */
function hasNearbySkillsLock(dirname: string): boolean {
  let dir = dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, '.skills-lock'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function underPath(dirname: string, p: string): boolean {
  const norm = path.normalize(dirname);
  const base = path.normalize(p);
  return norm === base || norm.startsWith(base + path.sep);
}

/**
 * Is `dirname` inside a plugin manager's cache/managed skill directory -
 * i.e. a copy that must never be overwritten by `promptlog skill update`,
 * because some other tool owns its lifecycle? Checked most specific to
 * least specific:
 *   - under a Codex plugin cache path                     -> `codex plugin marketplace upgrade promptlog`
 *   - under a Claude plugin path                           -> `/plugin update promptlog` in Claude Code
 *   - a skills.sh install (~/.agents/skills, or a nearby .skills-lock) -> `npx skills update`
 *   - otherwise                                             -> null (not manager-owned)
 *
 * Shared by `detectInstallCommand` (the once-a-day hint) and
 * `commands/skill.ts` (`skill update`/`doctor`, so a manager-owned copy is
 * listed with its own upgrade command instead of being overwritten) - kept
 * here so the two never disagree about which paths are manager-owned.
 */
export function pluginManagerCommand({ dirname, home }: { dirname: string; home: string }): string | null {
  if (underPath(dirname, path.join(home, '.codex', 'plugins', 'cache'))) {
    return 'codex plugin marketplace upgrade promptlog';
  }

  if (underPath(dirname, path.join(home, '.claude', 'plugins'))) {
    return '/plugin update promptlog in Claude Code';
  }

  if (underPath(dirname, path.join(home, '.agents', 'skills')) || hasNearbySkillsLock(dirname)) {
    return 'npx skills update';
  }

  return null;
}

/** Which command to suggest for updating this particular running copy,
 * detected from `dirname` (the running script's directory). Checked most
 * specific to least specific:
 *   1. a path we ourselves recorded in skill-installs.json -> `promptlog skill update`
 *   2. manager-owned (see `pluginManagerCommand`)           -> that manager's own command
 *   3. otherwise                                             -> `npm i -g @kkdevenda/promptlog`
 */
export function detectInstallCommand({ dirname, home }: { dirname: string; home: string }): string {
  const installs = readInstallRecord(home);
  for (const entry of installs) {
    if (entry.path && underPath(dirname, entry.path)) return 'promptlog skill update';
  }

  const managed = pluginManagerCommand({ dirname, home });
  if (managed) return managed;

  return 'npm i -g @kkdevenda/promptlog';
}

// ------------------------------------------------------------------ network fetch

/** Read a readable stream (an http.IncomingMessage in production, any
 * Readable in tests) to a UTF-8 string, bounded two ways: `maxBytes` (bytes
 * received, not characters - multibyte text is counted at the wire) and
 * `timeoutMs`, an absolute deadline from the moment this is called that
 * fires whether or not data is still trickling in. On either bound the
 * stream is destroyed and the promise rejects (`response too large` /
 * `timeout`). Pure with respect to the network: no URL, no socket. */
export function collectBody(
  stream: Readable,
  { maxBytes = MAX_BODY_BYTES, timeoutMs }: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        stream.destroy(err);
        reject(err);
      } else {
        resolve(value as string);
      }
    };

    if (timeoutMs != null && timeoutMs !== Number.POSITIVE_INFINITY) {
      timer = setTimeout(() => finish(new Error('timeout')), Math.max(0, timeoutMs));
    }

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        finish(new Error('response too large'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => finish(null, Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', (err: Error) => finish(err || new Error('stream error')));
  });
}

/** GET `url` as text with an absolute deadline (`timeoutMs` from the first
 * request, shared across the redirect hop), a response-size cap
 * (MAX_BODY_BYTES), and at most one redirect hop. No data is sent beyond
 * the default UA/headers node:https adds. Rejects on any non-2xx status,
 * timeout, oversize body, or transport error. */
export function httpsGetText(
  url: string,
  {
    timeoutMs,
    redirectsLeft = 1,
    deadlineAt,
  }: { timeoutMs?: number; redirectsLeft?: number; deadlineAt?: number } = {},
): Promise<string> {
  const deadline = deadlineAt ?? Date.now() + (timeoutMs ?? TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle =
      <T>(fn: (value: T) => void) =>
      (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        fn(value);
      };
    const done = settle<string>(resolve);
    const fail = settle<Error>(reject);

    const req = https.get(url, { timeout: Math.max(0, deadline - Date.now()) }, (res) => {
      // Headers arrived: hand the remaining budget to the body reader, which
      // owns the deadline from here (it destroys the response on expiry).
      clearTimeout(deadlineTimer);
      const remaining = deadline - Date.now();
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        httpsGetText(res.headers.location, {
          timeoutMs,
          redirectsLeft: redirectsLeft - 1,
          deadlineAt: deadline,
        }).then(done, fail);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        fail(new Error(`http ${status}`));
        return;
      }
      collectBody(res, { maxBytes: MAX_BODY_BYTES, timeoutMs: remaining }).then(done, fail);
    });
    // Absolute deadline for the connect/headers phase: the socket-idle
    // `timeout` option alone would let a slow-but-active server run on.
    const deadlineTimer = setTimeout(
      () => {
        req.destroy(new Error('timeout'));
      },
      Math.max(0, deadline - Date.now()),
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', fail);
  });
}

interface FetchResult {
  latest: string;
  source: string;
}

/** The origins consulted when the cache is stale, in order. Each is tried
 * at most once per check; the list is the hard cap - two origins, never
 * more - and the next is consulted only if the previous one failed. */
const ORIGINS: Array<{ url: string; source: string; parse: (body: string) => string }> = [
  {
    url: NPM_URL,
    source: 'npm',
    parse(body) {
      const data = rec(tryParse(body));
      const version = str(data?.version);
      if (version) return version;
      throw new Error('npm response had no version');
    },
  },
  {
    url: GITHUB_FALLBACK_URL,
    source: 'github',
    parse(body) {
      // `metadata.version` (indented under `metadata:`) only; a legacy
      // top-level bare `version:` line is deliberately not read.
      const m = body.match(/^[ \t]+version:\s*([0-9][^\s]*)/m);
      if (m) return m[1] as string;
      throw new Error('github fallback SKILL.md had no version');
    },
  },
];

/** Default fetcher: npm registry's `latest` dist-tag, falling back to
 * parsing `metadata.version` out of the GitHub-hosted SKILL.md only if npm
 * fails. Returns {latest, source} or throws the last origin's error. */
async function defaultFetch(): Promise<FetchResult> {
  let lastError: unknown = null;
  for (const origin of ORIGINS) {
    try {
      const body = await httpsGetText(origin.url, { timeoutMs: TIMEOUT_MS });
      return { latest: origin.parse(body), source: origin.source };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no origins');
}

// ------------------------------------------------------------------ orchestration

export interface CheckUpdateOptions {
  env?: NodeJS.ProcessEnv;
  values?: Record<string, unknown>;
  home: string;
  dirname: string;
  running: string | null;
  now?: number;
  fetch?: () => Promise<FetchResult>;
}

/** Core, fully-testable entry point. Returns a hint string (already the
 * complete "promptlog X → Y · update: <command>" line, no leading/trailing
 * whitespace) or null when there is nothing to show. Never throws. */
export async function checkUpdate({
  env,
  values,
  home,
  dirname,
  running,
  now,
  fetch,
}: CheckUpdateOptions): Promise<string | null> {
  try {
    if (isDisabled({ env, values, home })) return null;

    const nowMs = now ?? Date.now();
    const cache = readUpdateCache(home);
    let latest: string | null = null;

    const fresh = cache != null && Number.isFinite(cache.checkedAt) && nowMs - cache.checkedAt < MAX_AGE_MS;
    if (fresh) {
      latest = (cache as UpdateCache).latest;
    } else {
      // Claim the slot BEFORE fetching: a concurrent run that reads the
      // cache from here on sees a fresh checkedAt (and the previous latest,
      // if any) and makes no request. Best effort, like every cache write.
      writeUpdateCache(home, {
        checkedAt: nowMs,
        latest: cache?.latest ?? null,
        source: cache?.source ?? null,
        pending: true,
      });
      const fetcher = fetch ?? defaultFetch;
      try {
        const result = await fetcher();
        latest = result.latest;
        writeUpdateCache(home, { checkedAt: nowMs, latest, source: result.source });
      } catch {
        writeUpdateCache(home, { checkedAt: nowMs, latest: null, source: null });
        latest = null;
      }
    }

    if (!latest || !running || running === 'unknown') return null;
    if (compareSemver(latest, running) <= 0) return null;

    const cmd = detectInstallCommand({ dirname, home });
    return `promptlog ${running} → ${latest} · update: ${cmd}`;
  } catch {
    return null;
  }
}

/** cli.ts entry point: computes the hint (if any) for `subcommand` and, if
 * present, writes it as one dim line to ctx.stdout - or to ctx.stderr when
 * `values.json` is set, so `--json` stdout is always exactly one parseable
 * document (the hint is advisory; the JSON is the contract). No-op for any
 * subcommand outside the eligible set. Never throws. */
export async function maybeAppendUpdateHint({
  ctx,
  values,
  subcommand,
}: {
  ctx: Ctx;
  values: Record<string, unknown>;
  subcommand: string;
}): Promise<void> {
  try {
    if (!isEligibleSubcommand(subcommand)) return;
    const home = envHome(ctx.env);
    const dirname = scriptsDir();
    const running = findVersion(dirname);
    const hint = await checkUpdate({ env: ctx.env, values, home, dirname, running });
    if (!hint) return;
    const stream = values.json ? ctx.stderr : ctx.stdout;
    const dim = !ctx.env.NO_COLOR && Boolean((stream as { isTTY?: boolean }).isTTY);
    stream.write(`${dim ? `\x1b[2m${hint}\x1b[0m` : hint}\n`);
  } catch {
    // must never break the real command
  }
}
