/**
 * `sync` / `trailers` / `reindex` / `review`, plus the selection/attribution
 * plumbing shared across the repo-facing subcommands: which transcripts are
 * candidates for this repo (`candidateSessions`), which of their turns are
 * in scope (`relevantTurns`, `sessionsForWindow`), and who wrote what is
 * being committed (`attributeCommit`, `attributableStagedFiles`).
 *
 * Every handler is `async (args, ctx) => exitCode`, matching
 * `commands/skill.ts`'s `CommandArgs` / `Ctx` shapes.
 *
 * `commands/init.ts` owns `init`/`enable`/`disable` and the merge drivers;
 * `commands/hooks.ts` owns installing and running the git hooks;
 * `commands/recall.ts` owns the store-side `show`/`grep`/`files`;
 * `commands/view.ts` owns the live-transcript `show`/`grep`/`files`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { agents, byId } from '../../agents';
import { attribute, type LinkedEntry } from '../attribution';
import { canonicalPath, isUnderRepo } from '../fsutil';
import * as git from '../git';
import { str } from '../json';
import type { Session, Turn } from '../model';
import type { TurnRecord } from '../records';
import { renderReadme } from '../renderReadme';
import { listCandidateSessions, resolveSession } from '../session';
import { buildRecord, type CommitInput, upsertSession } from '../sessionRecords';
import { ensureConfig, findRepoRoot, gitDirOf, readConfig, STORE_DIR, type StoreConfig } from '../store';
import { reindex as storeReindex } from '../storeIndex';
import { attachSubagents } from '../subagents';
import {
  Colors,
  type CommandArgs,
  type Ctx,
  envHome,
  err,
  humanizeDuration,
  localYMDHM,
  out,
  parseIsoStringToMicros,
} from '../util';

// ------------------------------------------------------------------ plumbing

/** parseArgs gives kebab-case keys; accept both spellings. */
export function vals(args: CommandArgs): Record<string, unknown> {
  const v = { ...args.values };
  if (v.noColor === undefined) v.noColor = Boolean(v['no-color']);
  return v;
}

export function positionalsAfter(args: CommandArgs, name: string): string[] {
  const p = args.positionals ?? [];
  return p.length && p[0] === name ? p.slice(1) : p.slice();
}

export function requireRoot(ctx: Ctx): string | null {
  const root = findRepoRoot(ctx.cwd);
  if (!root) {
    err(ctx, 'promptlog: not inside a git repository');
    return null;
  }
  return root;
}

function safeParse(agent: string, filePath: string): Session | null {
  const adapter = byId(agent) ?? byId('claude');
  if (!adapter) return null;
  try {
    // Records carry a per-turn `subagents` block, so every path that writes
    // one - hooks, `sync`, `review` - parses with subagents attached.
    return attachSubagents(adapter.parse(filePath), { adapter });
  } catch {
    return null;
  }
}

function sessionIdOf(session: Session, filePath: string): string {
  if (session.id) return session.id;
  return path.basename(filePath).replace(/\.jsonl$/, '');
}

/**
 * Which adapters may answer for `--agent <id>`.
 *
 * Symmetric by design: a named agent narrows to that agent alone, whichever
 * one it is. `auto` considers every adapter.
 */
export function narrowedAgentIds(agent?: string | null): string[] {
  const all = agents().map((a) => a.id);
  if (!agent || agent === 'auto') return all;
  return all.includes(agent) ? [agent] : all;
}

export interface Candidate {
  agent: string;
  path: string;
  sessionId: string;
  session: Session;
  how: string | null;
}

export interface CandidateSessionsOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  agent?: string;
  session?: string | null;
  sinceMs?: number;
  all?: boolean;
}

/**
 * Candidate sessions for this repo.
 *
 * `all: false` (the window path: `sync`, `review`) keeps the old preference
 * order - an explicit `--session` or an agent's env var is the one answer.
 * `all: true` (the attribution path) returns EVERY transcript for this repo,
 * from every adapter, because any of them may have contributed a staged
 * hunk; the env-identified one is still marked, since that is what makes its
 * last turn the committer turn.
 */
export function candidateSessions({
  cwd,
  env = process.env,
  agent = 'auto',
  session = null,
  sinceMs = 0,
  all = false,
}: CandidateSessionsOptions): Candidate[] {
  const results: Candidate[] = [];
  const seen = new Set<string>();
  // `how` matters: a session identified from an env var is the one the user
  // is inside right now, which is what makes its last turn the active turn.
  const push = (a: string, p: string | null, how: string | null) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    const parsed = safeParse(a, p);
    if (!parsed) return;
    results.push({ agent: a, path: p, sessionId: sessionIdOf(parsed, p), session: parsed, how: how ?? null });
  };
  const ids = narrowedAgentIds(agent);
  // Every home lookup goes through the env we were given, not os.homedir():
  // a sandboxed HOME (tests, `--global` e2e runs) must be honoured even on
  // win32, where os.homedir() reads USERPROFILE instead.
  const home = envHome(env);

  // Explicit session, or the env vars: the identified session comes first.
  const wantedEnv =
    session || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || null;
  if (wantedEnv) {
    try {
      const r = resolveSession({ agent, session, cwd, env, home });
      if (r.path) push(r.agent ?? agent, r.path, r.how);
    } catch {
      /* fall through */
    }
    if (!results.length) {
      const how = session
        ? 'explicit'
        : env.CLAUDE_CODE_SESSION_ID
          ? 'env:CLAUDE_CODE_SESSION_ID'
          : env.CODEX_THREAD_ID
            ? 'env:CODEX_THREAD_ID'
            : 'env:CODEX_SESSION_ID';
      for (const a of ids) {
        const adapter = byId(a);
        if (!adapter) continue;
        try {
          const p = adapter.findSession(wantedEnv, { cwd, home });
          if (p) push(a, p, how);
        } catch {
          /* keep trying */
        }
        if (results.length) break;
      }
    }
    if (results.length && !all) return results;
  }

  try {
    for (const c of listCandidateSessions({ cwd, since: sinceMs, home })) {
      if (!ids.includes(c.agent)) continue;
      push(c.agent, c.path, 'newest-for-cwd');
    }
    if (results.length && !all) return results;
  } catch {
    /* fall through */
  }

  for (const a of ids) {
    const adapter = byId(a);
    if (!adapter) continue;
    try {
      for (const loc of adapter.locate({ cwd, home })) push(a, loc.path, 'newest-for-cwd');
    } catch {
      /* keep trying */
    }
  }
  return results;
}

/**
 * Did this turn do its work inside this repo?
 *
 * A turn that touched files, none of them under the repo root, belongs to
 * some other checkout: the agent was working elsewhere and this commit has
 * nothing to do with it. A turn that touched no files at all (pure
 * discussion) stays, because we cannot tell and dropping it would lose real
 * prompts.
 */
export function touchesRepo(turn: { files: Set<string> }, root: string): boolean {
  const files = [...turn.files];
  if (!files.length) return true;
  for (const f of files) {
    if (!f) continue;
    if (!path.isAbsolute(f)) return true; // already repo-relative
    if (isUnderRepo(f, root)) return true;
  }
  return false;
}

/**
 * Is this candidate's LAST turn the active turn - the one the commit is
 * being issued from? Two signals, per DESIGN.md "Which turns belong to a
 * commit":
 *
 *  (a) the session was identified from an env var (`how` starts with
 *      `env:`). The agent injected that id into our own environment, so the
 *      commit is being made from inside that session's current turn by
 *      definition.
 *  (b) the transcript's mtime is at or after the previous commit's
 *      committer time: the agent has written to it since, so the session is
 *      live.
 *
 * With no previous commit only (a) can say anything, and the window is
 * everything anyway. Otherwise we fall back to plain window overlap.
 */
export function activeLastFor(
  candidate: { how?: string | null; path: string },
  since: number | null,
): boolean {
  if (/^env:/.test(String(candidate.how ?? ''))) return true;
  if (since == null) return false;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(candidate.path).mtimeMs;
  } catch {
    return false;
  }
  return mtimeMs >= Math.floor(since / 1000);
}

/**
 * The turns of a session that this commit should link to: inside the window
 * (or the active turn), not a slash command (`/model` is not a prompt about
 * the code), and doing their work in this repo.
 *
 * The active turn is exempt from the relevance filter. The commit is being
 * issued from inside that turn, which is what makes it relevant to this
 * commit - whatever other checkouts the same turn also touched. Without the
 * exemption an agent working across two repos loses the turn that drove the
 * commit, which is the whole point of selecting it. The slash-command filter
 * still applies: `/model` never earns a trailer.
 */
export function relevantTurns<T extends git.WindowTurn & { isCommand: boolean; files: Set<string> }>(
  session: { turns?: T[] } | null | undefined,
  {
    since,
    until,
    root,
    activeLast = false,
  }: { since: number | null; until: number | null; root: string; activeLast?: boolean },
): T[] {
  const last = activeLast ? git.activeTurn(session) : null;
  return git
    .selectTurns(session, { since, until, activeLast })
    .filter((t) => !t.isCommand)
    .filter((t) => t === last || touchesRepo(t, root));
}

export interface Chosen extends Candidate {
  turns: Turn[];
  activeFullId: string | null;
}

export interface WindowCandidate extends Chosen {
  files: Set<string>;
}

/**
 * The session(s) whose turns fall in this window.
 *
 * This is the RECORDING path (`sync`, `review`, `trailers` with nothing
 * staged): "what did I ask in this stretch of time", with no commit to match
 * against. Commit links go through `attributeCommit` below instead, which
 * needs evidence rather than a window.
 */
export function sessionsForWindow({
  cwd,
  root,
  env,
  agent,
  session,
  since,
  until,
}: {
  cwd: string;
  root: string;
  env: NodeJS.ProcessEnv;
  agent?: string;
  session?: string | null;
  since: number | null;
  until: number | null;
}): WindowCandidate[] {
  // Only transcripts touched since (roughly) the last commit can contain
  // turns in this window. An hour of slack covers clock skew and a
  // transcript that was written to before the commit but whose turn is
  // still in progress.
  const sinceMs = since == null ? 0 : Math.max(0, Math.floor(since / 1000) - 3600000);
  const cands = candidateSessions({ cwd, env, agent, session, sinceMs });
  if (!cands.length) return [];
  const withFiles: WindowCandidate[] = cands.map((c) => {
    const activeLast = activeLastFor(c, since);
    const turns = relevantTurns(c.session.turns ? c.session : { turns: [] }, {
      since,
      until,
      root,
      activeLast,
    });
    const files = new Set<string>();
    for (const t of turns) for (const f of t.files) files.add(f);
    const last = git.activeTurn(c.session);
    return { ...c, turns, files, activeFullId: activeLast && last ? last.fullId : null };
  });
  const active = withFiles.filter((c) => c.turns.length);
  return active.length ? active : withFiles;
}

// -------------------------------------------------------------- attribution

/** Our own generated files are never evidence about anybody's prompt. */
export function attributableStagedFiles(root: string): string[] {
  return git.stagedFiles(root).filter((f) => {
    const n = git.normalizeRepoPath(f, root);
    return n && n !== '.gitattributes' && !n.startsWith(`${STORE_DIR}/`) && n !== STORE_DIR;
  });
}

export interface AttributeCommitResult {
  chosen: Chosen[];
  linked: Map<string, LinkedEntry>;
  unattributed: Record<string, number>;
  staged: string[];
  committerSession: Candidate | null;
}

/**
 * Who wrote what is being committed.
 *
 * Contributors come from tool-call evidence matched against
 * `git diff --cached -U0`; the committer is the active turn of the session
 * an agent named in our environment. Returns the chosen sessions with their
 * linked turns, plus the raw attributor output so the caller can store the
 * per-file evidence and report what nobody can account for.
 */
export function attributeCommit({
  cwd,
  root,
  env,
  agent,
  session,
  since,
}: {
  cwd: string;
  root: string;
  env: NodeJS.ProcessEnv;
  agent?: string;
  session?: string | null;
  since: number | null;
}): AttributeCommitResult {
  const sinceMs = since == null ? 0 : Math.max(0, Math.floor(since / 1000) - 3600000);
  const cands = candidateSessions({ cwd, env, agent, session, sinceMs, all: true });
  const committerSession = cands.find((c) => /^(env:|explicit)/.test(String(c.how ?? ''))) ?? null;
  const staged = attributableStagedFiles(root);
  const { linked, unattributed } = attribute({
    repoRoot: root,
    stagedFiles: staged,
    hunksByFile: git.stagedHunks(root),
    candidateSessions: cands,
    sinceMicros: since,
    committerSession,
  });

  const chosen: Chosen[] = [];
  for (const c of cands) {
    const turns = c.session.turns.filter((t) => {
      if (t.isCommand) return false; // a slash command never earns a trailer
      return linked.has(t.gid);
    });
    if (!turns.length) continue;
    const last = git.activeTurn(c.session);
    const isCommitter = committerSession === c;
    chosen.push({ ...c, turns, activeFullId: isCommitter && last ? last.fullId : null });
  }
  return { chosen, linked, unattributed, staged, committerSession };
}

// ------------------------------------------------------------------- writing

/** Upsert the selected turns of every chosen session; returns the gids. */
export function writeRecords(
  root: string,
  chosen: Chosen[],
  { config, commits = [] }: { config: StoreConfig; commits?: CommitInput[] },
): string[] {
  const gids: string[] = [];
  for (const c of chosen) {
    if (!c.turns.length) continue;
    const res = upsertSession(root, {
      agent: c.agent,
      sessionId: c.sessionId,
      cwd: c.session.cwd,
      started:
        c.session.startedMicros != null
          ? new Date(Math.floor(c.session.startedMicros / 1000)).toISOString()
          : undefined,
      originPath: c.path,
      config,
      commits,
      turns: c.turns,
      activeFullId: c.activeFullId ?? null,
    });
    gids.push(...res.gids);
  }
  return gids;
}

export function regenerate(root: string, config: StoreConfig): void {
  storeReindex(root);
  if (config.readme !== false) renderReadme(root);
}

// ------------------------------------------------------------------- sync

function windowFor(root: string, values: Record<string, unknown>): { since: number | null; until: number } {
  const all = Boolean(values.all);
  return { since: all ? null : git.headCommitTime(root), until: Date.now() * 1000 };
}

export async function sync(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  const config = ensureConfig(root);
  const { since, until } = windowFor(root, values);
  const chosen = sessionsForWindow({
    cwd: ctx.cwd,
    root,
    env: ctx.env,
    agent: str(values.agent) || 'auto',
    session: str(values.session),
    since,
    until,
  });
  if (!chosen.length) {
    err(ctx, 'promptlog: no session found for this repo');
    return 1;
  }
  const gids = writeRecords(root, chosen, { config });
  regenerate(root, config);
  if (values.json) {
    out(
      ctx,
      JSON.stringify(
        { gids, sessions: chosen.map((c) => ({ agent: c.agent, sessionId: c.sessionId })) },
        null,
        2,
      ),
    );
  } else {
    out(ctx, `promptlog: wrote ${gids.length} record${gids.length === 1 ? '' : 's'}`);
    for (const g of gids) out(ctx, `  ${g}`);
  }
  return 0;
}

/**
 * The trailers this commit should carry.
 *
 * With something staged this is the attribution answer - the turns that can
 * be shown to have written it, plus the committer turn. With an empty index
 * there is nothing to attribute, so it falls back to the window: an agent
 * asking "which prompts am I about to link?" before staging still gets an
 * answer.
 */
export async function trailers(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  const { since, until } = windowFor(root, values);
  const agent = str(values.agent) || 'auto';
  const session = str(values.session);
  const staged = attributableStagedFiles(root);
  const gids: string[] = [];
  let unattributed: Record<string, number> = {};
  if (staged.length) {
    const res = attributeCommit({ cwd: ctx.cwd, root, env: ctx.env, agent, session, since });
    unattributed = res.unattributed;
    for (const c of res.chosen) for (const t of c.turns) gids.push(t.gid);
  } else {
    const chosen = sessionsForWindow({ cwd: ctx.cwd, root, env: ctx.env, agent, session, since, until });
    for (const c of chosen) for (const t of c.turns) gids.push(t.gid);
  }
  if (values.json) {
    out(ctx, JSON.stringify({ gids, unattributed }, null, 2));
    return 0;
  }
  const text = git.formatTrailers(gids);
  if (text) ctx.stdout.write(text);
  return 0;
}

/**
 * Rebuild index.jsonl + README.md, and every record's commit list from the
 * commit trailers: the trailers are the truth, the stored shas are cache.
 */
export async function reindex(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  const config = ensureConfig(root);

  const res = storeReindex(root);
  const rebuilt = res.rebuilt ?? { changed: 0, commits: 0 };
  if (config.readme !== false) renderReadme(root);
  if (values.json) {
    out(
      ctx,
      JSON.stringify(
        { records: res.count, backfilled: rebuilt.changed, commits: rebuilt.commits ?? 0 },
        null,
        2,
      ),
    );
  } else {
    out(
      ctx,
      `promptlog: ${res.count} record${res.count === 1 ? '' : 's'} indexed, ${rebuilt.changed} commit link${rebuilt.changed === 1 ? '' : 's'} rebuilt from trailers`,
    );
  }
  return 0;
}

// ----------------------------------------------------------------- review

/** Stored records keep portable UTC; the terminal shows local time. */
export function localTs(ts: string): string {
  const micros = parseIsoStringToMicros(ts);
  return micros == null ? ts : localYMDHM(micros);
}

export async function review(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  const config = readConfig(root); // review is a preview: never create the store
  const { since, until } = windowFor(root, values);
  const chosen = sessionsForWindow({
    cwd: ctx.cwd,
    root,
    env: ctx.env,
    agent: str(values.agent) || 'auto',
    session: str(values.session),
    since,
    until,
  });
  const colors = new Colors(!values.noColor && Boolean((ctx.stdout as { isTTY?: boolean }).isTTY));
  const rows: Array<{ gid: string; rec: TurnRecord }> = [];
  for (const c of chosen) {
    for (const t of c.turns) {
      const gid = t.gid;
      const record = buildRecord(t, {
        agent: c.agent,
        sessionId: c.sessionId,
        originPath: c.path,
        config,
        root,
        active: c.activeFullId != null && t.fullId === c.activeFullId,
      });
      rows.push({ gid, rec: record });
    }
  }
  if (values.json) {
    out(
      ctx,
      JSON.stringify(
        rows.map(({ gid, rec }) => ({
          gid,
          ts: rec.ts,
          prompt: rec.prompt,
          response: rec.response,
          redactions: rec.redactions,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!rows.length) {
    out(ctx, 'promptlog: nothing would be written');
    return 0;
  }
  for (const { gid, rec } of rows) {
    out(ctx, colors.yellow(gid) + colors.dim(`  ${localTs(rec.ts)}  ${humanizeDuration(rec.durationS)}`));
    out(
      ctx,
      rec.prompt
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    if (rec.response) {
      out(ctx, colors.dim('  --- response ---'));
      out(
        ctx,
        rec.response
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n'),
      );
    }
    if (rec.redactions.length) {
      out(ctx, colors.magenta(`  redacted: ${rec.redactions.map((f) => `${f.kind}:${f.hash4}`).join(', ')}`));
    }
    out(ctx, '');
  }
  return 0;
}

/**
 * A pathspec commit (`git commit -- file`) builds a TEMPORARY index, which
 * `GIT_INDEX_FILE` points at instead of `$GIT_DIR/index`
 * (`next-index-<pid>.lock`). Anything we stage goes into the real index, so
 * it would miss this commit and be left dirty afterwards: skip such
 * commits.
 *
 * `$GIT_DIR/index.lock` is NOT such a case, even though it is also not
 * `$GIT_DIR/index`: that is what `git commit -a` (and a plain `git commit`
 * that has to write the index) uses, and git RENAMES it into place at the
 * end, so everything we add to it lands in this very commit. Treating it as
 * partial cost `git commit -am` its trailers entirely.
 *
 * Shared with `commands/hooks.ts`, which is where this question actually
 * gets asked (`pre-commit`/`prepare-commit-msg`); it stays here so the hook
 * module can import it alongside `attributeCommit`.
 */
export function isPartialCommit(ctx: Pick<Ctx, 'env'>, root: string): boolean {
  const idx = ctx.env.GIT_INDEX_FILE ?? '';
  if (!idx) return false;
  const gitDir = gitDirOf(root);
  // `gitDir` comes from `git rev-parse` (forward slashes on Git for Windows,
  // possibly a short 8.3 alias under a temp HOME), `idx` from the
  // environment: canonicalize both before comparing, or the same directory
  // fails to match itself.
  const here = canonicalPath(path.resolve(root, idx));
  const real = new Set(
    [path.join(gitDir, 'index'), path.join(gitDir, 'index.lock')].map((p) => canonicalPath(p)),
  );
  return !real.has(here);
}
