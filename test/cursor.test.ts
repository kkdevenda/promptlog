import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { cursor } from '../src/agents/cursor';
import { edits as cursorEdits } from '../src/agents/cursor/edits';
import * as locate from '../src/agents/cursor/locate';
import { isPromptRecord, parseCursorSession, parseCursorTimestampText } from '../src/agents/cursor/parser';
import type { Session } from '../src/core/model';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'cursor');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-cursor-test-'));
}

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

function userRec(text: string) {
  return { role: 'user', message: { content: [{ type: 'text', text }] } };
}

function assistantRec(blocks: unknown[]) {
  return { role: 'assistant', message: { content: blocks } };
}

/** Cursor turns carry a side `tsApprox` flag (see parser.ts) not part of the
 * shared Turn model; read it back for the tests that check it. */
function tsApprox(t: object): boolean {
  return (t as { tsApprox?: boolean }).tsApprox === true;
}

// ---- parser: real (redacted) fixtures -----------------------------------

describe('cursor parser', () => {
  test('multi-turn fixture parses into 6 turns with unique ids, timestamps, tools, response', () => {
    const session = parseCursorSession(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    expect(session.agent).toBe('cursor');
    expect(session.turns.length).toBe(6);

    const ids = new Set<string>();
    const fullIds = new Set<string>();
    for (const t of session.turns) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(fullIds.has(t.fullId)).toBe(false);
      fullIds.add(t.fullId);
      expect(Number.isFinite(t.tsMicros)).toBe(true);
      expect(tsApprox(t)).toBe(true); // no sidecar row will match this fixture's fake uuid
      expect(t.response).toBeTruthy();
      expect(t.responsePending).toBe(false);
    }

    // chronological and chained
    for (let i = 1; i < session.turns.length; i++) {
      expect(session.turns[i]?.tsMicros).toBeGreaterThanOrEqual(session.turns[i - 1]?.tsMicros ?? 0);
      expect(session.turns[i]?.parentId).toBe(session.turns[i - 1]?.fullId);
    }
    expect(session.turns[0]?.parentId).toBe(null);

    // tool counts observed in the real transcript this fixture is redacted from
    expect(session.turns[0]?.toolCalls).toBe(6);
    expect(Object.fromEntries(session.turns[0]?.toolNames ?? [])).toEqual({ rg: 1, ReadFile: 1, Shell: 4 });
    expect(session.turns[3]?.toolCalls).toBe(9);
  });

  test('apply-patch fixture extracts files from ApplyPatch and ReadFile tool_use blocks', () => {
    const session = parseCursorSession(path.join(FIXTURES_DIR, 'apply-patch.jsonl'));
    expect(session.turns.length).toBe(1);
    const t = session.turns[0];
    expect(t?.toolNames.get('ApplyPatch')).toBe(4);
    expect(t?.toolNames.get('ReadFile')).toBe(12);
    expect(t?.files.has('/repo/src/module_7.py')).toBe(true);
    expect(t?.files.has('/repo/src/module_1.py')).toBe(true);
    expect(t?.response).toBeTruthy();
  });

  // ---- timestamp parsing --------------------------------------------------

  test('embedded timestamp text parses to the correct UTC instant', () => {
    const micros = parseCursorTimestampText('Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)');
    expect(micros).not.toBe(null);
    const iso = new Date((micros as number) / 1000).toISOString();
    // 3:09 PM UTC+5:30 == 09:39 UTC
    expect(iso).toBe('2026-09-01T09:39:00.000Z');
  });

  test('unparsable timestamp text returns null', () => {
    expect(parseCursorTimestampText('not a timestamp')).toBe(null);
    expect(parseCursorTimestampText(null)).toBe(null);
  });

  // ---- prompt extraction / skip logic -------------------------------------

  test('prompt text is the inner <user_query> content, timestamp tag stripped', () => {
    const rec = userRec(
      '<timestamp>Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)</timestamp>\n<user_query>\nfix the bug\n</user_query>',
    );
    expect(isPromptRecord(rec)).toBe('fix the bug');
  });

  test('<user_query> is found even behind an attachment preamble', () => {
    const rec = userRec(
      '[Image]\n<image_files>\nsome/path.png\n</image_files>\n<timestamp>Monday, Jun 15, 2026, 1:26 PM (UTC+5:30)</timestamp>\n<user_query>\nlook at this image\n</user_query>',
    );
    expect(isPromptRecord(rec)).toBe('look at this image');
  });

  test('no <user_query> tag falls back to the whole stripped text', () => {
    const rec = userRec(
      '<timestamp>Monday, Jun 15, 2026, 1:26 PM (UTC+5:30)</timestamp>\nplain freeform text, no tag',
    );
    expect(isPromptRecord(rec)).toBe('plain freeform text, no tag');
  });

  test('empty text after stripping is not a prompt (context/attachment-only)', () => {
    const rec = userRec('<timestamp>Monday, Jun 15, 2026, 1:26 PM (UTC+5:30)</timestamp>\n   ');
    expect(isPromptRecord(rec)).toBe(null);
  });

  test('assistant records and turn_ended markers are never prompts', () => {
    expect(isPromptRecord(assistantRec([{ type: 'text', text: 'hi' }]))).toBe(null);
    expect(isPromptRecord({ type: 'turn_ended', status: 'success' })).toBe(null);
  });

  test('turn = prompt until next prompt (turn_ended is not a boundary)', () => {
    const p = tmpDir();
    const file = path.join(p, 's.jsonl');
    writeJsonl(file, [
      userRec(
        '<timestamp>Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)</timestamp>\n<user_query>\nfirst\n</user_query>',
      ),
      assistantRec([
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', name: 'ReadFile', input: { path: '/a.py' } },
      ]),
      assistantRec([{ type: 'text', text: 'done with first' }]),
      { type: 'turn_ended', status: 'success' },
      userRec(
        '<timestamp>Tuesday, Sep 1, 2026, 4:42 PM (UTC+5:30)</timestamp>\n<user_query>\nsecond\n</user_query>',
      ),
      assistantRec([{ type: 'text', text: 'done with second' }]),
      { type: 'turn_ended', status: 'success' },
    ]);
    const session = parseCursorSession(file);
    expect(session.turns.length).toBe(2);
    expect(session.turns[0]?.prompt).toBe('first');
    expect(session.turns[0]?.response).toBe('done with first');
    expect(session.turns[0]?.toolCalls).toBe(1);
    expect(session.turns[1]?.prompt).toBe('second');
    expect(session.turns[1]?.response).toBe('done with second');
  });

  test('no assistant text yet -> responsePending', () => {
    const p = tmpDir();
    const file = path.join(p, 's.jsonl');
    writeJsonl(file, [
      userRec(
        '<timestamp>Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)</timestamp>\n<user_query>\nfirst\n</user_query>',
      ),
      assistantRec([{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }]),
    ]);
    const session = parseCursorSession(file);
    expect(session.turns.length).toBe(1);
    expect(session.turns[0]?.response).toBe(null);
    expect(session.turns[0]?.responsePending).toBe(true);
  });

  test('gid format is agent:sessionId8:shortId', () => {
    const session = parseCursorSession(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    const gidRe = /^cursor:[^:]{0,8}:[^:]+$/;
    for (const t of session.turns) expect(t.gid).toMatch(gidRe);
  });
});

// ---- locate: slug derivation and discovery ------------------------------

describe('cursor locate', () => {
  test('slug strips the leading slash and joins with "-" (no leading dash, unlike Claude)', () => {
    expect(locate.slug('/Users/krishna/Developer/whatsareyouworkingon')).toBe(
      'Users-krishna-Developer-whatsareyouworkingon',
    );
  });

  function writeCursorTranscript(
    home: string,
    opts: { cwd: string; sessionId: string; records: unknown[]; mtimeMs?: number },
  ): string {
    const slugDir = path.join(home, '.cursor', 'projects', locate.slug(opts.cwd));
    const dir = path.join(slugDir, 'agent-transcripts', opts.sessionId);
    const p = path.join(dir, `${opts.sessionId}.jsonl`);
    writeJsonl(p, opts.records);
    if (opts.mtimeMs != null) fs.utimesSync(p, opts.mtimeMs / 1000, opts.mtimeMs / 1000);
    return p;
  }

  function minimalRecords() {
    return [
      userRec(
        '<timestamp>Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)</timestamp>\n<user_query>\nhi\n</user_query>',
      ),
      assistantRec([{ type: 'text', text: 'hello' }]),
    ];
  }

  test('locate finds a transcript under cwd and ignores subagents/', () => {
    const home = tmpDir();
    const repoRoot = path.join(home, 'work', 'myrepo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    const p = writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '11111111-1111-1111-1111-111111111111',
      records: minimalRecords(),
    });

    // a subagents/ transcript that must never be returned by locate()
    const subDir = path.join(path.dirname(p), 'subagents', '22222222-2222-2222-2222-222222222222');
    writeJsonl(path.join(subDir, '22222222-2222-2222-2222-222222222222.jsonl'), minimalRecords());

    const found = locate.locate({ cwd: repoRoot, home, since: 0 });
    expect(found.length).toBe(1);
    expect(found[0]?.path).toBe(p);
    expect(found[0]?.sessionId).toBe('11111111-1111-1111-1111-111111111111');
  });

  test('findSession resolves by uuid prefix', () => {
    const home = tmpDir();
    const repoRoot = path.join(home, 'work', 'myrepo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    const p = writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: 'abcdef01-1111-1111-1111-111111111111',
      records: minimalRecords(),
    });
    const found = locate.findSession('abcdef01', { cwd: repoRoot, home });
    expect(found).toBe(p);
  });

  test('findSession with no id returns the newest transcript for cwd', () => {
    const home = tmpDir();
    const repoRoot = path.join(home, 'work', 'myrepo');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '11111111-1111-1111-1111-111111111111',
      records: minimalRecords(),
      mtimeMs: 1000000,
    });
    const newer = writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '22222222-2222-2222-2222-222222222222',
      records: minimalRecords(),
      mtimeMs: 2000000,
    });
    const found = locate.findSession(null, { cwd: repoRoot, home });
    expect(found).toBe(newer);
  });

  // ---- cwd resolution: never reverse a lossy slug ------------------------

  test('session.cwd is the real, known cwd when found via locate() (hyphenated dir name)', () => {
    const home = tmpDir();
    // A directory name containing hyphens is exactly the case a naive
    // slug-reversal (replace "-" with "/") gets wrong: this real cwd has
    // hyphens inside path segments, e.g. "data-pipelines" would wrongly
    // become "data/pipelines".
    const repoRoot = path.join(home, 'work', 'data-pipelines', 'dagster-pipelines', 'sync-sku-mappings');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '33333333-3333-3333-3333-333333333333',
      records: minimalRecords(),
    });

    const found = locate.locate({ cwd: repoRoot, home, since: 0 });
    expect(found.length).toBe(1);

    const session = parseCursorSession(found[0]?.path ?? '');
    expect(session.cwd).toBe(repoRoot);
    expect(session.cwd).not.toBe(`/${locate.slug(repoRoot).split('-').join('/')}`);
  });

  test("session.cwd falls back to Cursor's workspaceStorage/workspace.json when nothing was locate()d first", () => {
    const home = tmpDir();
    const repoRoot = path.join(home, 'work', 'data-pipelines', 'dagster-pipelines', 'sync-sku-mappings');
    fs.mkdirSync(repoRoot, { recursive: true });
    const p = writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '44444444-4444-4444-4444-444444444444',
      records: minimalRecords(),
    });

    const hash = 'deadbeef00000000000000000000000';
    const wsDir = path.join(locate.workspaceStorageDir(home), hash);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, 'workspace.json'),
      JSON.stringify({ folder: `file://${repoRoot}` }),
      'utf-8',
    );

    // parse() directly, bypassing locate()/findSession() entirely, so there is
    // no cache entry — this exercises the workspaceStorage fallback alone.
    const session = parseCursorSession(p);
    expect(session.cwd).toBe(repoRoot);
  });

  test('session.cwd falls back to the raw slug string (not a path) when nothing matches', () => {
    const home = tmpDir();
    const repoRoot = path.join(home, 'work', 'some-unmatched-project');
    fs.mkdirSync(repoRoot, { recursive: true });
    const p = writeCursorTranscript(home, {
      cwd: repoRoot,
      sessionId: '55555555-5555-5555-5555-555555555555',
      records: minimalRecords(),
    });

    // No workspaceStorage dir at all on this fake HOME, and parse() called
    // directly so there is no locate() cache entry either.
    const session = parseCursorSession(p);
    expect(session.cwd).toBe(locate.slug(repoRoot));
    expect(session.cwd?.startsWith('/')).toBe(false);
  });
});

// ---- adapter wiring -------------------------------------------------------

describe('cursor adapter', () => {
  test('detectInstalled is true iff ~/.cursor exists', () => {
    const home = tmpDir();
    expect(cursor.detectInstalled(home)).toBe(false);
    fs.mkdirSync(path.join(home, '.cursor'));
    expect(cursor.detectInstalled(home)).toBe(true);
  });

  test('skillDirs points at user ~/.cursor/skills and project .cursor/skills', () => {
    const home = '/home/u';
    expect(cursor.skillDirs('user', home, '/repo')).toEqual([path.join(home, '.cursor', 'skills')]);
    expect(cursor.skillDirs('project', home, '/repo')).toEqual([path.join('/repo', '.cursor', 'skills')]);
  });

  test("capabilities and sessionEnvVars match this adapter's phase", () => {
    expect(cursor.id).toBe('cursor');
    expect(cursor.sessionEnvVars).toEqual([]);
    expect(cursor.capabilities.parse).toBe(true);
    expect(cursor.capabilities.liveSession).toBe(false);
    expect(cursor.capabilities.edits).toBe(true);
    expect(cursor.capabilities.tokens).toBe(false);
    expect(cursor.capabilities.tokensPartial).toBe(true);
    expect(cursor.edits({ path: null, turns: [] } as unknown as Session, { root: '' })).toEqual([]);
  });

  test('adapter.parse is parseCursorSession', () => {
    const session = cursor.parse(path.join(FIXTURES_DIR, 'multi-turn.jsonl'));
    expect(session.turns.length).toBe(6);
  });

  test('sessionIdFor reads the uuid from the filename without a full parse', () => {
    expect(cursor.sessionIdFor('/x/agent-transcripts/abc-123/abc-123.jsonl')).toBe('abc-123');
  });
});

// ---- edits: tier A (ApplyPatch) and tier B (Shell) ----------------------

describe('cursor edits', () => {
  test('capabilities.edits is true and adapter.edits is wired to edits.ts', () => {
    expect(cursor.capabilities.edits).toBe(true);
    expect(cursor.edits).toBe(cursorEdits);
  });

  test('apply-patch fixture yields patch edits with correct file paths and non-empty hunks', () => {
    const session = cursor.parse(path.join(FIXTURES_DIR, 'apply-patch.jsonl'));
    const edits = cursor.edits(session, { root: '' });
    expect(edits.length).toBeGreaterThanOrEqual(4); // one edit per ApplyPatch call in the fixture
    for (const e of edits) {
      expect(e.kind).toBe('patch');
      expect(e.turnId).toBe(session.turns[0]?.gid);
      expect(e.file.startsWith('/repo/src/module_')).toBe(true);
      expect(Array.isArray(e.hunks) && (e.hunks?.length ?? 0) > 0).toBe(true);
    }
    const files = new Set(edits.map((e) => e.file));
    expect(files.has('/repo/src/module_7.py')).toBe(true);
    expect(files.has('/repo/src/module_2.py')).toBe(true);
    expect(files.has('/repo/src/module_10.py')).toBe(true);

    // at least one edit actually carries real hunk content (added and/or
    // removed lines), not just an empty placeholder hunk
    const withContent = edits.some((e) => e.hunks?.some((h) => h.added.length || h.removed.length));
    expect(withContent).toBe(true);
  });

  test('shell fixture yields shell edits for both a sed -i target and a redirect target', () => {
    const session = cursor.parse(path.join(FIXTURES_DIR, 'shell.jsonl'));
    expect(session.turns.length).toBe(1);
    const edits = cursor.edits(session, { root: '' });
    expect(edits.length).toBe(2);
    for (const e of edits) {
      expect(e.kind).toBe('shell');
      expect(e.turnId).toBe(session.turns[0]?.gid);
    }
    const files = new Set(edits.map((e) => e.file));
    expect(files.has('/repo/src/version.py')).toBe(true); // sed -i target extracted
    expect(files.has('/repo/CHANGELOG.md')).toBe(true); // redirect target extracted
  });

  test('edits() returns [] for a session with no turns or no path', () => {
    expect(cursorEdits(null)).toEqual([]);
    expect(cursorEdits({ path: null, turns: [] } as unknown as Session)).toEqual([]);
  });
});
