/**
 * promptlog command-line interface: subcommand router.
 *
 * Each view command (`commands/view.ts`) and the two status commands
 * (`commands/status.ts`) resolves and parses its own session and reports its
 * own "no session found"; this module's job is picking the subcommand,
 * validating the flags OLD reported with the full usage banner (`-n`,
 * `--width`, `--format`, `--agent`), and - for `show`/`grep`/`files` only -
 * composing the live-transcript result with the independent repo-store
 * search in `commands/recall.ts` (the "recall after the transcript aged out"
 * path), printing the `── from repo ──` divider between them exactly when
 * the transcript side actually printed something.
 */

import { parseArgs } from 'node:util';
import { agents } from '../agents/index';
import * as dispatchCmd from './commands/dispatch';
import * as doctorCmd from './commands/doctor';
import * as hooksCmds from './commands/hooks';
import * as initCmds from './commands/init';
import * as recall from './commands/recall';
import * as repo from './commands/repo';
import * as skillCmds from './commands/skill';
import * as statusCmds from './commands/status';
import * as view from './commands/view';
import { errorMessage } from './json';
import { scriptsDir } from './paths';
import { maybeAppendUpdateHint } from './updateCheck';
import type { CommandArgs, Ctx } from './util';
import { findVersion } from './version';

const VIEW_COMMANDS: Array<[string, string, string]> = [
  [
    'graph',
    '[-n N] [-v] [--reverse] [--format auto|ascii|mermaid]',
    'tree/graph of the current session; ASCII unless --format mermaid',
  ],
  ['tree', '[-n N] [-v] [--reverse] [--responses]', 'git-log style tree of the current session (default)'],
  ['last', '[N|all] [--responses]', 'the Nth most recent non-command prompt'],
  ['show', '<gid|shortId|sha>', 'one prompt with metrics, source label, and linked commits'],
  ['grep', '<regex>', 'search prompts (transcript first, then repo)'],
  ['files', '<path>', 'prompts that touched a file'],
  ['sessions', '', 'list every session for the project'],
  ['skill-entry', '[args]', 'what the skill embeds: passthrough, or a compact tree with no args'],
  ['mermaid', '[--raw]', 'a Mermaid gitGraph of the session'],
  ['html', '<file|->', 'self-contained HTML document'],
  ['fragment', '<file|->', 'embeddable HTML fragment'],
  ['json', '', 'dump the session as JSON'],
  ['env', '', 'what was detected (agent, session, transcript, repo, hooks)'],
  ['status', '[--json]', 'one-line summary (prompts, active time, tokens, tools) for a status line'],
  ['statusline', '', 'read an agent statusLine payload from stdin, print the matching status line'],
];

const REPO_COMMANDS: Array<[string, string, string]> = [
  ['init', '[--global] [--notes]', 'create .promptlog, config, gitattributes, hooks'],
  ['enable', '', 'flip promptlog.enabled on for this repo'],
  ['disable', '', 'flip promptlog.enabled off for this repo'],
  ['sync', '[--all] [--session X]', 'write records for turns since last commit, without committing'],
  ['trailers', '', 'print Prompt-Id lines for the current window'],
  ['reindex', '', 'rebuild index.jsonl and README.md from session docs + git log'],
  ['review', '', 'show what sync/commit WOULD write, redacted, with findings'],
  ['hook', '<name>', 'entry point used by the git hook dispatchers'],
  ['merge-driver', '<base> <ours> <theirs>', 'internal: git merge driver for .promptlog/sessions/*.json'],
  [
    'merge-readme',
    '<base> <ours> <theirs>',
    'internal: git merge driver that regenerates .promptlog/README.md',
  ],
];

const DISTRIBUTION_COMMANDS: Array<[string, string, string]> = [
  [
    'skill',
    'install|update|uninstall [--project] [--agents a,b] [--path]',
    'copy/refresh/remove the promptlog skill for detected agents',
  ],
  ['doctor', '[--json]', 'diagnose agents, skill installs, PATH, and this repo'],
];

// `dispatch` is the body of every generated hook file (see
// `commands/dispatch.ts`); it is a real command so `promptlog dispatch ...`
// works like any other subcommand, but it is internal machinery, not
// something a user types, so it stays out of `buildUsage()`.
const HIDDEN_COMMANDS = ['dispatch'];

const SUBCOMMANDS = [...VIEW_COMMANDS, ...REPO_COMMANDS, ...DISTRIBUTION_COMMANDS]
  .map((row) => row[0])
  .concat(HIDDEN_COMMANDS);
const REPO_ONLY = new Set([...REPO_COMMANDS.map((row) => row[0]), ...HIDDEN_COMMANDS]);
const DISTRIBUTION_ONLY = new Set(DISTRIBUTION_COMMANDS.map((row) => row[0]));

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function buildUsage(): string {
  const lines: string[] = [];
  lines.push('usage: promptlog [subcommand] [options]');
  lines.push('');
  lines.push('git-log style tree of your AI coding prompts');
  lines.push('');
  lines.push('view commands:');
  for (const [name, args, desc] of VIEW_COMMANDS)
    lines.push(`  ${pad(`${name} ${args}`.trim(), 32)} ${desc}`);
  lines.push('');
  lines.push('repo commands:');
  for (const [name, args, desc] of REPO_COMMANDS)
    lines.push(`  ${pad(`${name} ${args}`.trim(), 32)} ${desc}`);
  lines.push('');
  lines.push('distribution commands:');
  for (const [name, args, desc] of DISTRIBUTION_COMMANDS)
    lines.push(`  ${pad(`${name} ${args}`.trim(), 32)} ${desc}`);
  lines.push('');
  lines.push('global flags:');
  // Generated from the registry so a new adapter shows up here without a
  // hand edit (the choices `--agent` actually validates against, plus auto).
  const agentChoices = [...agents().map((a) => a.id), 'auto'].join(',');
  lines.push(`  ${pad(`--agent {${agentChoices}}`, 29)} default: auto`);
  lines.push('  --session SESSION             session id, id prefix, or path');
  lines.push('  --no-color');
  lines.push('  --no-update-check             skip the once-a-day published-version check');
  lines.push('  --json                        where meaningful');
  lines.push("  --responses                   include the agent's response");
  lines.push('  -n N                          limit to the N most recent prompts');
  lines.push('  -v, --verbose');
  lines.push('  --reverse                     oldest first');
  lines.push("  --full                        print each prompt's complete text below its node line");
  lines.push('  --width N                     override terminal width for truncation/wrapping (60-400)');
  lines.push('  --raw                         with mermaid, omit the fence and id list');
  lines.push('  --format auto|ascii|mermaid   with graph, default: auto (ASCII; mermaid only when asked)');
  lines.push('  --global, --notes             see the matching subcommand');
  lines.push('  --project, --agents a,b, --path   see `skill install`');
  lines.push('  -h, --help                    show this help message and exit');
  return `${lines.join('\n')}\n`;
}

const OPTION_SPEC = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  agent: { type: 'string' },
  session: { type: 'string' },
  'no-color': { type: 'boolean' },
  'no-update-check': { type: 'boolean' },
  json: { type: 'boolean' },
  responses: { type: 'boolean' },
  n: { type: 'string', short: 'n' },
  verbose: { type: 'boolean', short: 'v' },
  reverse: { type: 'boolean' },
  full: { type: 'boolean' },
  width: { type: 'string' },
  raw: { type: 'boolean' },
  format: { type: 'string' },
  fenced: { type: 'boolean' },
  global: { type: 'boolean' },
  notes: { type: 'boolean' },
  all: { type: 'boolean' },
  project: { type: 'boolean' },
  agents: { type: 'string' },
  path: { type: 'boolean' },
  'chain-dir': { type: 'string' },
} as const;

function usageError(msg: string): number {
  process.stderr.write(`usage: promptlog ...\npromptlog: error: ${msg}\n`);
  return 2;
}

interface ParsedCommand {
  subcommand: string;
  positionals: string[];
  values: Record<string, unknown>;
}

type ParseResult = { error: number } | { help: true } | { exit: number } | ParsedCommand;

/** Parse argv into { subcommand, positionals (after the subcommand name),
 * values }. Returns { error } instead on a usage error. */
function parseCli(argv: string[]): ParseResult {
  // `skill-entry` is what the skill file embeds: with arguments it is a plain
  // passthrough; without, a compact tree small enough to load on every skill
  // trigger (the agent can always ask for the full tree afterwards).
  if (argv[0] === 'skill-entry') {
    argv = argv.slice(1);
    const hasSubcommand = argv.some((a) => !a.startsWith('-'));
    if (!hasSubcommand) argv = ['graph', '-n', '15', ...argv];
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: true, strict: false });
  } catch (e) {
    return { error: usageError(errorMessage(e)) };
  }
  const { values, positionals } = parsed;

  if (values.version) {
    process.stdout.write(`promptlog ${findVersion(scriptsDir())}\n`);
    return { exit: 0 };
  }
  if (values.help) return { help: true };

  const agentIds = agents().map((a) => a.id);
  if (values.agent !== undefined && values.agent !== 'auto' && !agentIds.includes(values.agent as string)) {
    const choices = [...agentIds, 'auto'].map((c) => `'${c}'`).join(', ');
    return {
      error: usageError(`argument --agent: invalid choice: '${values.agent}' (choose from ${choices})`),
    };
  }

  const subcommand = positionals.length > 0 ? (positionals[0] as string) : 'tree';
  const rest = positionals.length > 0 ? positionals.slice(1) : [];

  if (!SUBCOMMANDS.includes(subcommand)) {
    return { error: usageError(`unrecognized subcommand: ${subcommand}`) };
  }

  return { subcommand, positionals: rest, values: values as Record<string, unknown> };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cwd = process.cwd();

  const parsed = parseCli(argv);
  if ('error' in parsed) return parsed.error;
  if ('help' in parsed) {
    process.stdout.write(buildUsage());
    return 0;
  }
  if ('exit' in parsed) return parsed.exit;

  const { subcommand, positionals, values } = parsed;
  const ctx: Ctx = { cwd, stdout: process.stdout, stderr: process.stderr, env: process.env };
  const args: CommandArgs = { values, positionals };

  // Published-version update check: at most one dim line appended to the
  // end of stdout, ONLY for the interactive view commands below (never for
  // hook/statusline/trailers/sync/review/init/merge-driver or any other
  // repo command, and never for json/mermaid/html/fragment/env either - see
  // updateCheck.ts's ELIGIBLE_SUBCOMMANDS for the exact list).
  async function finish(code: number): Promise<number> {
    await maybeAppendUpdateHint({ ctx, values, subcommand });
    return code;
  }

  if (subcommand !== 'skill') skillCmds.maybeStalenessHint(ctx);

  if (REPO_ONLY.has(subcommand)) {
    switch (subcommand) {
      case 'init':
        return initCmds.init(args, ctx);
      case 'enable':
        return initCmds.enable(args, ctx);
      case 'disable':
        return initCmds.disable(args, ctx);
      case 'sync':
        return repo.sync(args, ctx);
      case 'trailers':
        return repo.trailers(args, ctx);
      case 'reindex':
        return repo.reindex(args, ctx);
      case 'review':
        return repo.review(args, ctx);
      case 'hook':
        return hooksCmds.hook(args, ctx);
      case 'dispatch':
        return dispatchCmd.dispatch(args, ctx);
      case 'merge-driver':
        return initCmds.mergeDriver(args, ctx);
      case 'merge-readme':
        return initCmds.mergeReadme(args, ctx);
      default:
        return usageError(`unrecognized subcommand: ${subcommand}`);
    }
  }

  if (DISTRIBUTION_ONLY.has(subcommand)) {
    if (subcommand === 'doctor') return finish(await doctorCmd.doctor(args, ctx));
    // subcommand === 'skill'
    const action = positionals[0];
    const skillArgs: CommandArgs = { values, positionals: positionals.slice(1) };
    switch (action) {
      case 'install':
        return skillCmds.install(skillArgs, ctx);
      case 'update':
        return skillCmds.update(skillArgs, ctx);
      case 'uninstall':
        return skillCmds.uninstall(skillArgs, ctx);
      default:
        return usageError(`skill: unrecognized action '${action}' (expected install, update, or uninstall)`);
    }
  }

  if (subcommand === 'env') return view.env(args, ctx);
  if (subcommand === 'status') return finish(await statusCmds.status(args, ctx));
  // `statusline` resolves its own session from stdin (or falls back to the
  // normal lookup) and must never fail a status line: it does its own
  // try/catch and always exits 0.
  if (subcommand === 'statusline') return statusCmds.statusline(args, ctx);
  if (subcommand === 'sessions') return finish(await view.sessions(args, ctx));
  if (subcommand === 'json') return view.json(args, ctx);
  if (subcommand === 'mermaid') return view.mermaid(args, ctx);
  if (subcommand === 'html') return view.html(args, ctx);
  if (subcommand === 'fragment') return view.fragment(args, ctx);

  if (subcommand === 'tree' || subcommand === 'graph') {
    // OLD reported these with the full usage banner, not view.ts's concise
    // one-liner: validate here, before handing off to the renderer.
    if (values.n !== undefined && Number.isNaN(Number.parseInt(values.n as string, 10))) {
      return usageError(`argument -n: invalid int value: '${values.n}'`);
    }
    if (values.width !== undefined && Number.isNaN(Number.parseInt(values.width as string, 10))) {
      return usageError(`argument --width: invalid int value: '${values.width}'`);
    }
    if (subcommand === 'graph') {
      const format = (values.format as string) || 'auto';
      if (format !== 'auto' && format !== 'ascii' && format !== 'mermaid') {
        return usageError(
          `argument --format: invalid choice: '${format}' (choose from 'auto', 'ascii', 'mermaid')`,
        );
      }
    }
    return finish(await (subcommand === 'tree' ? view.tree(args, ctx) : view.graph(args, ctx)));
  }

  if (subcommand === 'last') return finish(await view.last(args, ctx));

  // `show`/`grep`/`files`: the repo store (`.promptlog/` in the git root) is
  // an independent source - the advertised "recall after the transcript aged
  // out". With no live transcript at all, that's the only place to look, and
  // we say so once on stderr; with one, both sides run and a divider
  // separates the transcript's result from the repo's.
  if (subcommand === 'show' || subcommand === 'grep' || subcommand === 'files') {
    const liveSession = view.resolveCurrentSession(values, ctx);
    if (!liveSession) {
      process.stderr.write('promptlog: no live transcript; searching the repo only\n');
    } else {
      const code =
        subcommand === 'show'
          ? await view.show(args, ctx, liveSession)
          : subcommand === 'grep'
            ? await view.grep(args, ctx, liveSession)
            : await view.files(args, ctx, liveSession);
      if (code === 0) process.stdout.write('── from repo ──\n');
    }
    switch (subcommand) {
      case 'show':
        return recall.show(args, ctx);
      case 'grep':
        return recall.grep(args, ctx);
      default:
        return recall.files(args, ctx);
    }
  }

  return usageError(`unrecognized subcommand: ${subcommand}`);
}
