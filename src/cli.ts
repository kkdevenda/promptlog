/** Bundle entry point (see docs/DESIGN.md "Layout"): esbuild bundles this
 * file into `skills/promptlog/scripts/promptlog.js`, the one file every
 * install channel ships. */

import { main } from './core/cli';

// `promptlog show <sha> | head` closes our stdout mid-write; without this the
// stream raises an unhandled 'error' event and we die with a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e?.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`promptlog: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
