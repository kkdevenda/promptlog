/**
 * `show` / `grep` / `files`, answered from the repo store (`.promptlog/`).
 *
 * The repo store is an independent source from the live transcript: the
 * advertised "recall after the transcript aged out". `commands/view.ts`
 * answers `show`/`grep`/`files` from the CURRENT transcript; this module
 * answers from `.promptlog/`, and `cli.ts` runs both, dividing the output.
 */

import * as git from '../git';
import { errorMessage } from '../json';
import { resolve as resolveOrigin } from '../resolve';
import { allRecords, commitShas, normalizeCommits, type RecordEntry } from '../sessionRecords';
import { ensureIndexFresh, firstLine } from '../storeIndex';
import { Colors, type CommandArgs, type Ctx, err, humanizeDuration, humanizeNumber, out } from '../util';
import { localTs, positionalsAfter, requireRoot, vals } from './repo';

function findByGid(root: string, needle: string): RecordEntry[] {
  const all = allRecords(root);
  const exact = all.filter((r) => r.gid === needle);
  if (exact.length) return exact;
  const byShort = all.filter((r) => r.record.id === needle || r.gid.endsWith(`:${needle}`));
  if (byShort.length) return byShort;
  return all.filter((r) => r.gid.includes(needle) || r.record.id.startsWith(needle));
}

function looksLikeSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

function recordSourceLabel(source: string, colors: Colors): string {
  if (source === 'origin') return '';
  if (source === 'origin-modified') return ` ${colors.dim('[modified]')}`;
  return ` ${colors.dim('[repo]')}`;
}

function printRecord(ctx: Ctx, entry: RecordEntry, colors: Colors, values: Record<string, unknown>): void {
  const { gid, record } = entry;
  const r = resolveOrigin(record, { agent: entry.agent });
  const tok = record.tokens;
  out(ctx, colors.yellow(gid) + recordSourceLabel(r.source, colors));
  out(
    ctx,
    colors.dim(
      `  ${localTs(record.ts)}  ${humanizeDuration(record.durationS)}  ↑${humanizeNumber(tok.output + tok.thinking)} ↓${humanizeNumber(tok.input + tok.cacheRead + tok.cacheWrite)}  ${record.toolCalls} tool calls`,
    ),
  );
  if (record.files.length) out(ctx, colors.dim(`  files: ${record.files.join(', ')}`));
  const entries = normalizeCommits(record.commits);
  if (entries.length) {
    out(
      ctx,
      colors.dim(
        `  commits: ${entries
          .map((e) => {
            const files = Object.keys(e.files);
            const detail = files.length
              ? ` ${e.role}, ${files.length} file${files.length === 1 ? '' : 's'}`
              : ` ${e.role}`;
            return e.sha.slice(0, 7) + colors.dim(detail);
          })
          .join(', ')}`,
      ),
    );
  }
  out(ctx, '');
  out(
    ctx,
    String(r.prompt ?? '')
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  if (values.responses && r.response) {
    out(ctx, '');
    out(ctx, colors.dim('  --- response ---'));
    out(
      ctx,
      String(r.response)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
  out(ctx, '');
}

function jsonRecord(entry: RecordEntry): Record<string, unknown> {
  const r = resolveOrigin(entry.record, { agent: entry.agent });
  return {
    ...entry.record,
    gid: entry.gid,
    agent: entry.agent,
    session: entry.sessionId,
    source: r.source,
    prompt: r.prompt,
    response: r.response,
  };
}

export async function show(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  ensureIndexFresh(root);
  const rest = positionalsAfter(args, 'show');
  const needle = rest[0];
  if (!needle) {
    err(ctx, 'usage: promptlog show <gid|shortId|sha>');
    return 2;
  }
  const colors = new Colors(!values.noColor && Boolean((ctx.stdout as { isTTY?: boolean }).isTTY));

  let entries: RecordEntry[] = [];
  let sha: string | null = null;
  if (looksLikeSha(needle)) {
    const t = git.git(['rev-parse', '--verify', '--quiet', `${needle}^{commit}`], { cwd: root });
    if (t.ok && t.stdout.trim()) {
      sha = t.stdout.trim();
      const gids = git.parseTrailers(git.commitMessage(root, sha), { cwd: root });
      const all = allRecords(root);
      entries = all.filter((r) => gids.includes(r.gid));
      if (!entries.length) {
        const wantSha = sha;
        entries = all.filter((r) => commitShas(r.record).some((c) => c === wantSha || c.startsWith(needle)));
      }
    }
  }
  if (!entries.length && !sha) entries = findByGid(root, needle);

  if (!entries.length) {
    err(ctx, `promptlog: nothing found for ${needle}`);
    return 1;
  }
  if (values.json) {
    out(
      ctx,
      JSON.stringify(
        sha ? { commit: sha, prompts: entries.map(jsonRecord) } : entries.map(jsonRecord),
        null,
        2,
      ),
    );
    return 0;
  }
  if (sha) {
    out(
      ctx,
      colors.cyan(`commit ${sha}`) +
        colors.dim(`  (${entries.length} prompt${entries.length === 1 ? '' : 's'})`),
    );
  }
  for (const e of entries) printRecord(ctx, e, colors, values);
  return 0;
}

function emitList(ctx: Ctx, entries: RecordEntry[], values: Record<string, unknown>): number {
  if (values.json) {
    ctx.stdout.write(`${JSON.stringify(entries.map(jsonRecord), null, 2)}\n`);
    return entries.length ? 0 : 1;
  }
  const colors = new Colors(!values.noColor && Boolean((ctx.stdout as { isTTY?: boolean }).isTTY));
  for (const e of entries) {
    const commits = commitShas(e.record)
      .map((s) => s.slice(0, 7))
      .join(',');
    ctx.stdout.write(
      `${colors.yellow(e.gid)} ${colors.dim(localTs(e.record.ts))} ${firstLine(e.record.prompt, 80)}${commits ? colors.dim(`  [${commits}]`) : ''}\n`,
    );
  }
  return entries.length ? 0 : 1;
}

export async function files(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  ensureIndexFresh(root);
  const rest = positionalsAfter(args, 'files');
  const needle = rest[0];
  if (!needle) {
    err(ctx, 'usage: promptlog files <path>');
    return 2;
  }
  const want = git.normalizeRepoPath(needle, root);
  const entries = allRecords(root).filter((e) =>
    e.record.files.some((f) => f === want || f.endsWith(`/${want}`) || f.includes(want)),
  );
  return emitList(ctx, entries, values);
}

export async function grep(args: CommandArgs, ctx: Ctx): Promise<number> {
  const values = vals(args);
  const root = requireRoot(ctx);
  if (!root) return 1;
  ensureIndexFresh(root);
  const rest = positionalsAfter(args, 'grep');
  const pattern = rest[0];
  if (!pattern) {
    err(ctx, 'usage: promptlog grep <regex>');
    return 2;
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    err(ctx, `promptlog: bad regex: ${errorMessage(e)}`);
    return 2;
  }
  const entries = allRecords(root).filter(
    (e) =>
      re.test(e.record.prompt) || (Boolean(values.responses) && re.test(String(e.record.response ?? ''))),
  );
  return emitList(ctx, entries, values);
}
