# Changelog

All notable changes to promptlog are documented here. Format is terse and
grouped as Added / Changed / Fixed; dates are release dates.

## 0.5.0 - 2026-09-04

### Changed

- **TypeScript rewrite.** Source is now in `src/` (TypeScript) instead of
  JavaScript. `npm run build` (esbuild) bundles it into the single shipped
  file `skills/promptlog/scripts/promptlog.js` (readable, unminified
  CommonJS), which is committed because install channels ship from git. CI
  fails if the committed bundle diverges from the source.
- **Build and release.** `npm test` runs typecheck (tsc), lint (biome),
  skill validation, build (esbuild), then the vitest suite. Release scripts
  are `scripts/bump-version.mjs` and `scripts/check-skill.mjs`. No
  user-visible behaviour change beyond the removals below.

### Removed

- Hidden legacy flags `--last`, `--all`, `--mermaid`, `--html`, `--fragment`
  (aliases kept since 0.2 for one release). Use the subcommands `last`,
  `sessions`, `mermaid`, `html`, `fragment`.
- Legacy bare `version:` form in SKILL.md frontmatter; `metadata.version` is
  the only source of truth.

## Unreleased

Release-readiness fixes from the 2026-09-04 review. No new features.

### Changed

- **Skill is self-contained on every host.** `SKILL.md` now tells every
  agent to run the bundled `scripts/promptlog.js` with Node (a `promptlog`
  on PATH is an equal alternative, never a requirement) and to dispatch
  every invocation through `skill-entry`, so `$promptlog last` on Codex or
  Cursor runs `last`, not `graph`. The Claude Code pre-run block is the one
  host-specific construct and is labelled as such. Frontmatter is reduced
  to the agentskills.io keys; `version` lives at `metadata.version`;
  `scripts/check-skill.js` enforces this in `pretest` and `prepublishOnly`.
- **Project-scope skill installs vendor the whole skill.** `skill install
  --project` no longer writes a `.gitignore` hiding `scripts/`, so a
  teammate's clone can run `/promptlog` with nothing preinstalled.
- **Redaction precedence.** Known secret shapes run before `config.allow`
  and can no longer be allow-listed; allow still protects ordinary text
  from the deny, entropy, paste and email layers. Bearer tokens containing
  `/` or `+` and quoted env values containing spaces are now caught.
- **Hooks coexist with an existing `core.hooksPath`.** `init` installs
  only into `.git/hooks` or `~/.promptlog/hooks`, points `core.hooksPath`
  there at the matching scope, and bakes the previous hooks directory into
  the dispatcher as a chain target, so husky/lefthook/hand-rolled hooks
  keep running. Re-running `init` carries the chain forward.
- **Subagent linkage uses the turn's full id.** Short gids (7-char prefix)
  are display-only; two turns sharing a prefix no longer credit the wrong
  one. `children()` entries carry `spawnedByTurnId`. `attachSubagents` is
  idempotent.
- **`sessions` lists every agent.** Under `--agent auto` it aggregates
  Claude, Codex and Cursor sessions (previously the first adapter with
  files won), sorted newest first, with an `agent` column and JSON field.
- **Every renderer agrees on totals.** HTML/fragment headers and Mermaid
  (as a `%%` comment line) now show own + subagent totals and per-prompt
  ` +N agents ↑x ↓y`, through the same `totalsWithSubagents()` as the tree
  and status line. Displayed "output" means output + thinking tokens
  everywhere, including subagent and JSON fields.
- **Update check is bounded and truthful.** Docs now say up to two origin
  requests (npm, then the GitHub-hosted SKILL.md only if npm fails), each
  following at most one redirect. Responses are capped at 64 KB under an
  absolute 1.5 s deadline, and a stale cache is claimed before fetching so
  concurrent first runs do not both fetch. README names the two small
  timestamp files recall commands write under `~/.promptlog/`.
- **CI.** `.github/workflows/ci.yml` runs the suite on Ubuntu and macOS
  across Node 18/20/22, verifies the packed skill copy is current,
  validates SKILL.md, installs from the `npm pack` tarball, and runs the
  standalone skill from an empty HOME. `npm run smoke` exercises every
  registered adapter and reports "not exercised" instead of a silent pass.
- Help text lists `--agent` choices from the registry (Cursor included)
  and no longer claims `--format auto` picks by UI. Package and plugin
  descriptions, COST.md, PLAN-v0.3.md and CONTRIBUTING reflect v0.4.
- Declared Node support is `>=18.3.0` (`node:util.parseArgs`).
- **One source tree.** `src/` and `hooks/` now live only inside
  `skills/promptlog/scripts/`, the directory every install channel ships.
  The root copies, `scripts/pack-skill.js`, `scripts/check-skill-sync.js`,
  the `pack-skill` npm script and the CI "packed copy is current" step are
  gone; tests require the skill tree directly. Nothing about installation
  changes: the shipped directory is byte-for-byte what it was.
- **`install.sh` removed.** Its PATH shim pointed at the checkout it was run
  from and broke when that clone moved. Install paths are now the
  marketplaces, `npx skills add`, and `npm i -g`; a standalone installer
  may return later.

### Fixed

- Hook dispatchers were invalid shell when the install path contained an
  apostrophe; the baked paths are now shell-quoted (fail-open preserved).
- `show`, `grep` and `files` searched the repo store only when a live
  transcript resolved; they now fall back to the repo alone when none does.
- The update hint was appended to `--json` stdout; it now goes to stderr
  when `--json` is set, so structured output always parses.
- Main-chain sidechain records could pre-empt a subagent's usage in the
  cross-file dedup, dropping it; the seed scan now applies the parser's
  sidechain rule.
- HTML fragment root ids are derived from a strict alphabet (or a hash of
  the session id), so a transcript-supplied id can no longer escape the
  fragment's CSS/JS scope.
- Claude subagent discovery skips symlinks and anything resolving outside
  `<session>/subagents/`.
- Test suite: the squash-merge test could open an editor; the `sessions`
  test depended on the developer's real transcripts. Both are hermetic.

## 0.4.0 - 2026-09-03

### Added

- **Subagent token counts.** A prompt that spawns subagents used to look
  free: their transcripts are separate files and separate API requests, so
  none of their tokens appeared anywhere. They are now read and attributed
  to the prompt that spawned them. `Turn` gains a `subagents` block
  (`count`, `output`, `input`, `cacheRead`, `cacheWrite`, `thinking`,
  `linkage`), `Session` gains `subagentsUnattributed`, `subagentFiles` and
  `subagentDuplicateIds`, and records carry the per-turn block alongside
  (never inside) `tokens`. Rows keep showing OWN usage — marked with a dim
  `⁺` after the ↓ value, or spelled out as ` +N agents ↑x ↓y` under `-v`;
  headline totals show own + subagents and say so: the tree header gains
  ` (+N agents)`, the totals row splits into `own` / `subagents (N)` /
  `total`, `status` appends ` · +N agents`, and `last`/`show` append
  ` · +N agents ↑x ↓y`. Adapters implement a new
  `children(session, {home})` contract method (`capabilities.subagents`);
  Claude reads `<session dir>/subagents/` and links each agent to its turn
  by `tool_use` id (nested agents resolve through their parent to the same
  top-level turn; background agents through their task notification), Codex
  finds child rollouts by `parent_thread_id` and links them by time, Cursor
  lists its subagent files with zero usage because it records none. Every
  total is pinned by two invariants in `test/subagents.test.js`:
  conservation (own + subagents + unattributed == the deduped usage of
  every transcript, field by field) and each transcript counted exactly
  once. See DESIGN.md "Subagent usage".

- `tree`/`graph` (and `skill-entry`) gain `--full`, which prints each
  prompt's complete text below its node line, wrapped to the available
  width and indented to the prompt column, dimmed, with paragraph breaks
  preserved; the node line itself is cut (no `…`) instead of duplicating
  text into the body. Composes with `--responses` (adds a `── response ──`
  marker before the full response body) and with `-v` (body first, then the
  tools/files/models lines). Slash-command turns have no body. `--width N`
  overrides the terminal width used for truncation/wrapping (clamped to
  60-400; default `process.stdout.columns` when a TTY, else 120).
- `promptlog graph [-n N] [-v] [--reverse] [--format auto|ascii|mermaid]
  [--fenced]`: the tree/graph view the skill now defaults to (`skill-entry`
  with no args runs `graph -n 15`). `--fenced` wraps the ASCII output in a
  `text` fence so a prompt's own text is never re-interpreted as Markdown by
  whatever renders the reply; `mermaid`'s id list is now fenced the same
  way. `tree` and `mermaid` remain as explicit subcommands.
- Adapter contract: `ui({session, env}) -> 'terminal' | 'desktop' |
  'unknown'`, so a host decision that used to be left to the skill (and to
  the agent's own judgment) is answered from data the adapters already have.
  Codex reads `session_meta.payload.originator` (kept on
  `session.meta.originator` by the parser): `codex-tui`/`codex_exec` ->
  terminal, `Codex Desktop`/`codex_work_desktop` -> desktop, anything else
  -> unknown. Claude reads `env.CLAUDE_CODE_ENTRYPOINT === 'cli'` ->
  terminal, unset or anything else -> unknown. Cursor has no signal yet ->
  unknown. Surfaced as a `ui:` line in `promptlog env` (and in `--json`).

### Changed

- **One visual layout for every host, not a per-host choice.** `graph
  --format auto` was briefly wired to pick Mermaid for a "desktop" `ui()`
  and ASCII otherwise; Mermaid's gitGraph rendered badly in the Codex
  desktop app (overlapping tags, no prompt text, id list mangled by
  Markdown), so `auto` now always means ASCII. Mermaid stays available only
  when explicitly requested (`promptlog mermaid`, or `graph --format
  mermaid`). SKILL.md's "Showing the tree visually" section no longer has
  any terminal-vs-desktop branch: the same command and the same fenced
  ASCII output is correct everywhere, and the skill never judges the host.
  `ui()` and `env`'s `ui:` line stay, since they're cheap and still useful
  signal - `graph` just no longer depends on them.

## 0.3.0

### Added

- Cursor adapter: transcript parsing, tier A (`ApplyPatch`) and tier B
  (shell) edit evidence, SQLite sidecar lookup for timestamps/tokens where
  available (`tokensPartial`), fixtures and contract-test coverage.
- Status line: `promptlog status` (one-line summary: prompts, active time,
  tokens, tool calls; `--json`) and `promptlog statusline` (reads an agent's
  own statusLine payload from stdin, resolves the matching session, and
  never breaks the host's status line).
- `promptlog skill install|update|uninstall` and `promptlog doctor`: capability-gated
  install across every detected agent, per-agent self-check, staleness hints.
- Distribution channels: `npx skills add`, Claude Code and Codex marketplace
  manifests, `install.sh`.
- `promptlog env`: prints detected agent, session, transcript, repo root, and
  hook install status.
- Session-document and README merge drivers (`merge=promptlog`,
  `merge=promptlog-readme`) so two clones can push/pull without text conflicts.
- Lazy `index.jsonl` freshness check (HEAD sha + sessions hash) instead of a
  `post-merge` hook.
- `reindex` rebuilds `index.jsonl`/README from session docs plus a whole-commit-body
  trailer scan, cached and incrementally updated per ref movement.

### Changed

- Source moved to `src/core/` (agent-neutral) plus `src/agents/<id>/` (one
  adapter per agent), with a shared adapter contract and a registry that
  loads adapters by directory — core code never names an agent directly.
  `skills/promptlog/scripts/` ships a mechanical copy produced by
  `npm run pack-skill`, checked by `pretest` for drift.
- Attribution rewritten: contributor turns (matched hunk-by-hunk against
  `git diff --cached`) versus a committer turn (the agent's own active
  turn), replacing the old "highest overlap wins" / time-window selection.
  Evidence tiers documented (A: structured edits, B: shell heuristics,
  C: roadmap checkpoint hook).
- Package renamed to `@kkdevenda/promptlog` (npm name `promptlog` was
  taken); the `promptlog` bin, skill directory name, and git config keys are
  unchanged.

### Fixed

- Multi-person usage: `index.jsonl` is no longer committed (local, gitignored,
  lazily rebuilt); `sessions/*.json` and `README.md` merge structurally
  instead of conflicting as text.
- Squash-merge trailers: `reindex` scans the whole commit body, not just the
  trailer block, so squashed commit messages still resolve prompt ids.

## 0.2.0

Node port of the original Python prototype: redaction (deterministic, no
model), a per-repo `.promptlog/` store, opt-in git hooks
(`pre-commit`/`prepare-commit-msg`/`post-commit`/`post-rewrite`), and
`Prompt-Id:` commit trailers linking commits to the prompts that produced
them.

## 0.1.0

Python prototype: `tree`, `last`, and `html` views over a Claude Code
transcript. No repo store, no redaction, no git integration.
