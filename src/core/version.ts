/**
 * Running-version lookup, shared by `promptlog --version` and the
 * update-check hint. Two distribution shapes: an npm package (package.json
 * two levels above `src/core`) or a bare skill directory (SKILL.md
 * frontmatter carries the version, used by an externally-installed copy -
 * marketplace, npx skills add - which has no sibling package.json). Walk up
 * from the given directory and accept whichever appears first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isRecord, str } from './json';

/** Find the version of the running copy of promptlog, walking up from
 * `startDir` (pass the caller's directory). Returns 'unknown' if neither a
 * package.json (named promptlog/@kkdevenda/promptlog) nor a SKILL.md with a
 * `metadata.version` frontmatter line is found within a few levels up. */
export function findVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (isRecord(pkg)) {
          const name = str(pkg.name);
          const version = str(pkg.version);
          if ((name === 'promptlog' || name === '@kkdevenda/promptlog') && version) return version;
        }
      } catch {
        // fall through
      }
    }
    const skillPath = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      try {
        const md = fs.readFileSync(skillPath, 'utf-8');
        // `metadata.version` (indented under `metadata:`) only; a legacy
        // top-level bare `version:` line is deliberately not read.
        const m = md.match(/^[ \t]+version:\s*([0-9][^\s]*)/m);
        if (m) return m[1] as string;
      } catch {
        // fall through
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}
