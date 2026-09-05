# promptlog v0.3 plan

Status: IMPLEMENTED — released as v0.3.0 and v0.4.0 (proposed 2026-09-03).
Supersedes DISTRIBUTION.md. [DESIGN.md](DESIGN.md) is the current contract
for behaviour; this document is kept as the rationale for the changes and
the order they were made in.

## 1. Decisions carried forward from discussion

| Topic | Decision |
|---|---|
| Agent surface | One skill. Claude Code exposes it as `/promptlog`, Codex as `$promptlog`. No `commands/` or `prompts/` files: a same-named command shadows the skill in Claude Code, and a Codex prompt adds nothing over the skill. |
| Where the CLI lives | Inside the skill directory (`skills/promptlog/scripts/`). Zero dependencies make the skill self-sufficient: whatever copies the directory delivers a working tool. Precedent: Agent Skills spec allows `scripts/`; impeccable ships its CLI beside its skill. |
| PATH | Agents run the script from the skill's own directory. Git hooks use the absolute path baked in at `init`. Humans get the binary via `npm i -g promptlog`. Never `npx` in a hook. |
| Which agents get the skill | Only agents with a working adapter. A capability flag per adapter gates installation. Detected-but-unsupported agents are reported by `doctor`, never installed into. |
| Installation | Explicit `promptlog skill install|update|uninstall`, copy not symlink, never from `postinstall`. Also reachable via `npx skills add`, and the Claude and Codex marketplaces. All point at the same directory. (`install.sh`, a clone-and-run installer, was removed before the first public release; a standalone installer may return later.) |
| Capture | Transcripts remain the primary input, zero-config. A recorder agent-hook is roadmap for agents without readable transcripts. |
| Version control | Store is plain files, designed so git is the first adapter rather than the only one. Recall from a live transcript (`tree`, `last`, `grep`, ...) needs no VCS at all. `sync`, `init`, and the repo store (`.promptlog/`) require a git repository; an explicit non-git store root is not implemented. |
| Attribution | File level from tool edits, hunk level where evidence allows. Committer recorded separately from contributors. "Highest overlap wins" is removed. |
| Multi-person | Session docs per session never collide. `index.jsonl` is not committed and is rebuilt lazily. README committed, regenerated only at commit time. Commit-message trailers are the truth; sha lists in session docs are cache. |
| Index freshness | Lazy: header line with HEAD sha and a hash of the sessions listing; rebuild on mismatch at next read. No `post-merge` hook needed. |

## 2. Repository layout

```
src/core/        model, redact, store, resolve, git, attribution, renderers, registry
src/agents/
  claude/        index.js parser.js locate.js edits.js fixtures/
  codex/         index.js parser.js locate.js edits.js fixtures/
  cursor/        (v0.3, see §4)
  _template/     the adapter contract with TODOs
skills/promptlog/
  SKILL.md       frontmatter: name, description, version, compatibility
  scripts/       promptlog.js + a copy of src/ produced by `npm run pack-skill`
test/            unit, contract (runs every adapter), integration (real git)
```

`package.json` `bin` points at `skills/promptlog/scripts/promptlog.js`. The
`pack-skill` step is a file copy, not a build; CI fails if `skills/promptlog/
scripts` differs from `src/`. This is the one concession to duplication and it
is mechanical.

> **Superseded 2026-09-04.** The duplication was removed: `src/` and `hooks/`
> now live only inside `skills/promptlog/scripts/`, and `pack-skill` and the
> sync check are gone. The layout block above is kept as the historical plan;
> DESIGN.md "Layout" describes the current tree.

### Adapter contract (`src/agents/<id>/index.js`)

```
id, displayName
capabilities: { parse, liveSession, edits, tokens, hooks }
detectInstalled(home)            -> bool            (is this agent on the machine)
skillDirs(scope, home, cwd)      -> [paths]         (where its skills live)
sessionEnvVars                   -> ['CLAUDE_CODE_SESSION_ID']
locate({cwd, env, home, since})  -> [{path, sessionId, mtime}]
parse(path)                      -> Session          (shared model)
edits(session)                   -> [{turnId, file, kind, before, after | patch}]
```

Core never imports an agent by name. The registry loads every directory under
`src/agents/`. Adding an agent is one directory plus fixtures; the contract test
runs unchanged against it.

## 3. Attribution

### 3.1 Contributors versus committer

- **Contributor turns**: for every staged file, every turn in every candidate
  session that edited that file since the previous commit. Union across files.
- **Committer turn**: when an agent commits, its env var names the session and
  its active turn is linked with `role: committer`, even if it edited nothing.
  A human commit has no committer turn; the absence is recorded as such.
- Candidate sessions: every transcript for this repo modified since the
  previous commit, all agents. No "newest wins", no "highest overlap wins".
- Turns that edited nothing in the commit are not linked, unless committer.

### 3.2 Evidence tiers

| Tier | Source | Confidence | Status |
|---|---|---|---|
| A | Claude `Edit` (old/new string, path), `Write` (content, path); Codex and Cursor `apply_patch` (unified-diff text with file headers) | high, hunk-level | 872 Edit, 227 Write, and apply_patch payloads verified on this machine |
| B | Shell commands in `Bash`/`Shell` tool calls parsed for paths: redirects `>` `>>`, `tee`, `sed -i`, `mv`, `cp`, `git apply`, `patch`, heredocs to a path | medium, file-level | heuristic; recorded with `confidence: shell` |
| C | Optional per-turn checkpoints via a recorder hook running `git write-tree` on a temp index into `refs/promptlog/checkpoints` | high, hunk-level, catches everything | roadmap, opt-in; puts us in the agent loop |

### 3.3 Hunk matching (tier A)

At `pre-commit`, take `git diff --cached -U0` per staged file. For each hunk,
normalise whitespace and compare its added lines against each candidate edit
for that file since the previous commit:

- `Edit`: if the hunk's added lines contain `new_string`'s lines (in order),
  attribute the hunk to that turn. If several edits overlap the same region,
  attribute to all, latest marked `final`.
- `Write`: attribute every hunk in that file to the turn if the staged blob's
  hash equals the hash of `content`; otherwise fall back to line containment.
- `apply_patch`: parse the patch into hunks and compare added lines directly.
- Unmatched hunks stay unattributed. That is the honest outcome for human or
  shell edits without tier B or C evidence.

Output per commit: `{gid: {files: {path: {hunks: n, matched: m, confidence}}}}`
stored on the record's commit entry. Trailers stay ids only.

### 3.4 On using git tooling for shell edits

Git can tell us *what* changed (`diff --cached`) but not *who* changed it
between commits, because the working tree has no history between commits. So
git alone cannot attribute a `sed -i`. The options are: parse the command
(tier B, heuristic), or snapshot after each turn (tier C, complete but in the
loop). Using git plumbing for the snapshots is not an anti-pattern in itself,
`write-tree` on a temporary index is exactly what git is for and costs
milliseconds. What would be an anti-pattern for *this* tool is making it the
default, because the zero-capture promise is the differentiator. So: tier B
by default, tier C opt-in per repo for teams that want completeness and accept
a recorder hook. `git blame`-style reconstruction after the fact is not
possible for uncommitted work and is not attempted.

### 3.5 Record shape change

```json
"commits": [
  { "sha": "…", "role": "contributor" | "committer" | "both",
    "files": { "lib/cli.js": { "hunks": 3, "matched": 3, "confidence": "edit" } } }
]
```

`reindex` rebuilds this list from commit trailers plus stored evidence; it is
cache, never truth.

## 4. Cursor adapter (findings from this machine, 2026-09-03)

- Location: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`,
  one file per conversation; subagents under `…/subagents/`. Slug is the
  sanitised cwd, same idea as Claude's.
- Records: `{role, message.content[]}` with `text` and `tool_use` blocks, and
  `{type:"turn_ended"}` marking turn ends. No structured timestamps, no
  session id field, no token usage in the JSONL.
- Timestamps exist only as text inside the user message
  (`<timestamp>Tuesday, Sep 1, 2026, 3:09 PM (UTC+5:30)</timestamp>`) and,
  reliably, in SQLite: `~/Library/Application Support/Cursor/User/globalStorage/
  state.vscdb`, table `cursorDiskKV`, keys `bubbleId:<composerId>:<bubbleId>`
  with `createdAt` ISO and `tokenCount` (often zero).
- Edits: `ApplyPatch` tool_use with a V4A patch string. Tier A evidence.
- No env var for the live session found. Session resolution falls back to
  newest-for-cwd; the hook attribution path (file overlap) does not need it.

Adapter plan: parse the JSONL as primary (turns, edits, tool counts), read the
SQLite sidecar read-only for timestamps and tokens when present, degrade to
text-embedded timestamps when not. Capabilities: parse yes, edits yes,
liveSession no, tokens partial. Node has no built-in SQLite before 22.5
(`node:sqlite`, experimental); for Node 18 to 20 the adapter shells out to
`sqlite3` if present and otherwise reports timestamps as approximate. Zero
dependencies preserved.

## 5. Multi-person and pull path

| File | Committed | On pull | Catch-up |
|---|---|---|---|
| `sessions/*.json` | yes | merges cleanly; same-session divergence resolved by a union merge driver registered at `init` | none |
| `index.jsonl` | no | untouched | lazy rebuild on next read |
| `README.md` | yes | arrives from upstream | your next commit |
| `config.json` | yes | text merge | none |

- Contributors opt in per clone with `promptlog init`; git forbids anything
  else by design. A repo carrying `.promptlog/config.json` is the signal;
  `doctor` and the skill tell a new contributor to run `init`.
- `reindex` scans whole commit bodies for `Prompt-Id` lines, not only the
  trailer block, because squash merges move them into the body.
- The skill surfaces `promptlog review` before a contributor's first commit
  into an opted-in repo.
- Records from others are data: escaped in rendering, never executed.

## 6. Distribution

Unchanged from DISTRIBUTION.md except: install only into agents whose adapter
has `capabilities.parse`, and the installer runs `promptlog env` from inside
each installed location and prints a per-agent status line. Channels:
`npx skills add kkdevenda/promptlog`; Claude marketplace manifest; Codex
marketplace manifest; `npm i -g promptlog && promptlog skill install`.
Staleness: frontmatter `version`, once-a-day dim hint, no network.

## 7. Implementation order

Each phase ends green on `npm test`, `scripts/smoke.sh`, and the live check
from a real session. Phases are independent enough to run in parallel where
marked.

1. **Layout** (mechanical). Move to `src/core` and `src/agents/{claude,codex}`,
   registry, adapter contract, contract test, `pack-skill`, CI diff check.
   Parity: `--json` identical before and after on every local transcript.
2. **Attribution** (can run with 1). `edits()` for both adapters; tier A hunk
   matcher; tier B shell parser; new commit entry shape; contributor/committer
   selection replacing the window-and-overlap rules; `reindex` from trailers.
   Tests: two synthetic sessions editing one repo, one file each and one shared
   file, agent commit and human commit, assert per-file attribution and roles.
3. **Multi-person**. Gitignore index; index header and lazy rebuild; union
   merge driver for session docs; whole-body trailer scan. Tests: two clones,
   divergent branches, pull, merge, squash.
4. **Skill packaging and install**. `promptlog skill install|update|uninstall`,
   `doctor`, capability gating, per-agent self-check, marketplace manifests,
   SKILL.md `compatibility`. Tests with a temp HOME containing fake agent dirs.
5. **Cursor adapter**. Parser, sidecar timestamps, fixtures from this machine
   (redacted), contract test passing. Ships only when tier A edits and turn
   boundaries pass on real files.
6. **Recorder hook and tier C** (roadmap, after review of 1 to 5).

Estimated agent work: phases 1 to 4 about one focused day each with review
rounds; phase 5 half a day plus verification against real Cursor sessions.

## 8. Open decisions for review

1. Approve the layout move and the `pack-skill` copy as the one duplication.
2. Approve the attribution model: contributors by evidence, committer by env
   var, no fallback guessing.
3. Approve tier B shell parsing as default and tier C as opt-in roadmap.
4. Approve Cursor as the third adapter with partial tokens.
5. Repo name, so install commands and marketplace manifests are real.
