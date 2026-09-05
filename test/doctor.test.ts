/**
 * `promptlog doctor` (src/core/commands/doctor.ts). Every case here spawns
 * the built CLI bundle (`node bin/promptlog.js`); `npm run build` runs
 * first.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlog-doctor-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(home, '.windsurf'), { recursive: true }); // no adapter
  return home;
}

describe('CLI', () => {
  test('doctor --json has the expected keys', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    r = run(['doctor', '--json'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const info = JSON.parse(r.stdout) as DoctorInfo;
    expect(Array.isArray(info.agents)).toBeTruthy();
    const claude = info.agents.find((a) => a.id === 'claude');
    if (!claude) throw new Error('expected a claude entry');
    expect(claude.installedOnMachine).toBe(true);
    expect(claude.parseCapable).toBe(true);
    expect(Array.isArray(claude.skillInstalls)).toBeTruthy();
    expect(claude.skillInstalls.length >= 1).toBeTruthy();
    expect('path' in info).toBeTruthy();
    expect('binary' in info.path).toBeTruthy();
    expect('repo' in info).toBeTruthy();
    expect('root' in info.repo).toBeTruthy();
    expect('configPresent' in info.repo).toBeTruthy();
    expect('enabled' in info.repo).toBeTruthy();
    expect('hooksInstalled' in info.repo).toBeTruthy();

    const cursor = info.agents.find((a) => a.id === 'cursor');
    if (!cursor) throw new Error('expected a cursor entry');
    expect(cursor.parseCapable).toBe(true); // Cursor gained an adapter in v0.3

    fs.rmSync(home, { recursive: true, force: true });
  });

  test('doctor reports an outdated recorded copy and points at `promptlog skill update`', () => {
    const home = makeFakeHome();
    let r = run(['skill', 'install'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);

    const recordPath = path.join(home, '.promptlog', 'skill-installs.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    for (const entry of record.installs) entry.version = '0.0.1';
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

    r = run(['doctor', '--json'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    const info = JSON.parse(r.stdout) as DoctorInfo;
    const claude = info.agents.find((a) => a.id === 'claude');
    if (!claude) throw new Error('expected a claude entry');
    const install = claude.skillInstalls.find((s) => s.version === '0.0.1');
    if (!install) throw new Error('expected the downgraded install to be reported');
    expect(install.outdated).toBe(true);

    r = run(['doctor'], { HOME: home });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/outdated.*promptlog skill update/);

    fs.rmSync(home, { recursive: true, force: true });
  });
});
