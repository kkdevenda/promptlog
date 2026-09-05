# Cost estimates — scope

Status: **proposal, no code yet**. Listed on the README roadmap as "Cost
estimates with editable rates". This document scopes the feature for review;
it does not implement it.

## Goal

An estimated dollar cost per prompt, per session, per commit, and per repo,
derived **at render time** from tokens already captured in `Turn` (see
`src/core/model.js`). Never stored in a record: rates change, and history
must never be rewritten to match today's pricing. `promptlog cost` and the
`--cost` flag (below) compute cost live from `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `thinkingTokens`, and each turn's
`models` set every time they run.

## Data available today, per adapter

- **Claude** (`src/agents/claude/parser.js:extractUsage`): `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  and `output_tokens_details.thinking_tokens` (thinking is billed as output).
  The transcript's `message.usage` also carries `cache_creation.
  ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` (two cache-write
  price tiers) and `service_tier`, but **the parser does not extract either
  today** — `cache_creation_input_tokens` is the pre-summed total, and
  `service_tier` isn't read at all. Model comes from `message.model`, added
  to a turn's `models` `Set` — a turn can carry more than one model.
- **Codex** (`src/agents/codex/parser.js`): `token_count` events are
  cumulative counters; the parser diffs them per turn into
  `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens`, `reasoning_output_tokens` (reasoning bills as output).
  Model comes from the `turn_context` event's `payload.model`, one per turn
  the same way.
- **Cursor** (`src/agents/cursor/parser.js`, `sidecar.js`): the transcript
  itself carries no tokens (`capabilities.tokens: false`); a per-bubble
  `tokenCount: {inputTokens, outputTokens}` is recovered from Cursor's local
  SQLite when available (`tokensPartial: true`), otherwise turns show 0.
  No cache/thinking split exists for Cursor at all.

## Subagent (sidechain) usage is attributed to the spawning prompt

Since v0.4, Claude Code subagent transcripts (`isSidechain: true` records,
separate files and separate API requests) are read and attributed to the
prompt whose `Agent` tool call spawned them. The split is deliberate so a
user can still see how much of a turn's cost was "it" versus "its agents":

- **Rows** (one line per prompt in `tree`/`graph`) show the prompt's **own**
  usage only.
- **Totals** (session footer, `status`, `statusline`) show own **plus**
  subagent usage.
- "Output" figures (row ↑, totals, `status`/`statusline`) are output **plus
  thinking** tokens, for own and subagent usage alike (`src/core/subagents.js`
  `totalsWithSubagents`); Codex `reasoning_output_tokens` is the thinking
  figure there and bills as output.

Cost, once it lands, follows the same shape: a per-row own cost, and totals
that include subagents. Sidechain usage is never silently folded into a
row's own figure.

## Rates

- Shipped `rates.json` in the package: `{model pattern -> {inputPerMTok,
  outputPerMTok, cacheReadPerMTok, cacheWrite5mPerMTok, cacheWrite1hPerMTok},
  currency: "USD", asOf: "YYYY-MM-DD"}`. Model pattern matching handles
  aliases/snapshots (e.g. `claude-sonnet-4-5*`) the way `t.models` stores the
  exact string the transcript used.
- Overrides, merged in order shipped -> `~/.promptlog/rates.json` -> repo's
  `.promptlog/rates.json` (repo wins).
- Unknown model (no pattern matches) -> **no cost shown for that turn**,
  never a guessed rate; the renderer shows tokens only, same as today.
- Warn once per invocation (not per turn) when the shipped `rates.json`'s
  `asOf` is more than 90 days old — a nudge that prices likely drifted, not a
  hard failure.
- No network, ever, for rates — matches the "promptlog never makes a network
  call" privacy line for everything except the unrelated, already-scoped
  update check (README "Privacy").

## Codex and Cursor nuances

- Codex ChatGPT-subscription users pay no per-token price at all; API-key
  users do. Since a transcript alone can't tell which mode produced it, cost
  is only shown when the user has configured API rates for the Codex models
  in question — otherwise Codex turns show tokens only, same as an unknown
  model. Every Codex-derived dollar figure is labeled **"est."**, never a
  bare number, since even API pricing can trail announced rates.
- Cursor: no cost until token counts are real (i.e. `tokensPartial`
  resolved them from the sidecar DB) — a turn showing 0 tokens shows no
  cost, not `$0.00`.

## Rendering

- Opt-in **`--cost`** first; default-on only once rate-table confidence is
  established (see "Open decisions").
- Adds a `$` column to `tree`/`graph` (and their totals line), a cost line
  to `last` and `show`, a cost figure on the status line, and a per-commit
  sum in `show <sha>` and the `.promptlog/README.md` table.
- Column width budget matters: the tree is already wide (see
  `src/core/renderTree.js`), so the `$` column should be short (`$0.12`,
  `$1.4k`-style rounding past some threshold, matching `humanizeNumber`'s
  style in `src/core/util.js`) and omittable when `--cost` isn't passed —
  never added unconditionally.

## Commands

`promptlog cost [--since DATE] [--by session|commit|model|day]` — aggregate
view, no dependency on `--cost` being passed to other commands. Default `--by
session`. Unknown-model turns are counted in a token-only "no rate" bucket
per grouping, never silently dropped from the totals shown.

## Accuracy statement

Print in `--help` (under the `cost` line) and in README: *"Costs are
estimates from token counts and a locally-configured rate table; they are
not your provider invoice. Unknown models show tokens, never a guessed
price. Codex/subscription usage may be free even when a rate is
configured."*

## Work estimate

| Module | Work | Size |
|---|---|---|
| `src/core/rates.js` | load/merge shipped + user + repo rates.json, model-pattern match, 90-day staleness warn | S |
| Usage normalisation per adapter | Claude: capture ephemeral 5m/1h + service_tier; Codex: none needed, already split; Cursor: none needed | S–M |
| Sidechain attribution | **done in v0.4** (`src/core/subagents.js`, per-agent `subagents.js`): `Agent` tool_use id -> spawned session id -> separate subagent subtotal; cost only needs to consume it | — |
| `src/core/cost.js` (compute) | per-turn dollar calc from `Turn` + rates, session/commit/day aggregation for `promptlog cost` | S–M |
| Renderers (`tree`, `graph`, `last`, `show`, status line, `.promptlog/README.md`) | `--cost` column/line wiring, width budget | M |
| `promptlog cost` command | new subcommand, `--since`/`--by` | S |
| Config | `~/.promptlog/rates.json`, `.promptlog/rates.json` discovery | S |
| Tests | rates merge/precedence, unknown-model no-guess, staleness warn, sidechain attribution, per-adapter usage shapes, renderer column budget | M |
| Docs | README, `--help`, this file's accuracy statement kept in sync | S |

Rough total: a small-to-medium feature, dominated by the sidechain
attribution decision and touching every renderer.

## Open decisions for the owner

1. ~~**Sidechain attribution default**~~ — resolved in v0.4: rows show own
   usage, totals show own + subagents as a separate figure (see "Subagent
   (sidechain) usage" above). Cost inherits that split; nothing left to decide.
2. **Opt-in vs. default-on**: ship `--cost` opt-in only, or make it
   default-on once rates are trusted? Default-on changes the tree's column
   layout for every user immediately, including those without rates
   configured (who'd see "no rate" everywhere).
