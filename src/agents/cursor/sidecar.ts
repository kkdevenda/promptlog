/**
 * Read-only SQLite sidecar lookup for Cursor's global state DB, which holds
 * real per-bubble timestamps and token counts that never appear in the
 * transcript JSONL.
 *
 * ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * table `cursorDiskKV`, keys `bubbleId:<composerId>:<bubbleId>` -> JSON
 * blob with (at least) `type` (1 = user, 2 = assistant), `createdAt` (ISO
 * string) and `tokenCount: {inputTokens, outputTokens}`.
 *
 * `composerId` is the transcript's uuid (verified against real data on this
 * machine: `bubbleId:<sessionId>:%` rows exist for every transcript that has
 * a matching composer in the DB).
 *
 * Never writes to the DB. Tries node:sqlite first (Node >= 22.5, no flag
 * needed on Node 24), then shells out to the `sqlite3` CLI in read-only /
 * immutable mode if present on PATH, else reports itself unavailable and
 * callers fall back to the text-embedded approximate timestamps.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { isFile } from '../../core/fsutil';
import { rec, tryParse } from '../../core/json';
import { entryPoint } from '../../core/paths';

function stateDbPath(home?: string | null): string {
  return path.join(
    home || os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
}

// Minimal shape of node:sqlite's synchronous API, not shipped in the
// project's @types/node yet.
interface SqliteRow {
  value?: unknown;
}
interface SqliteStatement {
  all(...params: unknown[]): SqliteRow[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase;

let nodeSqliteProbe: DatabaseSyncCtor | false | null = null; // null = not probed yet

function probeNodeSqlite(): DatabaseSyncCtor | false {
  if (nodeSqliteProbe !== null) return nodeSqliteProbe;
  try {
    const req = createRequire(entryPoint());
    const mod = req('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    nodeSqliteProbe = mod.DatabaseSync;
  } catch {
    nodeSqliteProbe = false;
  }
  return nodeSqliteProbe;
}

let sqliteCliProbe: boolean | null = null;

function probeSqliteCli(): boolean {
  if (sqliteCliProbe !== null) return sqliteCliProbe;
  try {
    const res = spawnSync('sqlite3', ['-version'], { encoding: 'utf-8' });
    sqliteCliProbe = !res.error && res.status === 0;
  } catch {
    sqliteCliProbe = false;
  }
  return sqliteCliProbe;
}

/** Which backend would be used on this machine, without touching the DB.
 * Exposed for diagnostics/doctor. */
export function backend(): 'node:sqlite' | 'sqlite3' | 'none' {
  if (probeNodeSqlite()) return 'node:sqlite';
  if (probeSqliteCli()) return 'sqlite3';
  return 'none';
}

// Hard ceiling on how long the sidecar is allowed to spend: a locked or
// enormous state.vscdb must never make a `promptlog` invocation (especially
// under a git hook) noticeably slower. Callers fall back to the
// text-embedded approximate timestamps when this is exceeded.
const SIDECAR_TIMEOUT_MS = 500;
// Bounds the result set regardless of how many bubbles a composer has -
// timestamps/tokens are only ever read for a single transcript's worth of
// turns, which never needs more than this.
const BUBBLE_ROW_LIMIT = 500;

export interface BubbleRow {
  type?: unknown;
  createdAt?: unknown;
  tokenCount?: unknown;
}

function bubblesViaNodeSqlite(dbPath: string, composerId: string): BubbleRow[] | null {
  const DatabaseSync = probeNodeSqlite();
  if (!DatabaseSync) return null;
  const deadline = Date.now() + SIDECAR_TIMEOUT_MS;
  let db: SqliteDatabase;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Never block waiting on a writer (a running Cursor instance) past our
    // own budget: busy_timeout is in milliseconds and applies per-statement.
    db.exec(`PRAGMA busy_timeout = ${SIDECAR_TIMEOUT_MS}`);
  } catch {
    return null;
  }
  try {
    // GLOB (not LIKE) so the pattern is never subject to LIKE's '%'/'_'
    // escaping rules, bounded with LIMIT so one composer can never make us
    // read an unbounded number of rows.
    const stmt = db.prepare('select key, value from cursorDiskKV where key glob ? limit ?');
    const rows = stmt.all(`bubbleId:${composerId}:*`, BUBBLE_ROW_LIMIT);
    const out: BubbleRow[] = [];
    for (const row of rows) {
      if (Date.now() > deadline) break; // budget exceeded mid-parse; return what we have
      if (typeof row.value !== 'string') continue;
      const parsed = rec(tryParse(row.value));
      if (parsed) out.push(parsed);
    }
    return out;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function bubblesViaSqliteCli(dbPath: string, composerId: string): BubbleRow[] | null {
  // GLOB, not LIKE (no '%'/'_' escaping to worry about), and bounded with
  // LIMIT so one composer can never make us read/parse an unbounded number
  // of rows. read-only + immutable so we never touch a DB a running Cursor
  // instance might have locked for writing.
  const uri = `file:${dbPath}?mode=ro&immutable=1`;
  const sql = `select value from cursorDiskKV where key glob 'bubbleId:${composerId}:*' limit ${BUBBLE_ROW_LIMIT};`;
  let res: ReturnType<typeof spawnSync>;
  try {
    // `timeout` (child_process, milliseconds) is the hard ceiling: if
    // sqlite3 hasn't returned by then it is SIGTERM'd and we fall back.
    res = spawnSync('sqlite3', ['-readonly', uri, sql], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: SIDECAR_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (res.error || res.status !== 0) return null;
  const out: BubbleRow[] = [];
  for (const line of String(res.stdout).split('\n')) {
    if (!line) continue;
    const parsed = rec(tryParse(line));
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Return every bubble row for `composerId` (a Cursor transcript's uuid),
 * each `{type, createdAt, tokenCount}` (plus whatever else was stored), or
 * null if the sidecar is unavailable/unreadable/absent. Empty array means
 * "sidecar readable, but this composer has no rows" (e.g. DB doesn't cover
 * this transcript, or it predates bubble-level storage).
 */
export function readBubbles(composerId: string, home?: string | null): BubbleRow[] | null {
  const dbPath = stateDbPath(home);
  if (!isFile(dbPath)) return null;
  if (probeNodeSqlite()) {
    const rows = bubblesViaNodeSqlite(dbPath, composerId);
    if (rows !== null) return rows;
  }
  if (probeSqliteCli()) {
    const rows = bubblesViaSqliteCli(dbPath, composerId);
    if (rows !== null) return rows;
  }
  return null;
}

export { stateDbPath };
