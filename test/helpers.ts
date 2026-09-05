/**
 * Shared test scaffolding.
 *
 * `tmpDir()` is the one way every test should mint a temp directory: a plain
 * `fs.mkdtempSync()` result can be a Windows short (8.3) alias -
 * `C:\Users\RUNNER~1\AppData\Local\Temp\...` - which is a different STRING
 * from the long name (`C:\Users\runneradmin\...`) a sibling process (git, a
 * spawned `promptlog`) reports for the very same directory. `realpathSync
 * .native` resolves that alias away up front, so no assertion later has to
 * guess whether a path it captured came in short or long form.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh temp directory under `parent` (default `os.tmpdir()`), realpath'd
 * so short-name aliases (Windows) and `/private/var` vs `/var` (macOS)
 * cannot leak into a test's expectations. */
export function tmpDir(prefix: string, parent: string = os.tmpdir()): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix)));
}

/**
 * Diagnostics for a hook/integration assertion that can fail for a reason
 * the assertion itself does not say: the generated hook files' content and
 * the `.git/hooks` directory listing. Appended to an `expect(..., message)`
 * so the next failing CI log - one we cannot reproduce locally - is
 * conclusive on its own, rather than needing another round trip.
 *
 * Never throws: an unreadable repo/hooks dir just says so, since this runs
 * from inside an assertion message that is already about to fail.
 */
export function diag(repoDir: string): string {
  const hooksDir = path.join(repoDir, '.git', 'hooks');
  const lines: string[] = [`hooksDir=${hooksDir}`];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(hooksDir).sort();
  } catch (e) {
    return `${lines.join('\n')}\n  (unreadable: ${e})`;
  }
  lines.push(`entries=${JSON.stringify(entries)}`);
  for (const name of entries) {
    if (name.endsWith('.sample')) continue;
    let body: string;
    try {
      body = fs.readFileSync(path.join(hooksDir, name), 'utf8');
    } catch (e) {
      lines.push(`--- ${name} (unreadable: ${e}) ---`);
      continue;
    }
    lines.push(`--- ${name} ---\n${body}`);
  }
  return lines.join('\n');
}
