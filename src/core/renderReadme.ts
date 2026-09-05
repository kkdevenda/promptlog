// -------------------------------------------------------------- README

import path from 'node:path';

import { rec, str } from './json';
import { Session, Turn } from './model';
import { scriptsDir } from './paths';
import type { TurnRecord } from './records';
import { buildGraphLines } from './renderMermaid';
import { allRecords, commitShas, type RecordEntry } from './sessionRecords';
import { readJson, readmePath, writeAtomic } from './store';
import { firstLine } from './storeIndex';
import { escQuotes, humanizeDuration, humanizeNumber, parseIsoStringToMicros } from './util';

/**
 * Make a string safe for one markdown table cell: pipes escaped, newlines
 * flattened, backticks dropped (they would open a code span that swallows
 * the rest of the row), trailing whitespace trimmed.
 */
export function mdEscape(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/`/g, '')
    .replace(/\|/g, '\\|')
    .replace(/\s+$/, '');
}

/** `2026-09-02 10:19Z` — UTC, because the file is shared across time zones. */
export function compactUtc(ts: string | null | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(ts ?? ''));
  return m ? `${m[1]} ${m[2]}Z` : String(ts ?? '');
}

function findHomepage(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const pkg = rec(readJson(path.join(dir, 'package.json')));
    const url = pkg ? str(pkg.homepage) : null;
    if (url && /^https?:\/\/\S+$/.test(url.trim())) return url.trim();
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * promptlog's own homepage, for the README header link: walks up from the
 * running copy's directory (`scriptsDir()`) looking for a `package.json`
 * with a `homepage`. Present for an npm install; absent for a bare skill
 * install (marketplace, `npx skills add`), which then falls back to plain
 * text (DESIGN.md "README.md"). OLD read only `<scriptsDir>/../package.json`
 * via `__dirname`, a path that never exists in any real install layout (the
 * skill ships with no `package.json` at all) and so always returned null;
 * this walk-up is a deliberate fix so an npm install actually gets a link.
 */
export function homepage(): string | null {
  return findHomepage(scriptsDir());
}

/**
 * Synthetic Session-shaped object over the stored records, so we can reuse
 * `renderMermaid.buildGraphLines` for the tree walk instead of rewriting it.
 */
function syntheticSession(records: RecordEntry[]): Session {
  const gids = new Set(records.map((r) => r.gid));
  const turns = records.map(({ gid, record }) => {
    const t = new Turn({
      id: record.id,
      fullId: gid,
      parentId: record.parentId && gids.has(record.parentId) ? record.parentId : null,
      agent: 'synthetic',
      tsMicros: parseIsoStringToMicros(record.ts) ?? 0,
      prompt: record.prompt,
      isCommand: record.isCommand,
    });
    t.durationS = record.durationS;
    t.outputTokens = record.tokens.output;
    t.inputTokens = record.tokens.input;
    t.cacheReadTokens = record.tokens.cacheRead;
    t.cacheWriteTokens = record.tokens.cacheWrite;
    t.thinkingTokens = record.tokens.thinking;
    return t;
  });
  const byFullId = new Map(turns.map((t) => [t.fullId, t]));
  turns.sort((a, b) => a.tsMicros - b.tsMicros);
  for (const t of turns) {
    if (t.parentId) byFullId.get(t.parentId)?.children.push(t.fullId);
  }
  const roots = turns.filter((t) => !t.parentId).map((t) => t.fullId);
  return new Session({ id: '', agent: '', path: '', cwd: null, startedMicros: null, turns, roots });
}

/** `12m · ↑21.6k · 2 commits` */
function readmeTag(record: TurnRecord): string {
  const parts = [humanizeDuration(record.durationS)];
  const out = record.tokens.output + record.tokens.thinking;
  parts.push(`↑${humanizeNumber(out)}`);
  const n = commitShas(record).length;
  if (n) parts.push(`${n} commit${n === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * gitGraph lines for the README: the shared tree walk, with the commit tags
 * replaced by the store's own (which carry the commit count).
 */
export function readmeGraphLines(records: RecordEntry[]): string[] {
  const session = syntheticSession(records);
  const byShort = new Map(records.map(({ record }) => [record.id, record]));
  const lines = buildGraphLines(session);
  return lines.map((line) => {
    const m = /^(\s*commit id: ")([^"]*)("\s*)(.*)$/.exec(line);
    if (!m) return line;
    const prefix = m[1] ?? '';
    const id = m[2] ?? '';
    const tail0 = m[4] ?? '';
    const foundRecord = byShort.get(id);
    if (!foundRecord) return line;
    const rest = tail0.replace(/\s*tag:\s*"(?:\\.|[^"\\])*"/, '').trim();
    const tail = rest ? ` ${rest}` : '';
    return `${prefix}${id}"${tail} tag: "${escQuotes(readmeTag(foundRecord))}"`;
  });
}

/** Short, host-agnostic commit link: works on GitHub and GitLab. */
export function commitLink(sha: string): string {
  return `[\`${sha.slice(0, 7)}\`](../../commit/${sha})`;
}

/** Regenerate `.promptlog/README.md`: mermaid gitGraph + markdown table. */
export function renderReadme(root: string): { path: string; text: string } {
  const records = allRecords(root).filter((r) => !r.record.isCommand);
  const out: string[] = [];
  const home = homepage();
  out.push('# promptlog');
  out.push('');
  out.push('Redacted prompt records for this repository, written by');
  out.push(`${home ? `[promptlog](${home})` : 'promptlog'} git hooks. Generated file: do not edit.`);
  out.push('');
  if (records.length) {
    out.push('```mermaid');
    out.push(readmeGraphLines(records).join('\n'));
    out.push('```');
    out.push('');
  }
  out.push('| prompt | time | duration | tokens | first line | commits |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const { gid, record } of records) {
    const tok = record.tokens;
    const tokens = `↑${humanizeNumber(tok.output + tok.thinking)} ↓${humanizeNumber(tok.input + tok.cacheRead + tok.cacheWrite)}`;
    const commits = commitShas(record).map(commitLink).join(' ');
    out.push(
      `| \`${mdEscape(gid)}\` | ${compactUtc(record.ts)} | ${humanizeDuration(record.durationS)} | ${tokens} | ` +
        `${mdEscape(firstLine(record.prompt, 80))} | ${commits} |`,
    );
  }
  out.push('');
  const text = out.join('\n');
  writeAtomic(readmePath(root), text);
  return { path: readmePath(root), text };
}
