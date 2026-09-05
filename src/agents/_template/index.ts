/**
 * Template adapter (CONTRIBUTING.md "Adding an agent adapter"). Every method
 * of the `Adapter` interface (src/agents/types.ts) implemented as an honest
 * no-op: nothing here invents data, and every `capabilities` flag is
 * `false` because nothing here is real. Copy this directory to start a new
 * agent, replace each no-op with a real implementation, and flip the
 * matching `capabilities` flag to `true` as you do.
 *
 * NOT registered in ./index.ts - this file exists only as a copyable
 * skeleton and a contract-test fixture (test/contract.test.ts asserts it
 * satisfies `Adapter` and that every capability is false).
 */

import type { Adapter } from '../types';

export const template: Adapter = {
  id: 'template',
  displayName: 'Template',
  capabilities: {
    // Flip to true once `parse()` below returns a real Session.
    parse: false,
    // Flip to true once a real env var names the live session (add it to
    // `sessionEnvVars` below too).
    liveSession: false,
    // Flip to true once `edits()` below returns real evidence.
    edits: false,
    // Flip to true once parsed turns carry real token counts.
    tokens: false,
    // Flip to true once `hooks` is meaningful for this agent (it has files
    // to attribute at commit time). Leave commented out (defaults to
    // undefined) unless counts are partial - see Capabilities.tokensPartial.
    hooks: false,
    // Flip to true once `parseStatusInput` below is implemented.
    statusline: false,
    // Flip to true once `children()` below returns real subagent
    // transcripts.
    subagents: false,
  },
  // Real env var(s) that name the live session for this agent, first
  // present wins, e.g. ['MYAGENT_SESSION_ID']. Empty until liveSession is
  // real.
  sessionEnvVars: [],

  /** A real implementation checks for this agent's home directory, e.g.
   * `isDir(path.join(home, '.myagent'))`. A no-op can never honestly know
   * whether the agent is installed, so it says no. */
  detectInstalled(_home) {
    return false;
  },

  /** A real implementation returns the directories this agent reads skills
   * from at the given scope, e.g. `~/.myagent/skills` (user) or
   * `.myagent/skills` under cwd (project). No real directory is known here. */
  skillDirs(_scope, _home, _cwd) {
    return [];
  },

  /** A real implementation lists every transcript under this agent's
   * session directory whose recorded cwd is under `opts.cwd`, bounded by
   * `opts.since`. Returning [] here means core will never find a session
   * for this adapter - honest, since `capabilities.parse` is false. */
  locate(_opts) {
    return [];
  },

  /** A real implementation resolves an explicit id, prefix, or path to one
   * of this agent's transcript paths. Returning null is honest: nothing
   * here can resolve anything. */
  findSession(_idOrPath, _opts) {
    return null;
  },

  /** A real implementation returns the single newest transcript for a repo
   * (DESIGN.md resolution step 4). Returning null keeps this adapter out of
   * `--agent auto` selection. */
  newestForCwd(_opts) {
    return null;
  },

  /** A real implementation parses a transcript file into the shared
   * `Session` model and throws on an unreadable file (per the Adapter
   * contract). A template has no transcript format to parse, so it always
   * throws rather than fabricate a Session - this is what makes
   * `capabilities.parse: false` honest. */
  parse(path) {
    throw new Error(`template adapter: parse() is not implemented (path: ${path})`);
  },

  /** A real implementation re-reads `session.path` and returns edit
   * evidence (Edit[]) for attribution. [] here is honest only because
   * `capabilities.edits` is false - it means "this agent contributes no
   * evidence", not "this session had no edits". */
  edits(_session, _opts) {
    return [];
  },

  /** A real implementation finds every subagent transcript spawned by this
   * session, each exactly once, and fails open (catches and returns zero
   * results) rather than throw. `duplicates: 0` here is honest because
   * nothing was scanned, not because nothing collided. */
  children(_session, _opts) {
    return { children: [], duplicates: 0 };
  },

  /** A real implementation reports which UI produced the session (from an
   * env var or a field in the transcript itself), and never guesses
   * 'desktop'. 'unknown' is the only honest answer when nothing is real. */
  ui(_opts) {
    return 'unknown';
  },

  /** A real implementation peeks a transcript file cheaply (without a full
   * parse) for its session id. null is honest here: no format is known. */
  sessionIdFor(_filePath) {
    return null;
  },

  /** A real implementation recognises this agent's own transcript filenames
   * (used to route an explicit `--session <path>` under `--agent auto`).
   * Always false here so a template adapter, if ever mistakenly registered,
   * never claims someone else's file. */
  looksLikeOwnFile(_basename) {
    return false;
  },

  /** Only meaningful with `capabilities.statusline: true`. A real
   * implementation parses what the host pipes to a status-line command and
   * returns null when the shape is not recognised. Omitted from a strict
   * no-op would still satisfy the (optional) interface member, but keeping
   * it explicit documents the contract: return null, never guess. */
  parseStatusInput(_text) {
    return null;
  },
};
