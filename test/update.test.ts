/**
 * Published-version update check (src/core/updateCheck.ts). See
 * docs/DESIGN.md "Agent surfaces" and README.md "Privacy" for the contract.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { slug } from '../src/agents/claude/locate';
import * as updateCheck from '../src/core/updateCheck';

const BIN = path.join(__dirname, '..', 'bin', 'promptlog.js');

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-update-test-'));
}

function cleanup(home: string): void {
  fs.rmSync(home, { recursive: true, force: true });
}

function writeCache(home: string, data: unknown): void {
  const p = updateCheck.cachePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), 'utf-8');
}

// -------------------------------------------------------------- semver compare

test('compareSemver: newer, older, equal, prerelease vs release', () => {
  expect(updateCheck.compareSemver('0.4.0', '0.3.0')).toBe(1);
  expect(updateCheck.compareSemver('0.3.0', '0.4.0')).toBe(-1);
  expect(updateCheck.compareSemver('0.3.0', '0.3.0')).toBe(0);
  expect(updateCheck.compareSemver('1.0.0', '1.0.0-beta.1')).toBe(1);
  expect(updateCheck.compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1);
});

// -------------------------------------------------------------- cache freshness

test('checkUpdate: fresh cache never calls fetch', async () => {
  const home = makeHome();
  writeCache(home, { checkedAt: Date.now() - 1000, latest: '0.3.0', source: 'npm' });
  let called = false;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      called = true;
      return { latest: '9.9.9', source: 'npm' };
    },
  });
  expect(called).toBe(false);
  expect(hint).toBe(null); // cached latest == running -> no hint
  cleanup(home);
});

test('checkUpdate: fresh cache with a cached newer latest still hints, without fetching', async () => {
  const home = makeHome();
  writeCache(home, { checkedAt: Date.now() - 1000, latest: '9.9.9', source: 'npm' });
  let called = false;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: path.join(home, 'nowhere'),
    running: '0.3.0',
    fetch: async () => {
      called = true;
      return { latest: '0.0.1', source: 'npm' };
    },
  });
  expect(called).toBe(false);
  expect(hint).toMatch(/^promptlog 0\.3\.0 → 9\.9\.9 · update: /);
  cleanup(home);
});

test('checkUpdate: stale cache + newer latest -> hint line, one command per install location', async () => {
  const home = makeHome();

  // 1. our own recorded install
  {
    fs.mkdirSync(path.join(home, '.promptlog'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.promptlog', 'skill-installs.json'),
      JSON.stringify({
        installs: [{ agent: 'claude', path: path.join(home, '.claude', 'skills', 'promptlog') }],
      }),
    );
    const dirname = path.join(home, '.claude', 'skills', 'promptlog', 'scripts', 'src', 'core');
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: promptlog skill update');
    fs.rmSync(path.join(home, '.promptlog', 'skill-installs.json'));
  }

  // 2. Codex plugin cache
  {
    const dirname = path.join(home, '.codex', 'plugins', 'cache', 'promptlog', 'src', 'core');
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: codex plugin marketplace upgrade promptlog');
  }

  // 3. Claude plugin path
  {
    const dirname = path.join(home, '.claude', 'plugins', 'promptlog', 'src', 'core');
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: /plugin update promptlog in Claude Code');
  }

  // 4. skills.sh install via ~/.agents/skills
  {
    const dirname = path.join(home, '.agents', 'skills', 'promptlog', 'src', 'core');
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: npx skills update');
  }

  // 4b. skills.sh install detected via a nearby .skills-lock instead
  {
    const dirname = path.join(home, 'somewhere', 'skills', 'promptlog', 'src', 'core');
    fs.mkdirSync(dirname, { recursive: true });
    fs.writeFileSync(path.join(home, 'somewhere', 'skills', 'promptlog', '.skills-lock'), '{}');
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: npx skills update');
  }

  // 5. otherwise: plain npm global install
  {
    const dirname = path.join(
      home,
      'usr',
      'local',
      'lib',
      'node_modules',
      '@kkdevenda',
      'promptlog',
      'src',
      'core',
    );
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname,
      running: '0.3.0',
      fetch: async () => ({ latest: '0.4.0', source: 'npm' }),
    });
    expect(hint).toBe('promptlog 0.3.0 → 0.4.0 · update: npm i -g @kkdevenda/promptlog');
  }

  cleanup(home);
});

test('checkUpdate: equal or older latest -> no hint line', async () => {
  const home = makeHome();
  for (const latest of ['0.3.0', '0.2.0']) {
    const hint = await updateCheck.checkUpdate({
      env: {},
      values: {},
      home,
      dirname: home,
      running: '0.3.0',
      fetch: async () => ({ latest, source: 'npm' }),
    });
    expect(hint).toBe(null);
  }
  cleanup(home);
});

test('checkUpdate: fetch throws -> no hint, cache still recorded (latest: null)', async () => {
  const home = makeHome();
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      throw new Error('boom');
    },
  });
  expect(hint).toBe(null);
  const cache = updateCheck.readUpdateCache(home);
  expect(cache && typeof cache.checkedAt === 'number').toBeTruthy();
  expect(cache?.latest).toBe(null);
  cleanup(home);
});

// -------------------------------------------------------------- concurrency claim

test('checkUpdate: stale cache is claimed (pending:true) before fetch resolves, and pending is dropped after', async () => {
  const home = makeHome();
  writeCache(home, { checkedAt: Date.now() - 2 * updateCheck.MAX_AGE_MS, latest: '0.2.0', source: 'github' });
  const now = Date.now();
  let seenDuringFetch: updateCheck.UpdateCache | null = null;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    now,
    fetch: async () => {
      seenDuringFetch = updateCheck.readUpdateCache(home);
      await new Promise((r) => setTimeout(r, 10));
      return { latest: '0.4.0', source: 'npm' };
    },
  });
  expect(seenDuringFetch, 'cache must exist while fetch is in flight').toBeTruthy();
  expect((seenDuringFetch as unknown as updateCheck.UpdateCache).pending).toBe(true);
  expect((seenDuringFetch as unknown as updateCheck.UpdateCache).checkedAt).toBe(now);
  expect(
    (seenDuringFetch as unknown as updateCheck.UpdateCache).latest,
    'previous latest carried over into the claim',
  ).toBe('0.2.0');
  expect((seenDuringFetch as unknown as updateCheck.UpdateCache).source).toBe('github');
  expect(hint).toMatch(/^promptlog 0\.3\.0 → 0\.4\.0 · update: /);
  const after = updateCheck.readUpdateCache(home);
  expect(after?.pending).toBe(undefined);
  expect(after?.latest).toBe('0.4.0');
  expect(after?.source).toBe('npm');
  expect(after?.checkedAt).toBe(now);
  cleanup(home);
});

test('checkUpdate: no prior cache -> claim has latest:null; a concurrent run sees it fresh and does not fetch', async () => {
  const home = makeHome();
  let secondCalled = false;
  let secondHint: string | null | undefined;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      const claim = updateCheck.readUpdateCache(home);
      expect(claim?.pending).toBe(true);
      expect(claim?.latest).toBe(null);
      // Simulate the second process starting while the first is fetching.
      secondHint = await updateCheck.checkUpdate({
        env: {},
        values: {},
        home,
        dirname: home,
        running: '0.3.0',
        fetch: async () => {
          secondCalled = true;
          return { latest: '8.8.8', source: 'npm' };
        },
      });
      return { latest: '0.4.0', source: 'npm' };
    },
  });
  expect(secondCalled).toBe(false);
  expect(secondHint).toBe(null); // claim carried latest:null -> nothing to show
  expect(hint).toMatch(/→ 0\.4\.0/);
  expect(updateCheck.readUpdateCache(home)?.pending).toBe(undefined);
  cleanup(home);
});

// -------------------------------------------------------------- bounded body read

test('collectBody: joins chunks under the cap and resolves text', async () => {
  const s = Readable.from([Buffer.from('{"vers'), Buffer.from('ion":"1.2.3"}')]);
  const body = await updateCheck.collectBody(s, { maxBytes: 1024, timeoutMs: 1000 });
  expect(JSON.parse(body).version).toBe('1.2.3');
});

test('collectBody: rejects `response too large` once bytes exceed 64 KB and destroys the stream', async () => {
  expect(updateCheck.MAX_BODY_BYTES).toBe(64 * 1024);
  const chunk = Buffer.alloc(16 * 1024, 0x61);
  let pushed = 0;
  const s = new Readable({
    read() {
      pushed += 1;
      this.push(chunk); // never ends on its own; the cap must stop it
    },
  });
  await expect(updateCheck.collectBody(s, { timeoutMs: 5000 })).rejects.toThrow(/response too large/);
  expect(s.destroyed).toBe(true);
  expect(pushed >= 5 && pushed < 50, `stopped promptly after the cap, pushed=${pushed}`).toBeTruthy();
});

test('collectBody: the cap counts bytes, not characters', async () => {
  // 30k chars of a 3-byte code point = 90 KB on the wire, well under 64k chars.
  const text = '€'.repeat(30 * 1024);
  const s = Readable.from([Buffer.from(text, 'utf-8')]);
  await expect(updateCheck.collectBody(s, { timeoutMs: 5000 })).rejects.toThrow(/response too large/);
  const ok = Readable.from([Buffer.from('€'.repeat(1000), 'utf-8')]);
  expect(await updateCheck.collectBody(ok, { timeoutMs: 5000 })).toBe('€'.repeat(1000));
});

test('collectBody: absolute deadline fires even while data keeps trickling in', async () => {
  let timer: NodeJS.Timeout;
  const s = new Readable({
    read() {},
    destroy(err, cb) {
      clearInterval(timer);
      cb(err);
    },
  });
  timer = setInterval(() => s.push('x'), 50);
  const started = Date.now();
  await expect(updateCheck.collectBody(s, { maxBytes: 1 << 20, timeoutMs: 200 })).rejects.toThrow(/timeout/);
  const elapsed = Date.now() - started;
  expect(elapsed >= 150 && elapsed < 1500, `deadline fired at ~200ms, got ${elapsed}ms`).toBeTruthy();
  expect(s.destroyed).toBe(true);
  clearInterval(timer);
});

test('collectBody: stream error rejects', async () => {
  const s = new Readable({ read() {} });
  const p = updateCheck.collectBody(s, { timeoutMs: 1000 });
  s.destroy(new Error('boom'));
  await expect(p).rejects.toThrow(/boom/);
});

// -------------------------------------------------------------- off switch

test('checkUpdate: PROMPTLOG_NO_UPDATE_CHECK=1 skips the fetch entirely', async () => {
  const home = makeHome();
  let called = false;
  const hint = await updateCheck.checkUpdate({
    env: { PROMPTLOG_NO_UPDATE_CHECK: '1' },
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      called = true;
      return { latest: '0.4.0', source: 'npm' };
    },
  });
  expect(called).toBe(false);
  expect(hint).toBe(null);
  expect(updateCheck.readUpdateCache(home)).toBe(null); // no cache write either
  cleanup(home);
});

test('checkUpdate: --no-update-check flag skips the fetch', async () => {
  const home = makeHome();
  let called = false;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: { 'no-update-check': true },
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      called = true;
      return { latest: '0.4.0', source: 'npm' };
    },
  });
  expect(called).toBe(false);
  expect(hint).toBe(null);
  cleanup(home);
});

test('checkUpdate: ~/.promptlog/config.json {"updateCheck": false} skips the fetch', async () => {
  const home = makeHome();
  fs.mkdirSync(path.join(home, '.promptlog'), { recursive: true });
  fs.writeFileSync(path.join(home, '.promptlog', 'config.json'), JSON.stringify({ updateCheck: false }));
  let called = false;
  const hint = await updateCheck.checkUpdate({
    env: {},
    values: {},
    home,
    dirname: home,
    running: '0.3.0',
    fetch: async () => {
      called = true;
      return { latest: '0.4.0', source: 'npm' };
    },
  });
  expect(called).toBe(false);
  expect(hint).toBe(null);
  cleanup(home);
});

// -------------------------------------------------------------- CLI (needs the built bundle)

describe('CLI', () => {
  test('hook/statusline paths never touch the update-check cache', () => {
    const home = makeHome();
    const r = spawnSync(process.execPath, [BIN, 'statusline'], {
      encoding: 'utf-8',
      input: 'not json at all {{{',
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(updateCheck.cachePath(home))).toBe(false);
    cleanup(home);
  });

  test('PROMPTLOG_NO_UPDATE_CHECK=1 keeps `status` from printing a hint', () => {
    const home = makeHome();
    const r = spawnSync(process.execPath, [BIN, 'status'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, NO_COLOR: '1', PROMPTLOG_NO_UPDATE_CHECK: '1' },
    });
    expect(r.stdout).not.toMatch(/update:/);
    cleanup(home);
  });

  test('with --json the hint goes to stderr, so stdout still parses', () => {
    const home = makeHome();
    writeCache(home, { checkedAt: Date.now() - 1000, latest: '99.0.0', source: 'npm' });
    const FIXTURE = path.join(__dirname, 'fixtures', 'claude', 'branch.jsonl');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
    delete env.PROMPTLOG_NO_UPDATE_CHECK;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', env });

    const st = run(['--session', FIXTURE, 'status', '--json']);
    expect(st.status, st.stderr).toBe(0);
    expect(() => JSON.parse(st.stdout), `status --json stdout must parse: ${st.stdout}`).not.toThrow();
    expect(st.stderr).toMatch(/promptlog 0\.5\.0 → 99\.0\.0/);

    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-update-cwd-')));
    const sid = '0e0e0e0e-1111-4222-8333-444455556666';
    const dir = path.join(home, '.claude', 'projects', slug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${sid}.jsonl`),
      `${[
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          isSidechain: false,
          sessionId: sid,
          cwd,
          timestamp: '2026-09-02T10:01:00Z',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          isSidechain: false,
          sessionId: sid,
          cwd,
          timestamp: '2026-09-02T10:02:00Z',
          message: {
            id: 'm1',
            role: 'assistant',
            model: 'm',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
    );
    const se = spawnSync(process.execPath, [BIN, 'sessions', '--json'], { encoding: 'utf-8', env, cwd });
    fs.rmSync(cwd, { recursive: true, force: true });
    expect(se.status, se.stderr).toBe(0);
    const list = JSON.parse(se.stdout);
    expect(Array.isArray(list) && list.length === 1, se.stdout).toBeTruthy();
    expect(se.stderr).toMatch(/promptlog 0\.5\.0 → 99\.0\.0/);

    const plain = run(['--session', FIXTURE, 'status']);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toMatch(/promptlog 0\.5\.0 → 99\.0\.0/);
    expect(plain.stderr).not.toMatch(/update:/);
    cleanup(home);
  });
});
