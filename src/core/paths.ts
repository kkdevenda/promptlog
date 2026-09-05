/**
 * Where the running copy of promptlog lives. The CLI ships as one bundled
 * file, `<skill dir>/scripts/promptlog.js`, so every "where am I" question
 * is answered from that file's location and nowhere else.
 */

import path from 'node:path';

/** Absolute path of the bundled entry point, the file git hooks invoke. */
export function entryPoint(): string {
  return path.resolve(__filename);
}

/** The directory holding the entry point (`<skill dir>/scripts`). */
export function scriptsDir(): string {
  return path.dirname(entryPoint());
}

/** The skill directory (holds SKILL.md and scripts/). */
export function skillDir(): string {
  return path.dirname(scriptsDir());
}
