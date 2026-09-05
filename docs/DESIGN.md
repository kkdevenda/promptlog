# promptlog design

This document is the contract for everyone working on the codebase. If code and
this document disagree, fix one of them in the same change. Keep it current.

## Layout

Source and shipped code are two different trees, and the second is built
from the first.

- `src/` is the TypeScript source. `src/cli.ts` is the entry point.
  `src/core/` is agent-neutral (model, redact, store, resolve, git,
  attribution, renderers, session resolution, `commands/`). `src/agents/<id>/`
  is one directory per agent (`index.ts` implements the `Adapter` interface
  from `src/agents/types.ts`, plus `parser.ts`, `locate.ts`, `edits.ts`,
  `subagents.ts`). `src/agents/index.ts` is the registry, a static list, and
  the only place core code names an agent.
- `skills/promptlog/` is what every install channel ships (plugin
  marketplaces, `npx skills add`, `$skill-installer`, the npm package's
  `bin`): `SKILL.md` and `scripts/promptlog.js`. There is no separate hook
  template file - `promptlog init` generates each hook file directly (see
  "Hooks"), baking in this very file's path.
  `scripts/promptlog.js` is the whole CLI bundled by `npm run build` (esbuild)
  into one readable, unminified CommonJS file targeting Node 18. It is
  **committed**, because four of the five channels install straight from
  git, and CI rebuilds it and fails when the committed file differs from
  `src/`. It is never edited by hand.
- The repo root also holds `test/` (vitest, fixtures under
  `test/fixtures/<agent>/`), `scripts/` (build and release), `docs/`, the
  plugin manifests, and `bin/promptlog.js`, a two-line shim into the bundle
  for running the checkout.

Runtime dependencies: none. Dev dependencies: typescript, esbuild, vitest,
biome. See PLAN-v0.3.md §2 for the adapter contract.

## What promptlog is

A zero-dependency Node CLI (Node >= 18.3, no runtime npm deps) that reads
the transcripts Claude Code, Codex, and Cursor already write to disk and:

1. shows the user's prompts back (last prompt, tree, mermaid, HTML fragment),
2. optionally records redacted prompt records into a git repo at commit time,
   linking prompts and commits many-to-many.

Nothing sits in the agent's loop. There are no per-prompt agent hooks. The only
hooks are git hooks, opt-in, that run a handful of times a day and fail open.

## Vocabulary

- **transcript**: the agent's own JSONL log on disk. Claude Code:
  `~/.claude/projects/<slug>/<sessionId>.jsonl` where slug = cwd with every `/`
  replaced by `-`. Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`.
  Cursor: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`
  where slug = cwd with the leading `/` stripped and every remaining `/`
  replaced by `-` (see `src/agents/cursor/locate.ts`).
- **turn / prompt**: one human-typed message plus everything the agent did
  until the next one. `Turn` in `src/core/model.ts`.
- **origin**: where a prompt lives authoritatively: the transcript.
- **record**: the redacted copy of a turn stored in the repo under `.promptlog/`.
- **source**: which of the two a renderer is showing for a given turn:
  `origin`, `origin-modified` (transcript found but hash differs), `repo`.

## Host and session identification

Order of resolution for "which session am I in", used by the CLI and the hooks:

1. `--session <path|uuid|prefix>` explicit.
2. `CLAUDE_CODE_SESSION_ID` env var -> Claude transcript with that id (search
   the slug dir for cwd first, then all slug dirs).
3. `CODEX_THREAD_ID` (fallback `CODEX_SESSION_ID`) env var -> Codex rollout file
   whose filename ends with that id, or whose `session_meta.payload.id` matches.
4. Otherwise: the most recently modified transcript whose recorded cwd is the
   current repo root or a subdirectory of it. Prefer the agent given by
   `--agent`; with `auto`, take the newest across all agents.
5. Which host we are running under, for the skill's visual decision, is decided
   by the agent reading the skill, not by the CLI. The CLI only exposes
   `promptlog env` printing what it detected (agent, session id, transcript
   path, repo root, hooks enabled) so the agent and the user can check.

Hooks do **not** disambiguate: they take every candidate session for the repo,
from every adapter, and attribute per staged hunk instead (see "Which turns
belong to a commit"). The old intersect-and-pick-the-best-overlap rule is gone.

## Transcript parsing rules (already implemented, keep)

Claude: records of type `user`/`assistant`, skip `isSidechain`, skip `isMeta`,
a prompt is a user record whose content is a string or text-only blocks, not
starting with any of: `<local-command-caveat>`, `<system-reminder>`,
`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<local-command-stdout>`,
`<task-notification`, `[Request interrupted by user]`. `<command-name>` or
`<command-message>` prefix => slash command (`isCommand`). Usage is deduped by
`message.id`. Parent walk over `parentUuid` is iterative with caching. Also skip
any record with `isCompactSummary: true` or `type: "summary"` (compaction
markers; never seen locally, handle defensively, add a fixture).

Codex: `event_msg/user_message` opens a turn; when a file has none of those
(desktop app), `response_item` messages with role `user` do. Skip prefixes:
`<environment_context>`, `<recommended`, `<skills`, `<user_instructions>`,
`<permissions`, `<turn_aborted>`. Tokens are the cumulative
`token_count.total_token_usage` delta per turn, fallback to summing
`last_token_usage`. Short id = sha1(`<sessionId>-<n>`)[0:7].

### New: response capture

Each turn gets `response` (string or null): the agent's final visible text for
that turn. Claude: concatenate the `text` blocks of the last assistant message
(by `message.id`) in the turn. Codex: the last `event_msg/agent_message` in the
turn, else the last `response_item` message with role `assistant`
(`output_text` blocks). Set `responsePending: true` when the turn has no
assistant text yet (commit happened mid-turn). Renderers show the response only
with `--responses`.

## Prompt identity

`Turn.fullId` is stable: Claude uses the user record `uuid`; Codex uses
`<sessionId>-<n>`. `Turn.id` is the 7-char short id. A **global prompt id**
used in trailers and the store is `<agent>:<sessionId8>:<shortId>`, e.g.
`claude:c86e0429:5043cd5`. Everything in the repo keys on the global id.

## Redaction (src/core/redact.ts)

Deterministic, no model. `redact(text, config) -> { text, findings[] }`.
Layers, in order:

1. **Known secret shapes**: AWS access keys (`AKIA[0-9A-Z]{16}`), AWS secret
   (40 base64 chars after `aws_secret` context), GitHub tokens (`gh[pousr]_`),
   `github_pat_`, Slack (`xox[baprs]-`), Stripe (`sk_live_`, `rk_live_`),
   Google API keys (`AIza[0-9A-Za-z_-]{35}`), OpenAI/Anthropic (`sk-...` 20+),
   JWTs (three base64url segments starting `eyJ`), private key blocks
   (`-----BEGIN ... PRIVATE KEY-----` to END), bearer headers, URLs with
   `user:pass@`, `.env` style assignments where the key name matches
   `/(pass(word)?|secret|token|api[_-]?key|private[_-]?key|auth)/i` (quoted
   values may contain spaces; values under 8 chars are ignored).
2. **Allow rules**: `config.allow` regexes protect their matches from every
   later layer. Allow rules never protect a known secret shape; they protect
   ordinary text (a project codename, a public fingerprint, a known hash)
   from the deny, entropy, paste and email layers. `allow: ['.*']` still
   redacts an AWS key.
3. **Deny rules**: `config.deny` regexes are always redacted.
4. **High entropy**: any token of 32+ chars from `[A-Za-z0-9+/_=-]` with
   Shannon entropy > 4.0 bits/char that is not a uuid, sha, or path segment.
5. **Paths**: the user's home directory prefix becomes `~`. Absolute paths
   outside the repo are kept but home-collapsed.
6. **Large pastes**: any contiguous block > `config.pasteLines` (default 40)
   lines or > `config.pasteBytes` (default 4000) is replaced by
   `[pasted: <n> lines, <bytes> bytes, sha256:<12 hex>]`.
7. **Emails** are redacted to `[redacted:email:<hash4>]` unless
   `config.keepEmails` is true (an email is identifying, not a secret, so
   keeping it is a documented setting).

Each layer protects its matches from every later layer, which is why order
matters: secret shapes run first so no configuration can exempt them.

Redaction **fails closed**. If `src/core/redact.ts` cannot be loaded, or `redact()`
throws, or it returns anything but a string, the store raises
`RedactionUnavailable`: no record is written, no trailer is added, and the hook
prints one line to stderr. Storing plaintext because a module failed to load
would leak exactly what this tool promises to strip, so there is no fallback
path that writes unredacted text.

Replacement format: `[redacted:<kind>:<hash4>]` where hash4 = first 4 hex of
sha256(original). Same secret -> same placeholder. Findings list
`{kind, hash4, start, end}` for the review UI. Every prompt AND response
written to the repo passes through `redact`. There is no flag to skip it, and
no allow rule can exempt a known secret shape.

## Repo store (src/core/store.ts, sessionRecords.ts, storeIndex.ts, renderReadme.ts)

```
.promptlog/
  config.json            # see below
  .gitignore             # "index.jsonl" - never committed (see "Multi-person")
  sessions/<agent>-<sessionId8>.json   # source of truth, one doc per session, committed
  index.jsonl            # derived, LOCAL ONLY: one line per prompt, lazily rebuilt
  README.md              # derived, committed: mermaid gitGraph + table
```

`sessions/*.json` and `README.md` are committed; `index.jsonl` and `.promptlog/
.gitignore` are the only files here that are never staged by promptlog itself
(`init` untracks a pre-v0.3 `index.jsonl` if one was committed before). See
"Multi-person" below for why, and for the merge drivers `init` registers for
the two committed, mergeable files.

### config.json

```json
{
  "version": 1,
  "enabled": true,
  "responses": "final",          // none | final
  "redact": { "pasteLines": 40, "pasteBytes": 4000, "allow": [], "deny": [], "keepEmails": false },
  "notes": false,                // also mirror into refs/notes/promptlog
  "readme": true                 // regenerate .promptlog/README.md on commit
}
```

### Session document

```json
{
  "version": 1,
  "agent": "claude",
  "sessionId": "c86e0429-...",
  "cwd": "~/Developer/whatsareyouworkingon",
  "machine": "<sha256(hostname+username)[0:12]>",
  "started": "2026-09-02T10:19:46.683Z",
  "turns": {
    "claude:c86e0429:5043cd5": {
      "id": "5043cd5", "fullId": "<uuid>", "parentId": "<global id or null>",
      "ts": "…Z", "durationS": 747.2,
      "prompt": "<redacted>", "response": "<redacted or null>", "responsePending": false,
      "isCommand": false,
      "tokens": { "output": 21600, "input": 2, "cacheRead": 1200000, "cacheWrite": 18000, "thinking": 9000 },
      "toolCalls": 15, "toolNames": { "Bash": 12, "Agent": 3 },
      "files": ["src/core/cli.ts"],
      "models": ["claude-fable-5-1"],
      "origin": { "path": "~/.claude/projects/<slug>/<sid>.jsonl", "uuid": "<record uuid>",
                  "promptHash": "sha256 of ORIGINAL unredacted prompt", "responseHash": "… or null" },
      "redactions": [{ "kind": "aws-key", "hash4": "7f3a" }],
      "commits": [
        { "sha": "<full sha>", "role": "contributor" | "committer" | "both" | "unknown",
          "files": { "src/core/cli.ts": { "hunks": 3, "matched": 3, "confidence": "edit" } } }
      ]
    }
  }
}
```

`files` holds repo-relative paths for anything inside the repo. A path
**outside** it stays absolute, and an absolute path is a string like any
other: it is home-collapsed (`~/…`, compared through `realpath`, so macOS's
`/var` vs `/private/var` cannot leak the real home) and passes through
`redact()` exactly like the prompt and the response, with its findings folded
into `redactions`. There is no path by which unredacted text reaches the
store.

Upsert semantics: writing a turn that exists merges: `commits` is a union keyed
by `sha` (a turn that both contributed and committed becomes `role: "both"`,
and per-file evidence is merged rather than replaced), `response` is filled if
it was pending, everything else is replaced with the fresh parse. Files are
written atomically (tmp + rename).

The whole `commits` list is **cache, never truth** (PLAN-v0.3.md §1): the
commit-message trailers are, and `reindex` rebuilds the list from them. A sha
no commit message mentions is dropped; a sha only a trailer knows about gets
`role: "unknown"` with no files. See "Which turns belong to a commit".

For the **active turn** (see "Which turns belong to a commit") the record
stores `response: null` and `responsePending: true`, with
`origin.responseHash: null` - whatever text the turn has emitted so far is
mid-turn narration between tool calls, not the agent's final answer, so it
must not be frozen into the record. The upsert backfill fills the real response
in on the next commit or `promptlog sync` that sees the turn as no longer
active. The record's `responsePending` is therefore derived from active-ness,
not copied from the parser's field of the same name.

### README.md

Derived, regenerated on commit when `config.readme` is true, and never edited by
hand. A mermaid `gitGraph` where each commit line carries the metrics as a tag
suffix (`tag: "12m · ↑21.6k · 2 commits"`) plus a markdown table of
gid / time / duration / tokens / first line / commits. Commit shas are linked
as `../../commit/<sha>`, which resolves on both GitHub and GitLab.

Because the file is committed and read across time zones, its timestamps stay
UTC but compact: `2026-09-02 10:19Z`. Terminal output is the opposite — `show`,
`grep`, `files` and `review` print local `YYYY-MM-DD HH:MM`, matching the tree
header.

Every table cell is sanitised: newlines flattened to spaces, backticks stripped
(an unbalanced one opens a code span that swallows the rest of the row), `|`
escaped as `\|`, trailing whitespace trimmed. The `first` field of a prompt is
one line, truncated to 80 chars, with no trailing space, in both the README and
`index.jsonl`. The header links to promptlog's own `homepage` from
`package.json` when it has one, and is otherwise plain text — never a bare
placeholder URL.

### index.jsonl

**Never committed** (PLAN-v0.3.md §1 "Multi-person"): a local, lazily rebuilt
cache, not a record. `init` writes `.promptlog/.gitignore` covering
everything in the store that is local cache - `index.jsonl`, `.cache/` (the
commit-trailer scan, see "Trailers") and `.*.tmp` (a `writeAtomic` temp file
caught mid-rename by `git add -A`) - and, if an older version left an index
tracked, untracks it
(`git rm --cached -q --ignore-unmatch`) - there is no `merge=union` gitattribute
for it any more, because there is nothing left to merge.

First line is a header, not a record:

```json
{"_promptlog_index": 1, "head": "<HEAD sha or null>", "sessions": "<sha256 over sorted (filename, sha256(content)) of .promptlog/sessions/*.json>", "builtAt": "…Z"}
```

Every line after it is one turn: `{"gid","agent","session","ts","id",
"first":"<first 80 chars>","files":[…],"commits":[…],"attributedFiles":<n>,
"durationS","out","in"}`. `commits` is a list of **shas only** - the per-file
evidence stays in the session document - and `attributedFiles` counts the
distinct files that evidence covers, so a turn carrying a commit it cannot
account for is visible without opening the document. Slash-command turns are
skipped, here and in the README, matching the selection rule above.

**Lazy freshness** (`src/core/storeIndex.ts` `ensureIndexFresh`/`indexIsFresh`):
every repo-store read (`show`, `grep`, `files`, `reindex`, `doctor`) reads the
header first and rebuilds the whole file when it is missing, corrupt, or its
`head`/`sessions` no longer match the repo as it stands - which is exactly
what a `git pull`, a teammate's push landing in this checkout, or a fresh
`sync`/commit look like. No `post-merge` hook is needed: the check is cheap
(a HEAD lookup plus hashing a handful of small documents) and runs at read
time instead.

The `sessions` fingerprint hashes each document's **content**, not its
`size`+`mtime`: `post-rewrite` swapping one 40-char sha for another, or a role
widening from `contributor` to `both`, changes neither the byte count nor
necessarily the millisecond, and a stat-based fingerprint then served a stale
index indefinitely. The
git hooks still write it after every commit as before - that is just keeping
the warm cache warm, not what makes it correct.

### Origin resolution (src/core/resolve.ts)

`resolve(record) -> { source, prompt, response }`:
1. If `origin.path` (home-expanded) exists and a turn with `origin.uuid` /
   fullId is found: compute sha256 of the original prompt. Equal to
   `promptHash` -> `source: "origin"`, return original text. Different ->
   `source: "origin-modified"`, return the repo text.
2. Otherwise `source: "repo"`.
Every renderer prints the source per row when it is not `origin`:
terminal dim tag `[repo]` / `[modified]`, HTML chip, mermaid tag suffix,
JSON `source` field. Redacted spans are highlighted in HTML: every
`[redacted:<kind>:<hash4>]` placeholder is wrapped in
`<mark class="redacted" data-kind="…">` with CSS scoped to the fragment root.
The wrapping runs on already-escaped text, so only our own markup is inserted.

## Multi-person (PLAN-v0.3.md §1, §5)

Each contributor opts in per clone with `promptlog init`; git enforces
nothing else automatically. `.promptlog/config.json` being present and
committed is the signal that a repo has opted in - `doctor` and the skill
(see "Linking a commit to its prompt" in `skills/promptlog/SKILL.md`) tell a
new contributor to run `init` when they see that signal without
`promptlog.enabled` set locally for them yet.

### Pull path

| File | Committed | On pull | Catch-up |
|---|---|---|---|
| `sessions/*.json` | yes | merges cleanly via `merge=promptlog` (see below); same-session divergence is a structural union, not a text conflict | none |
| `index.jsonl` | no | untouched (it is gitignored, so a pull never even sees it) | lazy rebuild on next read |
| `README.md` | yes | arrives from upstream; a same-turn divergence merges via `merge=promptlog-readme` | your next commit regenerates it properly |
| `config.json` | yes | plain text merge (it changes rarely and by hand) | none |

### Index freshness

`index.jsonl` is local-only cache (see "Repo store" above): a header line
carries the HEAD sha and a hash of the sessions listing it was built against,
and every read validates that header against the repo as it now stands,
rebuilding on any mismatch. This is what makes a `post-merge` hook
unnecessary - the check happens lazily, at the next `show`/`grep`/`files`/
`reindex`/`doctor`, not eagerly on every ref update.

### Session-document merge driver (src/core/merge.ts)

Two clones can legitimately write to the **same session document** - the same
agent, the same session id - when a turn is committed from two branches, or a
rebase/cherry-pick replays a commit whose `post-commit` hook fires again for
it. Git's default 3-way text merge conflicts on almost any such concurrent
edit to the same JSON file. Because a session document's `commits` list is
documented **cache, never truth** (the commit-message trailers are truth; see
"Git integration" below), it can instead merge **structurally**, which is
what `.gitattributes` (`.promptlog/sessions/*.json merge=promptlog`) plus
`git config merge.promptlog.driver` (registered by `init`, pointing at the
same baked-in absolute path the hooks use) wire up:

- `mergeSessionDocs(base, ours, theirs) -> merged` is a union of turns by
  `gid` - a turn on either side belongs in the result. Document-level fields
  (`version`, `agent`, `sessionId`, `cwd`, `machine`, `started`) prefer
  `ours`, falling back to `theirs` then `base`.
- For a turn present on both sides, `commits` is unioned by sha; where the
  same sha appears on both sides with different evidence, `role` widens (a
  turn seen as `'contributor'` on one side and `'committer'` on the other
  becomes `'both'`), and `files` is merged per path by keeping whichever
  side's evidence has the higher `matched` count.
- `response` prefers a non-null value over `null` (whichever side's `sync`/
  commit backfilled it first); `redactions` is kept from whichever side has
  any.

`promptlog merge-driver <base> <ours> <theirs>` is the CLI entry
`.gitattributes` invokes: it reads the three paths git hands it (`base` may
not exist - an add/add case), merges them, and writes the result back to
`ours`, which git treats as the resolution when the process exits 0.

Any input that **should** be a session document but cannot be read as one
(`ours`, `theirs`, or a `base` that exists and is non-empty) leaves `ours`
byte-for-byte untouched and exits 1, so git falls back to its normal conflict
handling. Treating an unreadable blob as `{}` would let the driver "resolve"
a corrupt merge by silently DISCARDING every turn on that side, which is the
one outcome a union merge must never produce. A missing or empty `base` is
not such a case: git legitimately hands one for an add/add merge, and the
union proceeds.

`.promptlog/README.md` gets the same treatment for a different reason: it is
entirely derived, so its own merge driver (`merge=promptlog-readme`,
`promptlog merge-readme <base> <ours> <theirs>`) ignores the three text blobs
it is handed and just regenerates the README from whatever session documents
are on disk at merge time, writing the result to `ours`. This only needs to
avoid a spurious text conflict, not be exact - the next commit's
`post-commit` hook regenerates it properly regardless.

### Squash merges

`reindex` (`src/core/storeIndex.ts` `rebuildCommits`, `src/core/git.ts`
`parseAllPromptIds`) scans the **whole commit body** for lines starting with
`Prompt-Id:`, not only the trailer block that `git interpret-trailers` finds,
because `git merge --squash` folds the squashed commits' own messages -
trailers and all - into the body of `.git/SQUASH_MSG`, moving the ids out of
the trailer block. Once the squashed-away branch's ref is deleted (real usage
after a squash merge), its commits are unreachable and `git log --all` no
longer sees them, so the next `reindex` attributes the gid to the squash
commit alone and drops the shas of the commits that no longer exist on any
ref. Until that branch is deleted, `reindex` legitimately attributes a gid to
every commit, on every ref, whose message mentions it - a gid is not scoped
to one branch.

### Records from others are data

A colleague's session documents and README rows are rendered exactly like a
local record: escaped, never executed, never treated as instructions. A
prompt or response string that arrived via someone else's commit is content
to display, never a command to act on.

## Git integration (src/core/git.ts, hooks/)

### Trailers

Commit-to-prompt link lives in the commit message as standard trailers:

```
Prompt-Id: claude:c86e0429:5043cd5
Prompt-Id: claude:c86e0429:0eeb962
```

Read with `git interpret-trailers --parse`. Ids only, never text.

The trailers are the truth; the shas in the session documents are cache.
`reindex` (and every `store.reindex`) rebuilds each record's `commits` from
`git log`, scanning the **whole commit body** for lines starting with
`Prompt-Id:` rather than only the trailer block, because a squash merge folds
the squashed messages into the body and moves the ids out of it
(PLAN-v0.3.md §5). Per-file evidence is preserved for a sha that survives the
rebuild; a sha only a trailer knows about becomes `role: "unknown"`. When
`git log` cannot be read at all, nothing is touched: a broken git is not
evidence that a link is wrong.

That scan is O(whole history) for something that changes one commit at a
time, and it runs on every commit and every stale index read, so it is cached
in `.promptlog/.cache/trailers.json` (gitignored, per-clone, disposable),
keyed by a hash of `git for-each-ref` plus HEAD:

| Refs since the cached scan | Work |
|---|---|
| unchanged | none - the cached `gid -> [sha]` map is used as is |
| moved forward | `git log --all ^<cached head>…`, unioned into the cache |
| a head rewritten or dropped (rebase, amend, force-fetch) | full rescan: cached shas may be unreachable, and the trailers are the truth |

"Moved forward" is verified, not assumed: every cached head must still be
reachable from some current ref (`git rev-list -1 <head> --not --all` empty),
or the scan falls back to a full one. Measured on a synthetic 20 000-commit
history: 201 ms full, 42 ms on a cache hit, 63 ms for one new commit; on the
largest real local repo (473 commits) 34 ms full, 18 ms cached. A corrupt or
missing cache costs one full scan and never a wrong answer.

The trailer block **must be the message's last paragraph**, so a blank line is
inserted when the message does not already end with a trailer paragraph.
Joining it to a body paragraph silently breaks everything downstream, because
a subject like `readme: initial` has the shape of a trailer, so
`interpret-trailers --parse` then sees no trailer block at all and
`post-commit` can never find the gids.

The blank line goes in **only** when the last paragraph is not already a
trailer block (`git.lastParagraphIsTrailers`: two or more paragraphs, the last
one entirely `Token: value` lines and folded continuations). Inserting one
unconditionally splits an existing block, which takes the trailers already
there - `Signed-off-by`, `Co-Authored-By` - out of the last paragraph and
makes them vanish from `interpret-trailers --parse` and `--format=%(trailers)`
for everyone downstream. A `Prompt-Id` joins that block instead.

### Which turns belong to a commit

Two independent questions, per PLAN-v0.3.md §3. **"Highest overlap wins" is
gone**, and so is time-window selection at commit time: a turn is linked when
it can be *shown* to have written what is being committed, or when it is the
turn the commit is being issued from.

- **Contributors.** For every staged file, every turn of every candidate
  session that edited that file since the previous commit, matched hunk by
  hunk against `git diff --cached -U0`. A turn that edited nothing in this
  commit is not linked.
- **Committer.** When an agent commits, its own env var names the session, and
  that session's active turn is linked with `role: committer` even if it edited
  nothing: the commit is being issued from inside that turn. A human `git
  commit` has no committer turn, and the absence is recorded as such (no entry
  gets that role).
- **Candidate sessions** are every transcript whose recorded cwd is in this
  repo, from **every** adapter - not just the one the env var names, and no
  "newest wins". Transcripts are still bounded by mtime before they are opened
  (only files touched since previousCommitTime minus one hour can matter), and
  session metadata is read from the first 64 KB rather than by loading the
  file whole.
- One prompt to many commits stays normal: the record accumulates one entry per
  sha, each with its own evidence.

`.promptlog/` and `.gitattributes` are excluded from the staged set: promptlog's
own generated files are never evidence about anybody's prompt.

#### Evidence tiers (src/core/attribution.ts)

| Tier | Source | Level | `confidence` |
|---|---|---|---|
| A | Claude `Edit` / `MultiEdit` (old+new string), `Write` (content); Codex `apply_patch` (V4A patch, per-file hunks) | hunk | `edit`, `write`, `patch`, or `mixed` |
| A- | Claude `NotebookEdit` - the payload is a cell replacement, with no line-level before/after to match | file | `notebook` |
| B | `Bash`/`Shell`/`exec_command` command strings parsed for written paths: `>` `>>` redirects (heredocs included), `tee [-a]`, `sed -i`, `mv`, `cp`, `patch`, `truncate`, `touch` - with `cd`/`pushd`/`popd` tracked across `;` `&&` `\|\|` and newlines, so `cd /repo; echo x >> notes.txt` resolves against `/repo` (an unresolvable `cd $VAR` or `cd -` drops the rest rather than guessing) | file | `shell` |
| C | Per-turn checkpoints via a recorder hook (`git write-tree` into `refs/promptlog/checkpoints`) | hunk | roadmap, opt-in |

Heredoc **bodies** are stripped before the command string is split
(`attribution.stripHeredocBodies`, handling `<<M`, `<<'M'` and tab-tolerant
`<<-M`), while the line that opens them is kept so its redirect target still
counts. A body is data: parsed as script, a document containing `cd /elsewhere`
or `foo > bar` invents writes and moves the tracked directory for the real
commands after it.

Tier B is a heuristic and says so: `matched: 0`, `confidence: "shell"`, never
presented as line-level proof. `git apply <file>` records **nothing** - the
command line names the patch, not the files it rewrites, and inventing them
would be a lie.

An adapter provides its own evidence through `edits(session, {root})`
(`capabilities.edits`); core never reads a transcript format itself.

#### Hunk matching (tier A)

For each hunk of each staged file, lines are compared whitespace-normalised
(indentation is not evidence) and blank lines dropped, requiring every line of
the needle to appear **in order** but not necessarily adjacently - `-U0` splits
one logical edit into several hunks.

A needle must also be **specific** or it matches nothing
(`attribution.isSpecificNeedle`): at least two lines, or one line of at least
12 non-whitespace characters that is not punctuation-only. A single `}`,
`});`, `return;` or `import os` occurs in half the hunks of a repo, and
matching on one credits a turn with code it never wrote.

- `Edit`: the needle is `new_string` **minus the context it repeats from
  `old_string`**. An `Edit` almost always quotes unchanged neighbours to be
  unambiguous, while `-U0` shows only what changed, so comparing `new_string`
  whole would fail on the commonest edit there is (insert a line, keep its
  neighbours). An edit that only *deleted* lines has no added evidence and is
  matched against the hunks' removed lines instead.
- `Write`: if the staged blob's hash equals the hash of `content`
  (`blob <len>\0` + bytes, sha1 - the same object id `git hash-object` gives),
  every hunk in the file belongs to that turn, no line matching needed.
  Otherwise - a file written and then edited again - the fallback asks whether
  a hunk's added lines are **all inside the content it wrote**
  (hunk ⊆ content, never content ⊆ hunk: a whole file's text is never a subset
  of one `-U0` hunk, so the other direction matched a Write's own hunks
  essentially never). A hunk mixing its lines with someone else's later ones
  stays unmatched, which is the honest answer.
- `apply_patch`: the patch is parsed into per-file hunks (`*** Update File:`,
  `*** Add File:`, `*** Delete File:`, `*** Move to:`) and its added lines are
  compared directly. A `Move to:` attributes the new path and marks the old one
  changed. A patch entry with no lines at all - a `*** Delete File:`, or the
  old side of a move - attributes at **file level** with
  `confidence: "patch"`: `git diff --cached` has no added lines to match for a
  path that is being deleted, and without this an `apply_patch` that removed a
  file looked like nobody's work.
- Unmatched hunks stay **unattributed** and are reported (one dim stderr line
  from `pre-commit`, and `promptlog trailers --json` carries the counts). That
  is the honest outcome for a hand edit. A file that tier B accounted for is
  not counted as unattributed - "without tier B or C evidence" is exactly what
  the unattributed number means.

Evidence is computed against the index, which only exists before the commit, so
`pre-commit` leaves it in `$GIT_DIR/promptlog-attribution` for `post-commit`,
which is the first hook that knows the sha. A stale file (older than a minute)
is discarded, and a missing one degrades to `role: "unknown"` with no files -
never to a guess.

#### The active turn

The **active turn** is the last turn of the session identified from an env var
(`resolveSession`'s `how` starts with `env:`). The agent injected that session
id into promptlog's own environment, so the commit is being issued from inside
that turn by definition, and it is linked whatever the clock says. Its
`durationS` is derived from the last record written to the transcript *so far*,
which is already in the past by the time the commit lands, so a window would
lose it on every commit after the first.

**"The agent has not written any text yet" is not a usable signal for this.**
Agents narrate between tool calls, so the parser's `responsePending` is false
for most of a turn's life. It stays in the parser, where it still means what it
says (a turn with zero assistant text), but selection and the stored pending
flag are derived from active-ness instead.

Slash commands are excluded, active turn included: a turn with `isCommand` is a
control gesture (`/model`, `/promptlog`), not a prompt about the code, and
never carries a `Prompt-Id`.

The relevance filter (a turn whose files all live in another checkout) and the
window still govern the **recording** path - `promptlog sync` and `review`,
which answer "what did I ask in this stretch of time" with no commit to match
against - and `promptlog trailers` when nothing is staged. `git.selectTurns`
and `repo.relevantTurns` serve that path only.

On `git commit --amend`, previousCommitTime is the committer date of
**`HEAD^`**, not of `HEAD`: `HEAD` is the commit being replaced, so its own
date makes the window empty and the amended commit would silently lose every
trailer. The trailers of the amended message *and* of `HEAD` itself are kept
(`--amend -m` replaces the message, so they are not in the message file), and
any newly selected turns are added on top.

Detecting an amend takes three signals, because no single one covers it:

1. `prepare-commit-msg` receives source `commit` with the **literal string
   `HEAD`** for `--amend`, while `-C <commit>` / `-c <commit>` pass the ref the
   user named. That is the only thing separating those two cases, and `-C` must
   be left alone (it reuses another commit's message and trailers verbatim).
2. `PROMPTLOG_GIT_CMD`, the git command line, which the dispatcher captures
   from its parent process (`ps -o args= -p $PPID`). This is the only signal
   that catches `git commit --amend -m msg`, which reports source `message`
   with no sha, indistinguishable from a plain `commit -m`. Advisory: an empty
   value means "not an amend".
3. `GIT_REFLOG_ACTION` — correct when present, but git does **not** set it for
   `git commit`, only for rebase/merge driven commits.

`pre-commit` gets no arguments at all, so there only (2) and (3) apply.

Candidate transcripts are bounded by mtime before they are opened: only files
touched since previousCommitTime minus one hour can hold a turn in the window,
and session metadata is read from the first 64 KB of a file rather than by
loading it whole.

### Hooks

Installed to `~/.promptlog/hooks/` by `promptlog init --global`, which points
`git config --global core.hooksPath` at that directory. Every hook file is a
tiny generated **Node script** (`#!/usr/bin/env node`, marker comment
`promptlog git hook dispatcher`) that splices `dispatch <name> --chain-dir
<baked dir>` onto its own `process.argv` and `require()`s the bundled
`promptlog.js` at its baked absolute path - no `sh`, `bash`, `ps`, or any
other POSIX-only tool anywhere in the hook file itself, so hooks run wherever
Node and git run, **including Git for Windows**, which invokes a hook file
through its shebang line the same way POSIX does. `promptlog dispatch <name>`
(`src/core/commands/dispatch.ts`) is the actual logic, a one-for-one Node port
of what used to be a shell script (removed): (1) runs
promptlog's logic only if `git config --get promptlog.enabled` is `true` in
this repo, (2) then chains to the repo's own `.git/hooks/<name>` if
executable, then to `.husky/<name>`, `lefthook` (if `lefthook.yml` exists, run
`lefthook run <name>`), and `.pre-commit-config.yaml` (`pre-commit hook-impl`
is complex; instead run `.git/hooks/<name>.legacy` if present, which
pre-commit creates). Exit status is the chained hook's status; promptlog's own
failures never block. `promptlog init` (no `--global`) installs the same hook
files into `.git/hooks/` of the current repo, renaming an existing hook to
`<name>.legacy` and chaining to it.

**`core.hooksPath` already in use.** promptlog writes hooks into exactly two
places, `$GIT_DIR/hooks` and `~/.promptlog/hooks`, never into a hook manager's
directory. But when `core.hooksPath` already points elsewhere (husky's
`.husky/_`, lefthook, a hand-rolled directory; at any config scope) git ignores
`$GIT_DIR/hooks` entirely, so a plain per-repo install would be a silent no-op,
and a global install that simply overwrote `core.hooksPath` would silence that
manager. So `init` takes `core.hooksPath` over and bakes the previous
directory into the hook file as the `--chain-dir` argument to `dispatch` (a
second baked value next to the `require()` path): per-repo `init` installs
into `$GIT_DIR/hooks`, sets `--local core.hooksPath` to that absolute path and
chains to the previous directory; `init --global` installs into
`~/.promptlog/hooks`, sets the global `core.hooksPath` and chains to the
previous global value (a relative global value is chained as written, with a
warning - it is meaningless across repos). The previous directory is never
renamed, deleted or written to. When the effective directory already holds our
hook files (a global install), a per-repo `init` installs nothing - those
files already chain `.git/hooks/<name>` - and only enables the repo. Both
paths are idempotent: re-running `init` overwrites our own hook files and
leaves the chain intact. `dispatch` chains `--chain-dir/<name>` once, by
canonical path, never when it is itself or the `.git/hooks/<name>` it already
chained, and counts it as the "own" hook so lefthook is still run at most
once.

`dispatch` reads stdin **only for hooks that are defined to receive it**
(`post-rewrite` and friends); everything else never touches it. Reading stdin
unconditionally makes the hook wait for the writer of any inherited stdin, so
`sleep 20 | git commit -m x` would hang for twenty seconds.

Three rules keep the chaining honest:

- **Never chain to yourself.** With a per-repo install the hook file *is*
  `.git/hooks/<name>`, and git may invoke it by a relative path (and
  `core.hooksPath` may itself be relative), so the comparison is between
  canonical (symlink-resolved) paths, never raw strings. Belt and braces:
  `dispatch` exports an incrementing `PROMPTLOG_DISPATCH_DEPTH` and returns
  immediately when it is already >= 1, which also bounds re-entry through a
  chained hook or through promptlog's own `--amend`. The depth guard
  suppresses promptlog's own work only — chaining always happens, at any
  depth, or a nested git call would silently skip the user's hooks.
- **Rotate, never delete, an existing hook.** A pre-existing hook that is not
  ours moves to the first free `<name>.legacy`, `<name>.legacy.1`, … slot and
  every one of them is chained in order. Re-running `init` after the user
  installed husky must not destroy husky's hook. Our own hook file (matched by
  its `promptlog git hook dispatcher` marker - both the current Node comment
  and the old shell comment, so an un-reinitialized repo still rotates
  correctly) is simply overwritten.
- **Run lefthook at most once.** lefthook installs its own
  `.git/hooks/<name>`; when that file was already chained as `<name>` or
  `<name>.legacy`, `lefthook run <name>` is skipped, or every lefthook command
  fires twice.
- **Run husky at most once.** husky v9 sets `core.hooksPath` to `.husky/_`,
  whose shim already runs `.husky/<name>`. When `--chain-dir` resolves to a
  directory inside `$top/.husky`, the direct `.husky/<name>` chain is
  skipped, or husky's hook would run twice per commit.

**Missing baked path.** If the `promptlog.js` path baked into a hook file is
moved or deleted (uninstall, a relocated checkout), the hook file checks
`fs.existsSync()` on it before ever calling `require()`: when it is gone, it
falls back to `promptlog` on PATH (`spawnSync('promptlog', ['dispatch', ...],
{ stdio: 'inherit' })`), and the commit's exit status is whatever that run
reports. Only when PATH has no `promptlog` either does it give up - one
`promptlog: hook skipped, <path> is missing; run \`promptlog init\` again`
line on stderr, exit 0 - so the commit always goes through. The trade-off in
that last case: any chained third-party hook (husky, lefthook, a previous
core.hooksPath) is skipped along with promptlog's own work, since `dispatch`
- which does the chaining - never got to run. `promptlog doctor` checks every
installed hook file (this repo's effective hooks dir, and the global
`~/.promptlog/hooks`) and warns when its baked path is missing, so the fix
(`promptlog init` again) is visible before it is needed.

Four hooks are installed: `pre-commit`, `prepare-commit-msg`, `post-commit`,
`post-rewrite`. In detail: `pre-commit` (select turns, redact, upsert session doc,
regenerate index and README, `git add .promptlog`, and leave the gid list in
`$GIT_DIR/promptlog-pending`), `prepare-commit-msg` (append trailers to the
message file unless it already has them or the commit is a merge/squash/amend
with `-C`; reuses the pending gids, and redoes the whole `pre-commit` job when
that hook was bypassed with `--no-verify` or is not installed), `post-commit` (write HEAD's sha into the records that carry
`Prompt-Id` trailers of HEAD, regenerate index, amend `.promptlog` into the
commit ONLY if the tree changed and `promptlog.amend` is true, default false:
otherwise the sha lands in the next commit, which is acceptable and documented;
when it does amend, the old->new sha is remapped in-process, because
`post-rewrite` for our own nested git call is suppressed by the depth guard),
`post-rewrite` (map old->new shas from stdin across all session docs and the
index). Every hook: hard watchdog timeout (`timeout` via child process kill;
platform-aware, see "One budget for the whole commit" below), fail-open,
one-line stderr warning on error, never touches the network.

`pre-commit` exists because **`git add` from `prepare-commit-msg` does not
affect the commit**: git has already read the index by the time that hook runs,
so the records stage but land only in the *next* commit. `pre-commit` is the
last stage at which staging still counts, which is what "the records land in
the same commit" requires. The cost is that `git commit --no-verify` skips it —
hence prepare-commit-msg's fallback above, which still writes the records and
the trailers, and then `promptlog.amend` (or the next commit) picks up the sha.

#### What a commit stages

`pre-commit` stages `.promptlog/` - the records it just wrote, which have to
land in this commit. It stages `.gitattributes` **only when this run changed
it** (the content is compared before and after the write): the file is the
user's, and blindly adding it smuggles their own unstaged edits to it into a
commit they did not ask to include it in.

#### One budget for the whole commit

Three hooks x 2 s each would add six seconds to a commit. Instead `pre-commit`
writes `$GIT_DIR/promptlog-deadline` (epoch ms + `HOOK_BUDGET_MS`) and the
later hooks read it and use only the remainder; `post-commit` and
`post-rewrite` remove it. Every child `git` process is given a timeout
clamped to that remainder, so a stuck child cannot outlive the budget either.
`HOOK_BUDGET_MS` is platform-aware: 2500 ms everywhere except Windows, where
every git spawn costs several hundred ms more and 2500 ms was routinely gone
by `post-commit` - silently skipping `promptlog.amend`'s amend step - so
Windows gets 6000 ms. The dispatcher's own watchdog stays as the outer guard,
and is always `HOOK_BUDGET_MS` plus a margin so it cannot fire before the
budget it wraps does.

#### Commits promptlog stays out of

- **Merges.** When `MERGE_HEAD` exists, `pre-commit` writes nothing and no
  trailers are added: a merge is not prompt work.
- **Pathspec / partial commits** (`git commit -- <path>`). These build a
  *temporary* index (`$GIT_DIR/next-index-<pid>.lock`), which `GIT_INDEX_FILE`
  points at instead of `$GIT_DIR/index`. Anything we stage goes to the real
  index, so it would miss the commit *and* be left dirty afterwards.
  `$GIT_DIR/index.lock` is **not** such a case even though it is not
  `$GIT_DIR/index`: that is what `git commit -a` (and any commit that has to
  write the index) uses, and git renames it into place, so what we add there
  lands in this very commit - treating it as partial cost every
  `git commit -am` its trailers and its records. Both `pre-commit` and
  `prepare-commit-msg` test for this and return immediately - the latter
  before it consults the pending gid list, since its "redo the work if
  pre-commit was bypassed" fallback would otherwise write and stage records
  that this commit cannot carry.
- **`-C` / `-c <commit>`** message reuse (`source` "commit" with a sha and no
  `amend` in `GIT_REFLOG_ACTION`): the message and its trailers belong to
  another commit.

#### Aborted commits

If the user aborts (`GIT_EDITOR=false`, an empty message), `pre-commit` has
already written and staged records that no commit references, and `post-commit`
never runs. Those records are *not* rolled back — instead the next
`pre-commit`/`prepare-commit-msg` adopts every record that carries no sha at
all and gives it this commit's trailer. Nothing is lost, and nothing is
duplicated, because the records are keyed by global prompt id. The same
adoption picks up records written by `promptlog sync`.

#### Hook state files

All under `$GIT_DIR`: `promptlog-deadline` (shared budget),
`promptlog-pending` (the gid list `pre-commit` computed, keyed to the HEAD sha
it was computed against and ignored if HEAD has moved or it is over 60 s old —
otherwise a later `--no-verify` commit would inherit another commit's gids),
and `promptlog.lock` (an `O_EXCL` lock held across store mutations, broken if
older than 10 s).

### Notes mirror (optional)

With `config.notes: true`, `post-commit` also runs
`git notes --ref=promptlog add -f -m '<json of gids>' HEAD` and `init` sets
`notes.rewriteRef=refs/notes/promptlog` and adds the push/fetch refspec
`+refs/notes/promptlog:refs/notes/promptlog` to `origin` if present.

## CLI (single command, subcommands)

```
promptlog                          # tree of the current session (default)
promptlog tree [-n N] [-v] [--reverse] [--responses]
promptlog last [N|all] [--responses]    # replaces the old --last / /lastprompt
promptlog show <gid|shortId|sha>        # one prompt with metrics, source label, linked commits; a sha shows all prompts of that commit
promptlog grep <regex>                  # search prompts (transcript first, then repo)
promptlog files <path>                  # prompts that touched a file
promptlog sessions                      # replaces --all
promptlog mermaid [--raw]
promptlog html <file|->   promptlog fragment <file|->
promptlog json
promptlog env                           # what was detected (agent, session, transcript, repo, hooks)
promptlog init [--global] [--notes]     # create .promptlog, config, gitattributes, hooks; sets promptlog.enabled=true
promptlog enable | disable              # flip promptlog.enabled for this repo
promptlog sync [--all] [--session X]    # write records for turns since last commit (or all) without committing
promptlog trailers                      # print Prompt-Id lines for the current window (for agents/tools that bypass hooks)
promptlog reindex                       # rebuild index.jsonl and README.md from session docs + git log trailers
promptlog review                        # show what sync/commit WOULD write: redacted text with findings highlighted
promptlog hook <name>                   # entry point used by the dispatchers
                                        # (pre-commit, prepare-commit-msg,
                                        #  post-commit, post-rewrite)
```

Global flags: `--agent claude|codex|auto`, `--session`, `--no-color`, `--json`
where meaningful. `bin/promptlog.js` swallows `EPIPE` on stdout and stderr and
exits 0, so `promptlog show <sha> | head` is not a crash. Old flags `--last`, `--all`, `--mermaid`, `--html`,
`--fragment` keep working as hidden aliases for one release.

## Agent surfaces

One skill, `skills/promptlog/SKILL.md`, installed to
`~/.claude/skills/promptlog`, `~/.codex/skills/promptlog`,
`~/.cursor/skills/promptlog`, and whatever skill directory any other
agentskills.io host reads (via `npx skills add` or a plain copy). Claude Code
exposes it as `/promptlog [args]` (arguments arrive via `$ARGUMENTS`), Codex as
`$promptlog` or by natural-language trigger, Cursor and the rest by
natural-language trigger. It contains: the command table,
the visual decision list (Codex desktop with `visualize` skill -> fragment +
`visualize{...}` reference; Claude Code with Artifact tool -> fragment +
Artifact; markdown-only -> mermaid; terminal -> ASCII), the commit paragraph
(if `promptlog env` says hooks are not installed but the repo is enabled, run
`promptlog trailers` and include the output in the commit message), the
verbatim rule, the do-not-act rule, and the zero-prompts rule.

No `commands/` or `prompts/` files: a same-named command shadows the skill in
Claude Code (observed 2026-09-02), and Codex prompts add nothing over the
skill.

**Host-specific constructs.** The skill is one file for every host, and the
rule is: everything in it must work on every host; anything host-specific is
isolated and called out loudly. The only host-specific construct is the
Claude Code pre-run block, under its own "Claude Code only" sub-heading,
which uses `${CLAUDE_SKILL_DIR}` (the directory holding SKILL.md),
`$ARGUMENTS`, and a `` !`cmd` `` preamble — Claude Code expands all three
while loading the skill; Codex, Cursor, and any other host print them
literally and are told to ignore that sub-section. Every host otherwise
dispatches the same way: `skill-entry <the words the user typed after the
skill name> --no-color --fenced`, which is a plain passthrough with
arguments and a compact tree without. The runtime is the bundled
`scripts/promptlog.js` next to SKILL.md, run with `node`; a `promptlog`
binary on PATH is the same program and only a fallback. Frontmatter is
restricted to the six agentskills.io keys (`name`, `description`, `license`,
`compatibility` as a string, `metadata` as string→string, `allowed-tools`) -
anything else fails packaging on hosts that validate - and is enforced by
`scripts/check-skill.mjs` (run from `pretest` and `prepublishOnly`). The
skill's own `version` therefore lives at `metadata.version`, and every
reader (`src/core/version.ts`, `updateCheck.js`'s GitHub fallback,
`commands/skill.js`'s `skillVersion`, `scripts/bump-version.mjs`) matches
the indented `version:` line, still accepting the pre-0.4 bare form.

**Visual rule** (the authoritative copy lives in SKILL.md - keep both in
sync): one layout for every host. `promptlog graph --fenced` (the skill's
default, and what `skill-entry` with no args now runs) always renders the
ASCII tree, wrapped in a `text` fence when `--fenced` is passed so a
prompt's own text is never re-interpreted as Markdown by whatever renders
the reply. Mermaid (`promptlog mermaid`, or `graph --format mermaid`) is
explicit-only, run only when the user actually asks for a Mermaid diagram -
its gitGraph rendered badly in the Codex desktop app when it was
auto-selected there (overlapping tags, no prompt text, id list mangled by
Markdown), so `graph --format auto` always means ASCII now regardless of
host; the skill never judges the host and there is no terminal-vs-desktop
branch left to get wrong. Each adapter still implements a `ui({session,
env}) -> 'terminal' | 'desktop' | 'unknown'` contract method (Codex reads
`session.meta.originator` off `session_meta.payload.originator` in the
transcript - `codex-tui`/`codex_exec` -> terminal, `Codex Desktop`/
`codex_work_desktop` -> desktop; Claude reads `env.CLAUDE_CODE_ENTRYPOINT`,
`'cli'` -> terminal; Cursor has no signal yet) and it surfaces on `promptlog
env`'s `ui:` line - useful, cheap to keep - but nothing in `graph` depends on
it any more. An HTML fragment, Artifact, or `visualize` call is produced only
when the user explicitly asks for something interactive, visual, HTML, or
shareable - never unprompted.

**Published-version update check** (`src/core/updateCheck.ts`, wired from
`src/core/cli.ts`'s `finish()`): the sole exception to "promptlog never
makes a network call", and deliberately narrow. Runs only for the
interactive view commands `tree`, `graph`, `last`, `skill-entry` (which
resolves to one of the others before dispatch, so it is covered for free),
`status`, `doctor`, and `sessions` - never for `hook`, `statusline`,
`trailers`, `sync`, `review`, `init`, `merge-driver`, or any other repo
command. At most once per 24h, tracked in `~/.promptlog/update-check.json`
(`{checkedAt, latest, source}`); a fresh cache makes zero network calls. A
stale cache is claimed before any request goes out - the file is rewritten
as `{checkedAt: now, latest: <previous latest or null>, source: <previous>,
pending: true}` first, then fetched, then rewritten with the final result
(no `pending`) - so a concurrent run that sees the fresh `checkedAt` uses
the cached `latest` and makes no request: at most one fetch per 24h per
home directory, barring a write race in the same millisecond. Both writes
are best-effort. A stale cache makes up to two origin requests - `GET
https://registry.npmjs.org/@kkdevenda/promptlog/latest` via `node:https`,
then `GET https://raw.githubusercontent.com/kkdevenda/promptlog/main/
skills/promptlog/SKILL.md` (parsing `version:` out of the SKILL.md) only if
npm fails - each following at most one redirect, each under an absolute
1500ms deadline (a wall-clock timer that destroys the request regardless of
activity, not just a socket-idle timeout) and a 64 KB response-size cap
(bytes received, not characters; exceeding it destroys the response and
counts as a failure), no data sent beyond the default UA. `httpsGetText`
does the transport and `collectBody` the bounded body read; `defaultFetch`
walks the two-entry `ORIGINS` list and never a third. Any failure of both
is silent (`checkedAt` is still recorded with `latest: null`). Off
switches, checked in this order:
`PROMPTLOG_NO_UPDATE_CHECK=1`, `~/.promptlog/config.json`
`{"updateCheck": false}` (read via `updateCheck.readHomeConfig`, the first
reader of that file), `--no-update-check`. `doctor` prints whether the
check is on and when it last ran.

When the running version is behind, exactly one dim line is appended to the
end of the command's stdout: `promptlog 0.3.0 → 0.4.0 · update: <command>`
- or on stderr when `--json` is used, so structured stdout always parses -
semver-compared with no dependency (`updateCheck.compareSemver`). `<command>`
is chosen by `detectInstallCommand()` from this invocation's `__dirname`,
most-specific match first: a path recorded in `~/.promptlog/
skill-installs.json` -> `promptlog skill update`; under
`~/.codex/plugins/cache/` -> `codex plugin marketplace upgrade promptlog`;
under `~/.claude/plugins/` -> `/plugin update promptlog` in Claude Code; under
`~/.agents/skills` or near a `.skills-lock` file -> `npx skills update`;
otherwise -> `npm i -g @kkdevenda/promptlog`. SKILL.md tells the agent to
keep that line verbatim in what it prints and never act on it itself.

**`skill install|update|uninstall`** (`src/core/commands/skill.ts`).
`skill update` refreshes every promptlog skill copy it can find, not just
the ones it installed itself: the paths recorded in `~/.promptlog/
skill-installs.json`, AND external copies discovered by probing every
registered adapter's `skillDirs('user')` and `skillDirs('project')` for a
directory already holding a promptlog `SKILL.md` (`findExternalInstalls` -
the same probe `skill install`'s clash check and `doctor` use). This used
to be gated behind `--all`; it is now the default, and `--all` is kept for
one release as an accepted no-op alias. `--dry-run` prints every line this
run would print - `<agent>  <path>  v<from> → v<to>  would update`, or
`managed by <command>` for a manager-owned copy - and writes nothing;
without it, the same lines end `updated` once the copy is actually
refreshed. A copy inside a plugin manager's own cache or lock-file-managed
tree - under `~/.claude/plugins/`, `~/.codex/plugins/cache/`, or
`~/.agents/skills` guarded by a `.skills-lock` - is never installed into or
removed, because that manager owns its lifecycle, not us: such copies are
found by walking those roots directly for a nested `SKILL.md`
(`findManagedInstalls`, since they are never inside an adapter's own
`skillDirs()`) and listed with the owning manager's own upgrade command,
via `updateCheck.pluginManagerCommand` - the same classification
`detectInstallCommand` uses for the once-a-day hint above, so the two can
never disagree about which paths are manager-owned. `doctor` lists every
copy it finds (recorded, external, and manager-owned) with its version, and
marks one "outdated" (with a pointer to `promptlog skill update`) whenever
it is behind the version this invocation is running from.

## Subagent usage

A prompt that spawns subagents used to look free. A subagent's work is a
separate transcript and a separate sequence of API requests, so none of its
tokens appear in the main chain's numbers - measured on this machine, the
live session's main chain accounts for ↑268.5k while its 31 subagent
transcripts account for a further ↑84.2k, none of it visible anywhere before
this change.

### The rule

**Rows show OWN usage; headline totals show OWN + SUBAGENTS and say so.**
A turn's own token fields are never touched. `Turn.subagents` is a separate
block - `{count, output, input, cacheRead, cacheWrite, thinking, linkage}`,
all zeros and `linkage: null` when there are none - and `Session` carries
`subagentsUnattributed` (same shape, for children that belong to the session
but to no single turn), `subagentFiles` (how many transcripts were read) and
`subagentDuplicateIds`. `toJSON()` includes all of it, and
`store.buildRecord` writes the per-turn block next to `tokens`, never inside
it.

Renderers, all going through `core/subagents.js` `totalsWithSubagents()` so
they cannot disagree. "output" (every ↑ and every `out`-named JSON field:
`out`, `ownOut`, `subagentOut`) means output + thinking tokens, in rows and
totals alike, for own and subagent usage alike:

| Surface | Own | Own + subagents |
|---|---|---|
| tree/graph row | the ↑/↓ columns, plus a dim `⁺` after ↓ (normal) or a dim ` +N agents ↑x ↓y` after the tool column (`-v`) | — |
| tree header | — | `↑x ↓y (+N agents)` |
| totals row | `own …` line | `subagents (N) …` and `total …` lines; one line as before when N is 0 |
| `status` / `statusline` | `ownOut`/`ownIn` in `--json` | the ↑/↓ on the line, plus ` · +N agents`; `out`/`in`/`subagentOut`/`subagentIn` in `--json` |
| `last` / `show` | the metrics line | ` · +N agents ↑x ↓y` appended |
| `--html` card / header | the card's ↑/↓, plus a muted ` +N agents ↑x ↓y` in the card head | header `↑x ↓y (+N agents)` |
| `--mermaid` commit / header | the commit tag's ↑/↓, plus ` +N agents ↑x ↓y` in the tag | a `%% session … ↑x ↓y (+N agents)` comment line at the top of the gitGraph |

### Adapter contract

`children(session, {home}) -> {children: [{path, agentId, parentAgentId,
spawnedByTurnId, spawnedByTurnGid, linkage, usage}], duplicates}`. Core does
the arithmetic; only the adapter knows where the files are. Each child
transcript appears **exactly once** regardless of nesting depth.
`spawnedByTurnId` is the top-level `Turn.fullId` and is the key core links
on; `spawnedByTurnGid` is the same turn's gid, carried for display only - a
gid embeds a 7-char id prefix, so two turns whose uuids share that prefix
have the same gid and linking on it credits the later one. An adapter that
provides only `spawnedByTurnGid` (legacy) is matched by gid only when that gid
names exactly one turn of the session; otherwise the child is unattributed.
A child that cannot be tied to a turn gets `spawnedByTurnId: null` and lands
in the session bucket - it is never assigned to the nearest turn as a guess.
`attachSubagents` resets every subagent field before attaching, so it is
idempotent. `capabilities.subagents` says whether the method returns real
data.

`usage` must be the transcript's OWN usage and must not already be inside the
parent's numbers. That is a per-agent question with a per-agent answer, and
it has to be **verified before anything is added**, because adding an amount
that is already counted is exactly the inflation this section exists to
prevent.

**Claude.** Transcripts live at
`<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`, next to the session
file, with an `agent-<agentId>.meta.json` sidecar carrying the `toolUseId` of
the `Agent` call that spawned the agent (and `parentAgentId` for a nested
one). That directory is the only place read: Claude Code also leaves copies
under a per-task scratch directory (`/private/tmp/.../tasks/…`), and reading
those would count the same agent twice.

Linkage is `exact` and comes from ids, in this order: the sidecar's
`toolUseId`; failing that, the `agentId: X` text in the `Agent` tool_result
(which carries the `tool_use_id` it answers) or the `<task-id>` /
`<tool-use-id>` pair in a background agent's `queue-operation` task
notification. `parseClaudeSession` records `tool_use id -> owning turn` on
`session.meta.toolUseOwners` as it parses, so no second parent walk is
needed. A nested agent climbs to its parent - by the sidecar's
`parentAgentId`, or by finding the `tool_use` id inside the parent's own
transcript - and is attributed to the **same top-level turn** as its parent
chain, still `exact`, and never counted under two nodes. Measured on the
live session: 31 of 31 transcripts resolve `exact`, including two nested
ones. Usage is summed with exactly the parser's own rules (compaction
markers dropped, `extractUsage` per assistant message, one count per
`message.id`), deduped **within** each file and **across** every file of the
session including the main chain; cross-file repeats are counted once and
reported in `subagentDuplicateIds` - 12 of them on the live session, so this
is a real safety net rather than a theoretical one. The main-chain seed of
that dedup set applies the parser's own sidechain rule (`isSidechain`
records skipped): Claude Code sometimes echoes a child's messages into the
main file as sidechain records, which the parser counts in no turn, and
seeding from them would mark the child's own copies duplicate and drop them
from every total.

**Codex.** A spawned thread is a rollout of its own whose
`session_meta.payload.parent_thread_id` names its parent, so children are
found by scanning the rollout tree transitively (112 children locally). The
parent rarely mentions the child's id at all (3 of 30), so linkage is
`time`: the child is attributed to the turn whose window
`[ts, ts + durationS]` contains its `session_meta` timestamp. There is no
open-ended last window - a child outside every window is unattributed, which
still counts in the session's totals and simply credits no row.

*Are a child's tokens already in the parent's?* **No, and this was measured
before any arithmetic was added.** A Codex turn's usage is the delta of the
parent's cumulative `token_count.total_token_usage`. For five real
parent/child pairs, that delta over the turn the child ran in, against the
sum of the parent's OWN per-request `last_token_usage` entries in the same
window, and against the child's own total:

| # | parent turn Δcumulative | parent turn Σ own requests | child own total | Δ − Σown |
|---|---|---|---|---|
| 1 | 3,494,634 | 3,494,634 | 455,402 | 0 |
| 2 | 3,494,634 | 3,494,634 | 279,030 | 0 |
| 3 | 3,878,759 | 3,890,599 | 808,362 | −11,840 |
| 4 | 3,878,759 | 3,890,599 | 592,285 | −11,840 |
| 5 | 710,939 | 710,939 | 177,263 | 0 |

The parent's delta is fully accounted for by the parent's own requests: the
residual is zero or slightly negative (a `total_tokens` rounding quirk in
Codex's own accounting - the `input`/`output`/`reasoning` fields match
exactly in all five), and nowhere near the child's 177k-808k. Across all 75
local parents that have children, the cumulative total never exceeds the sum
of the parent's own per-request usage. So a child's usage appears nowhere in
the parent's, and Codex children are **added**, with `linkage: 'time'`. Had
the deltas contained the children, the outcome would have been the opposite:
expose them with `includedInParent: true`, exclude them from headline
totals, and say "(already counted in parent)" in `-v`.

**Cursor.** `agent-transcripts/<uuid>/subagents/*.jsonl` exist but every
token field in them is zero. They are listed as children with zero usage and
no arithmetic is done on them. Listing the files is truthful; inventing
numbers for them would not be.

### Invariants (test/subagents.test.ts)

Every total is provable, not plausible:

- **Conservation.** For a synthetic Claude session with two top-level agents,
  one nested grandchild and one background agent linked only by a task
  notification: sum over turns of (own + subagents) + `subagentsUnattributed`
  == the deduped usage over ALL files (main + every subagent file), asserted
  as exact equality on every token field.
- **Once.** Sum of `turn.subagents.count` across turns + the unattributed
  count == `subagentFiles`.
- A message id duplicated across two files is not counted twice, and the
  duplicate is reported.
- A child's message echoed into the main chain as `isSidechain: true` with
  the same `message.id` is counted once, on the child's spawning turn, with
  zero duplicates reported - not dropped (reproduced: own 3, subagent 0,
  duplicates 1 for a child with 17 output tokens, before the fix).
- Two top-level prompts whose uuids share the first 7 characters have the
  same gid; a child exactly owned by the first attaches to the first, never
  to the later turn with the colliding gid. A legacy adapter giving only a
  gid is honoured when that gid is unique and left unattributed when it is
  not.
- `attachSubagents` called twice yields exactly what calling it once does.
- Every adapter's `children()` entries carry `spawnedByTurnId` (a `fullId` of
  the session or null) and a `spawnedByTurnGid` that agrees with it.
- A copy under a `tasks/` directory, or anywhere but `<session
  dir>/subagents`, is never read.
- No subagents directory -> all zero, no error; an empty one -> the same.
- A turn's own token fields are byte-identical with and without subagents
  attached.
- Codex: a child inside a turn window links by time; outside every window it
  is unattributed; its usage is added, not folded.
- Renderers: `(+N agents)` in the header and the three-line totals block
  appear only when N > 0; the status suffix and the JSON fields are present.
- **Real-data check** (run, not a unit test - the numbers grow): on the live
  session, promptlog's header total and a completely independent walk of the
  same snapshot agree to the token - ↑352,790 ↓305,497,409 over 32
  transcripts, with 12 cross-file duplicate message ids and 31 of 31 children
  attributed.

`attachSubagents` fails open: a missing directory, an unreadable file or a
throwing adapter leaves the zero values in place. A missing number is
reported as zero, never guessed.

## Testing bar

- `npm test` green. Runs typecheck (tsc), lint (biome), build (esbuild),
  skill validation, and vitest suite.
- Unit: redaction (each layer, determinism, allow/deny), store upsert
  semantics, index regeneration, trailer parse/format, window selection,
  resolve() three outcomes, response extraction for both agents, compaction
  fixture, session identification from env vars, `--agent <id>` narrowing to
  that agent alone.
- Attribution (`test/attribution.test.ts`): a temp repo with two synthetic
  sessions - Claude editing file1/file3 by `Edit` and file5 by `sed -i`, Codex
  editing file2/file3 by `apply_patch` - plus a hand-edited file4. Asserts:
  agent commits -> that turn is `both`, the other is `contributor`, the shared
  file's two hunks go one to each, file5 is `confidence: "shell"` with
  `matched: 0`, file4 is unattributed; human commits -> both contributors, no
  committer; two commits in one turn -> one record, two commit entries with
  their own per-file evidence. Plus `edits()` for both adapters against
  redacted fixtures of the real payload shapes, the V4A patch parser, the shell
  parser, and `reindex` rebuilding entries from a squash-style body.
- Integration (`test/integration.test.ts`): create a temp git repo, point HOME
  at a temp dir with a synthetic Claude transcript whose cwd is the repo, set
  `CLAUDE_CODE_SESSION_ID`, run `promptlog init`, make a commit through `git
  commit` and assert: trailers present, session doc written and staged in the
  same commit, index has the line, README contains `gitGraph`, `promptlog show
  <sha>` prints the prompt, second commit in the same turn appends a sha to the
  same record (no duplicate), `git commit --amend` triggers post-rewrite remap,
  a chained legacy hook runs exactly once (also with a *relative*
  `core.hooksPath`, and with `PROMPTLOG_DISPATCH_DEPTH` already set), slash
  commands and other-directory turns are absent from the trailers, and a
  failing promptlog (simulate by unreadable transcript) does not block the
  commit.
- Subagents (`test/subagents.test.ts`): the conservation and once-only
  invariants above, plus the renderer and record assertions. See "Subagent
  usage".
- Smoke: every transcript on this machine parses (`scripts/smoke.sh`).

## Non-goals for v0.2

Line-level attribution, signing, hosted anything, capturing images or pasted
bytes (hash only), redaction by a model.
