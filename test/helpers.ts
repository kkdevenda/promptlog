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
