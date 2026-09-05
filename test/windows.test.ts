/**
 * Windows-shaped inputs exercised from any host, per DESIGN.md portability
 * notes: real Windows behaviour (case-insensitive NTFS, `C:\` drive letters,
 * `\` separators) can't be verified without an actual Windows run, but the
 * string/path logic that is SUPPOSED to handle it can still be checked here
 * by injecting `path.win32` wherever a function accepts a path module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { slug as claudeSlug } from '../src/agents/claude/locate';
import { slug as cursorSlug } from '../src/agents/cursor/locate';
import { isUnderRepo, toRepoRel } from '../src/core/fsutil';
import { rmTree, tmpDir } from './helpers';

describe('fsutil.isUnderRepo: Windows-shaped paths (path.win32 injected)', () => {
  test('subdirectory under the repo root, mixed case, backslashes', () => {
    expect(isUnderRepo('C:\\Users\\K\\Proj\\sub\\dir', 'c:\\users\\k\\proj', path.win32)).toBe(true);
  });

  test('exact repo root, differing case', () => {
    expect(isUnderRepo('C:\\Users\\K\\Proj', 'c:\\users\\k\\proj', path.win32)).toBe(true);
  });

  test('sibling directory is not under the repo root', () => {
    expect(isUnderRepo('C:\\Users\\K\\Other', 'C:\\Users\\K\\Proj', path.win32)).toBe(false);
  });

  test('a same-prefix sibling ("...\\Projfoo") is not under "...\\Proj"', () => {
    expect(isUnderRepo('C:\\Users\\K\\Projfoo\\sub', 'C:\\Users\\K\\Proj', path.win32)).toBe(false);
  });

  test('still works for POSIX paths with the default (real) path module', () => {
    expect(isUnderRepo('/repo/sub', '/repo')).toBe(true);
    expect(isUnderRepo('/repo-other', '/repo')).toBe(false);
  });
});

describe('codex: recorded-cwd containment on Windows-shaped paths', () => {
  // codex/locate.ts's newestForCwd/locate compare a rollout file's recorded
  // `session_meta.cwd` against gitRoot via fsutil.isUnderRepo exactly like
  // this - it doesn't itself take a path-module parameter (it always uses
  // the real one, correct for whatever host it actually runs on), so this
  // is exercised at the fsutil level with path.win32 injected instead.
  test('a rollout recorded under a repo subdirectory matches, case/slash-insensitively', () => {
    expect(isUnderRepo('c:\\users\\k\\proj\\src\\core', 'C:\\Users\\K\\Proj', path.win32)).toBe(true);
  });

  test('a rollout recorded outside the repo does not match', () => {
    expect(isUnderRepo('C:\\Users\\K\\OtherProj', 'C:\\Users\\K\\Proj', path.win32)).toBe(false);
  });
});

describe('claude slug(): Windows-shaped cwd', () => {
  test('drive letter, colon and backslashes all become "-"', () => {
    expect(claudeSlug('C:\\Users\\k\\proj')).toBe('C--Users-k-proj');
  });

  test('still matches the real macOS/Linux slugging rule', () => {
    // Verified against ~/.claude/projects on the machine this suite was
    // written on: a dot in the path becomes its own "-", not just each "/".
    expect(claudeSlug('/Users/krishna/.buzz')).toBe('-Users-krishna--buzz');
  });
});

describe('cursor slug(): Windows-shaped cwd', () => {
  test('no leading "/" to strip, so drive letter/colon/backslashes all become "-"', () => {
    expect(cursorSlug('C:\\Users\\k\\proj')).toBe('C--Users-k-proj');
  });

  test('still strips a POSIX leading "/" with no leading dash', () => {
    expect(cursorSlug('/Users/krishna/Developer/whatsareyouworkingon')).toBe(
      'Users-krishna-Developer-whatsareyouworkingon',
    );
  });
});

describe('fsutil.toRepoRel: a symlinked repo root and its real path are the same repo', () => {
  // Reproduces the class of bug behind the Windows CI failures in
  // test/attribution.test.ts (case 3, reindex): a transcript's recorded
  // file/cwd and the repo root as `git rev-parse --show-toplevel` prints it
  // can each arrive by a different route to the SAME directory - there a
  // Windows 8.3 short name vs. the long form, here (checkable on any host) a
  // symlink vs. its target - and `toRepoRel` must not let that difference
  // make a file that really is inside the repo look foreign.
  test('symlinked root vs. real file, and real root vs. symlinked file, both resolve', () => {
    const real = tmpDir('promptlog-symroot-real-');
    const link = path.join(path.dirname(real), 'promptlog-symroot-link');
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch (e) {
      // Symlink creation needs a privilege this host/user may not have
      // (notably plain Windows accounts without Developer Mode); skip
      // rather than fail the suite over an environment limitation.
      console.warn(`skipping symlink test: ${(e as Error).message}`);
      return;
    }
    try {
      const realFile = path.join(real, 'file1.txt');
      fs.writeFileSync(realFile, 'content\n');
      const linkFile = path.join(link, 'file1.txt');

      expect(toRepoRel(link, realFile)).toBe('file1.txt');
      expect(toRepoRel(real, linkFile)).toBe('file1.txt');
    } finally {
      fs.rmSync(link, { force: true });
      rmTree(real);
    }
  });
});
