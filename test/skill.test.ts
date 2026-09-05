/**
 * `promptlog skill install|update|uninstall` (src/core/commands/skill.ts).
 * A couple of cases also exercise `doctor` where it is entangled with
 * uninstall behaviour; the standalone `doctor` cases live in
 * test/doctor.test.ts. Every case here spawns the built CLI bundle (`node
 * bin/promptlog.js`); `npm run build` runs first.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { shimBody, shimDir, shimName } from '../src/core/commands/skill';

const BIN = path.join(__dirname, '..', 'bin', 'promptlog.js');

// Shape of `promptlog doctor --json`'s stdout, just enough for the
// assertions below.
interface DoctorSkillInstall {
  path: string;
  version: string | null;
  scope: string;
  present: boolean;
  external: boolean;
  outdated: boolean;
}
interface DoctorAgent {
  id: string;
  installedOnMachine: boolean;
  parseCapable: boolean;
  skillInstalls: DoctorSkillInstall[];
}
interface DoctorInfo {
  agents: DoctorAgent[];
  path: Record<string, unknown>;
  repo: Record<string, unknown>;
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
}

function makeFakeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-skill-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(home, '.windsurf'), { recursive: true }); // no adapter
  return home;
}

describe('CLI', () => {
  test('skill install: writes into every adapter-backed agent, skips agents without an adapter, records paths', () => {
    const home = makeFakeHome();
    const r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    expect(r.stdout).toMatch(/Claude Code\s+ok\s+.*\.claude\/skills\/promptlog\s+v\d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/Codex CLI\s+ok\s+.*\.codex\/skills\/promptlog\s+v\d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/Cursor\s+ok\s+.*\.cursor\/skills\/promptlog\s+v\d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/Windsurf\s+detected, not supported yet/);

    const claudeDest = path.join(home, '.claude', 'skills', 'promptlog');
    const codexDest = path.join(home, '.codex', 'skills', 'promptlog');
    const cursorDest = path.join(home, '.cursor', 'skills', 'promptlog');
    expect(fs.existsSync(path.join(claudeDest, 'SKILL.md'))).toBeTruthy();
    expect(fs.existsSync(path.join(codexDest, 'SKILL.md'))).toBeTruthy();
    expect(fs.existsSync(path.join(claudeDest, 'scripts', 'promptlog.js'))).toBeTruthy();
    // never installed into a directory with no adapter
    expect(fs.existsSync(path.join(home, '.windsurf', 'skills'))).toBeFalsy();

    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    expect(fs.existsSync(recordPath)).toBeTruthy();
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    const paths = record.installs.map((i: { path: string }) => i.path).sort();
    expect(paths).toEqual([claudeDest, codexDest, cursorDest].sort());
    for (const entry of record.installs) {
      expect(entry.version).toBeTruthy();
      expect(entry.ts).toBeTruthy();
    }

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill install --path writes a shim', () => {
    const home = makeFakeHome();
    const env: NodeJS.ProcessEnv = { HOME: home };
    // On win32, `shimDir()` writes `promptlog.cmd` under
    // `%LOCALAPPDATA%\promptlog\bin` rather than `~/.local/bin/promptlog` -
    // `cmd.exe` never looks in the latter, and a plain shell script there
    // would never be found either.
    let shimPath: string;
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
      env.LOCALAPPDATA = localAppData;
      shimPath = path.join(localAppData, 'promptlog', 'bin', 'promptlog.cmd');
    } else {
      shimPath = path.join(home, '.local', 'bin', 'promptlog');
    }
    const r = run(['skill', 'install', '--path'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(shimPath)).toBeTruthy();
    const content = fs.readFileSync(shimPath, 'utf-8');
    expect(content).toMatch(process.platform === 'win32' ? /node/ : /exec node/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('the shim body and its location are platform-specific (`platform` is injectable)', () => {
    const script = '/opt/promptlog/scripts/promptlog.js';

    // POSIX: a `sh` shim named `promptlog` in `~/.local/bin`.
    const posix = shimBody(script, 'linux');
    expect(posix).toMatch(/^#!\/usr\/bin\/env sh/);
    expect(posix).toContain(`exec node "${script}" "$@"`);
    expect(shimName('linux')).toBe('promptlog');
    expect(shimDir('/home/alice', { platform: 'linux', env: {} })).toBe(
      path.join('/home/alice', '.local', 'bin'),
    );

    // Windows: a `.cmd` shim named `promptlog.cmd`, in %LOCALAPPDATA%\promptlog\bin.
    const win = shimBody(script, 'win32');
    expect(win).toMatch(/^@echo off/);
    expect(win).toContain(`node "${script}" %*`);
    expect(shimName('win32')).toBe('promptlog.cmd');
    expect(
      shimDir('C:\\Users\\alice', {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      }),
    ).toBe(path.join('C:\\Users\\alice\\AppData\\Local', 'promptlog', 'bin'));
    // No LOCALAPPDATA (a minimal shell): falls back to ~/.local/bin, same as POSIX.
    expect(shimDir('C:\\Users\\alice', { platform: 'win32', env: {} })).toBe(
      path.join('C:\\Users\\alice', '.local', 'bin'),
    );
  });

  test('skill update: re-copies into every recorded location', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    const claudeDest = path.join(home, '.claude', 'skills', 'promptlog');
    const marker = path.join(claudeDest, 'scripts', 'promptlog.js');
    const before = fs.readFileSync(marker, 'utf-8');
    // corrupt the installed copy to prove `update` actually re-copies
    fs.writeFileSync(marker, '// corrupted\n');

    r = run(['skill', 'update'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Claude Code\s+.*\.claude\/skills\/promptlog\s+v.*updated/);
    const after = fs.readFileSync(marker, 'utf-8');
    expect(after).toBe(before);

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill update --dry-run: prints what would change and writes nothing', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    const claudeDest = path.join(home, '.claude', 'skills', 'promptlog');
    const marker = path.join(claudeDest, 'scripts', 'promptlog.js');
    const before = fs.readFileSync(marker, 'utf-8');
    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    const recordBefore = fs.readFileSync(recordPath, 'utf-8');
    fs.writeFileSync(marker, '// corrupted\n');

    r = run(['skill', 'update', '--dry-run'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Claude Code\s+.*\.claude\/skills\/promptlog\s+v.*would update/);

    // nothing written: the corrupted marker survives, and the install
    // record is untouched
    expect(fs.readFileSync(marker, 'utf-8')).toBe('// corrupted\n');
    expect(fs.readFileSync(marker, 'utf-8')).not.toBe(before);
    expect(fs.readFileSync(recordPath, 'utf-8')).toBe(recordBefore);

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill update refreshes an external (unrecorded) user-scope copy by default', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    // Simulate an install that arrived via another channel: a valid
    // promptlog skill dir our own record never wrote, sitting in Codex's
    // normal user-scope skill directory (so `skillDirs('user')` finds it).
    const externalDest = path.join(home, '.codex', 'skills', 'promptlog');
    fs.rmSync(externalDest, { recursive: true, force: true });
    fs.mkdirSync(path.join(externalDest, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(externalDest, 'SKILL.md'),
      '---\nname: promptlog\nmetadata:\n  version: 0.1.0\n---\nexternal copy\n',
    );
    fs.writeFileSync(path.join(externalDest, 'scripts', 'promptlog.js'), '// stub, pre-update\n');

    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    record.installs = record.installs.filter((i: { path: string }) => i.path !== externalDest);
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

    // No --all: it must still be refreshed (the old --all behaviour is now default).
    r = run(['skill', 'update'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Codex CLI\s+.*\.codex\/skills\/promptlog\s+v0\.1\.0.*updated/);
    expect(fs.existsSync(path.join(externalDest, 'SKILL.md'))).toBeTruthy();
    const md = fs.readFileSync(path.join(externalDest, 'SKILL.md'), 'utf-8');
    expect(md).not.toMatch(/external copy/);

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill update lists a plugin-cache copy as managed and leaves it untouched', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    // A copy sitting inside Claude's plugin cache: not among any adapter's
    // skillDirs(), so it is found only by the direct plugin-cache scan.
    const pluginDest = path.join(
      home,
      '.claude',
      'plugins',
      'some-marketplace',
      'promptlog-plugin',
      'skills',
      'promptlog',
    );
    fs.mkdirSync(pluginDest, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDest, 'SKILL.md'),
      '---\nname: promptlog\nmetadata:\n  version: 0.1.0\n---\nplugin copy\n',
    );

    r = run(['skill', 'update'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/managed by \/plugin update promptlog in Claude Code/);
    expect(fs.readFileSync(path.join(pluginDest, 'SKILL.md'), 'utf-8')).toMatch(/plugin copy/);

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill uninstall: removes exactly the recorded paths', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    const claudeDest = path.join(home, '.claude', 'skills', 'promptlog');
    const codexDest = path.join(home, '.codex', 'skills', 'promptlog');
    expect(fs.existsSync(claudeDest)).toBeTruthy();
    expect(fs.existsSync(codexDest)).toBeTruthy();

    r = run(['skill', 'uninstall'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    expect(fs.existsSync(claudeDest)).toBeFalsy();
    expect(fs.existsSync(codexDest)).toBeFalsy();
    // the parent agent dirs themselves are untouched
    expect(fs.existsSync(path.join(home, '.claude'))).toBeTruthy();
    expect(fs.existsSync(path.join(home, '.codex'))).toBeTruthy();

    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    expect(record.installs).toEqual([]);

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('skill uninstall refuses a recorded path that is not a promptlog skill', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    const claudeDest = path.join(home, '.claude', 'skills', 'promptlog');
    fs.writeFileSync(path.join(claudeDest, 'SKILL.md'), '---\nname: something-else\n---\n');

    r = run(['skill', 'uninstall'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/refusing to remove/);
    expect(fs.existsSync(claudeDest), 'the tampered directory must survive').toBeTruthy();

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('self-check runs during install (ok, not error)', () => {
    const home = makeFakeHome();
    const r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(/error/.test(r.stdout), `expected no self-check errors, got:\n${r.stdout}`).toBeFalsy();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('BLOCKER regression: install never destroys a pre-existing non-promptlog skill of the same name', () => {
    const home = makeFakeHome();
    const claudeSkillsDir = path.join(home, '.claude', 'skills');
    const dest = path.join(claudeSkillsDir, 'promptlog');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '---\nname: my-hand-written-skill\n---\nDo not eat me.\n');
    fs.writeFileSync(path.join(dest, 'notes.txt'), 'precious user data');

    const r = run(['skill', 'install'], { HOME: home });
    expect(r.status, `expected exit code 1, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/refused/);
    expect(r.stderr).toMatch(/not a promptlog skill/);

    // untouched: same hand-written content survives, byte for byte
    expect(fs.readFileSync(path.join(dest, 'notes.txt'), 'utf-8')).toBe('precious user data');
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf-8')).toMatch(/my-hand-written-skill/);

    // never recorded, since we never touched it
    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    if (fs.existsSync(recordPath)) {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
      expect(record.installs.some((i: { path: string }) => i.path === dest)).toBeFalsy();
    }

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('install is atomic and per-adapter: one adapter failing does not stop or corrupt the others', () => {
    const home = makeFakeHome();
    // Make claude's skill dir un-creatable (a file sits where a directory
    // needs to go), while codex is left alone.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills'), 'not a directory');

    const r = run(['skill', 'install'], { HOME: home });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/Claude Code\s+error/);
    expect(r.stdout).toMatch(/Codex CLI\s+ok/);

    const codexDest = path.join(home, '.codex', 'skills', 'promptlog');
    expect(fs.existsSync(path.join(codexDest, 'SKILL.md'))).toBeTruthy();

    // no stray atomic-rename temp directories left behind
    expect(fs.existsSync(path.join(home, '.codex', 'skills', 'promptlog.new'))).toBeFalsy();

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('--project vendors the whole skill (scripts/ included, no .gitignore) so a fresh clone can run it with nothing preinstalled', () => {
    const home = makeFakeHome(); // .claude, .codex, .cursor all detected -> all three project dirs
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-project-'));
    const cloneParent = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-clone-'));
    const cloneDir = path.join(cloneParent, 'clone');
    const gitEnv = {
      ...process.env,
      HOME: home,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    function git(args: string[], cwd: string) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv });
      expect(r.status, `git ${args.join(' ')} failed:\n${r.stderr}`).toBe(0);
      return r;
    }
    git(['init', '-q'], projectDir);

    // --project resolves relative to cwd, so run it with cwd set to the project dir.
    const r = spawnSync(process.execPath, [BIN, 'skill', 'install', '--project'], {
      encoding: 'utf-8',
      cwd: projectDir,
      env: { ...process.env, NO_COLOR: '1', HOME: home },
    });
    expect(r.status, r.stderr).toBe(0);

    const skillDirs = ['.claude', '.codex', '.cursor']
      .map((d) => path.join(d, 'skills', 'promptlog'))
      .filter((rel) => fs.existsSync(path.join(projectDir, rel)));
    expect(
      skillDirs.length >= 1,
      `expected at least one project skill dir, stdout:\n${r.stdout}`,
    ).toBeTruthy();
    for (const rel of skillDirs) {
      const dest = path.join(projectDir, rel);
      expect(fs.existsSync(path.join(dest, 'SKILL.md')), `${rel}: missing SKILL.md`).toBeTruthy();
      expect(
        fs.existsSync(path.join(dest, 'scripts', 'promptlog.js')),
        `${rel}: missing scripts/promptlog.js`,
      ).toBeTruthy();
      expect(
        fs.existsSync(path.join(dest, '.gitignore')),
        `${rel}: installer must not write a .gitignore`,
      ).toBeFalsy();
    }

    git(['add', '-A'], projectDir);
    git(['commit', '-q', '-m', 'x'], projectDir);
    git(['clone', '-q', projectDir, cloneDir], cloneParent);

    // A teammate's clone: empty fake HOME, nothing on PATH, no package.json
    // anywhere above the skill dir. The vendored runtime must still resolve.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-empty-home-'));
    for (const rel of skillDirs) {
      const script = path.join(cloneDir, rel, 'scripts', 'promptlog.js');
      expect(fs.existsSync(script), `${rel}: scripts/promptlog.js did not survive commit+clone`).toBeTruthy();

      const vres = spawnSync(process.execPath, [script, '--version'], {
        encoding: 'utf-8',
        cwd: cloneDir,
        env: { ...process.env, NO_COLOR: '1', HOME: emptyHome },
      });
      expect(vres.status, `${rel}: --version failed:\n${vres.stderr}`).toBe(0);
      expect(vres.stdout.trim(), `${rel}: --version output`).toBe('promptlog 0.5.0');

      const e = spawnSync(process.execPath, [script, 'skill-entry', '--no-color', '--fenced'], {
        encoding: 'utf-8',
        cwd: cloneDir,
        env: { ...process.env, NO_COLOR: '1', HOME: emptyHome, PROMPTLOG_NO_UPDATE_CHECK: '1' },
      });
      expect(
        e.status === 0 || e.status === 1,
        `${rel}: skill-entry exit ${e.status}\n${e.stderr}`,
      ).toBeTruthy();
      expect(
        /Cannot find module/.test(e.stderr),
        `${rel}: runtime failed to resolve:\n${e.stderr}`,
      ).toBeFalsy();
    }

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyHome, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cloneParent, { recursive: true, force: true });
  });

  test('doctor and uninstall detect externally-installed copies (not in our record) and uninstall refuses them without --all', () => {
    const home = makeFakeHome();
    // Simulate an install that happened via another channel (marketplace,
    // `npx skills add`, ...): a valid promptlog skill dir that our own record
    // never wrote.
    const externalDest = path.join(home, '.claude', 'skills', 'promptlog');
    fs.mkdirSync(externalDest, { recursive: true });
    fs.writeFileSync(
      `${externalDest}/SKILL.md`,
      '---\nname: promptlog\nversion: 0.1.0\n---\nexternal copy\n',
    );

    let r = run(['doctor', '--json'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const info = JSON.parse(r.stdout) as DoctorInfo;
    const claude = info.agents.find((a) => a.id === 'claude');
    if (!claude) throw new Error('expected a claude entry');
    const externalEntry = claude.skillInstalls.find((s) => s.path === externalDest);
    if (!externalEntry) throw new Error('expected the external install to be detected');
    expect(externalEntry.external).toBe(true);

    r = run(['skill', 'uninstall'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(externalDest), 'external install must survive uninstall without --all').toBeTruthy();
    expect(r.stdout).toMatch(/installed \(external\)/);

    r = run(['skill', 'uninstall', '--all'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(externalDest), '--all must remove the external install too').toBeFalsy();

    fs.rmSync(home, { recursive: true, force: true });
  });
});
