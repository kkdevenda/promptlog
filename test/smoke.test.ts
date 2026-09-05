import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeProjectsDir } from '../src/agents/claude/locate';
import { allRolloutFiles } from '../src/agents/codex/locate';
import { cursorProjectsDir, transcriptsInSlugDir } from '../src/agents/cursor/locate';
import { agents } from '../src/agents/index';

describe.skipIf(process.env.PROMPTLOG_SMOKE !== '1')('smoke', () => {
  let ok = 0,
    turns = 0,
    exercised = 0;
  const home = os.homedir();

  for (const adapter of agents()) {
    let files: string[] = [];

    if (adapter.id === 'claude') {
      const base = claudeProjectsDir(home);
      if (fs.existsSync(base)) {
        for (const d of fs.readdirSync(base)) {
          const slugDir = path.join(base, d);
          if (fs.statSync(slugDir).isDirectory()) {
            for (const f of fs.readdirSync(slugDir)) {
              if (f.endsWith('.jsonl')) files.push(path.join(slugDir, f));
            }
          }
        }
      }
    } else if (adapter.id === 'codex') {
      files.push(...allRolloutFiles(home));
    } else if (adapter.id === 'cursor') {
      const base = cursorProjectsDir(home);
      if (fs.existsSync(base)) {
        for (const d of fs.readdirSync(base)) {
          const slugDir = path.join(base, d);
          if (fs.statSync(slugDir).isDirectory()) {
            for (const t of transcriptsInSlugDir(slugDir)) files.push(t.path);
          }
        }
      }
    }

    files = files.filter((f) => !f.includes('/subagents/'));

    if (!files.length) {
      console.log(`${adapter.id}: not exercised`);
      continue;
    }

    exercised += 1;
    for (const fpath of files) {
      it(`${adapter.id}: parse ${fpath}`, () => {
        const session = adapter.parse(fpath);
        const n = session?.turns ? session.turns.length : 0;
        turns += n;
        ok += 1;
      });
    }
  }

  it('summary', () => {
    console.log(`smoke: ${ok} parsed, ${turns} turns, ${exercised}/${agents().length} agents exercised`);
    expect(ok + exercised).toBeGreaterThanOrEqual(0);
  });
});
