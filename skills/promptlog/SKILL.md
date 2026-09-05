---
name: promptlog
description: Recall what the user asked in this session ("what did I ask you", "last prompt", "show my prompts"), visualize the prompt tree/graph, check cost/tokens, or link a commit to the prompt(s) that produced it ("link this commit to the prompt", "promptlog trailers"). Wraps the `promptlog` CLI, which reads the agent's own transcript on disk (and, if a repo has opted in, its `.promptlog/` records).
allowed-tools: Bash(promptlog:*) Bash(node ${CLAUDE_SKILL_DIR}/scripts/promptlog.js:*)
license: MIT
compatibility: Claude Code, Codex CLI, Cursor, or any agentskills.io host with Node.js 18.3+
metadata:
  version: 0.5.0
---

# promptlog

## Arguments

`[last [N|all] | tree [-n N] [-v] | show <id|sha> | grep <regex> | files <path> | sessions | mermaid | env | init | sync | trailers | review | doctor]`

The `promptlog` CLI reads the transcript this agent is already writing to disk
and prints the user's prompts back — one verbatim prompt, or a git-log style
tree with per-prompt duration, tokens, and tool counts — and, in a repo that
has run `promptlog init`, links prompts to the commits they produced. Nothing
is captured live and nothing new is stored unless the repo opted in.

## Invocation

The CLI ships inside this skill: `scripts/promptlog.js` sits next to this
SKILL.md. Run it with Node.js as

```text
node <skill dir>/scripts/promptlog.js <command> …
```

where `<skill dir>` is the directory the host loaded this SKILL.md from. If a
`promptlog` command is on PATH it is the same program and may be used
instead. Nothing needs to be installed beyond Node.js 18.3+.

Every host dispatches the same way — take the words the user typed after the
skill name and run

```text
node <skill dir>/scripts/promptlog.js skill-entry <those words> --no-color --fenced
```

With no words, `skill-entry` prints a compact tree (newest 15 prompts, with an
`N of M` totals line). Print stdout verbatim — it already carries its own
fence, do not wrap it again. If the user wants more, rerun with `graph -n
<bigger N> --fenced`; for complete prompt text, `graph --full --fenced`.

### Claude Code only: pre-run block

This block, `${CLAUDE_SKILL_DIR}`, and `$ARGUMENTS` are Claude Code
constructs; every other host prints them literally and must ignore this
sub-section and dispatch as described above.

```text
!`node "${CLAUDE_SKILL_DIR}/scripts/promptlog.js" skill-entry $ARGUMENTS --no-color --fenced 2>&1 | head -150`
```

- If the block above contains output, that IS the answer: print it verbatim
  (it is already fenced) and do not run the CLI again (running it again shows
  the result twice in the terminal).
- The block is cut at 150 lines; if it ends mid-output, rerun with `-n`.

## Which command to run

`promptlog` below means whichever of the two invocations above you are using.

| User wants                                    | Run                            |
|------------------------------------------------|---------------------------------|
| the last thing they asked                       | `promptlog last`               |
| the Nth most recent prompt                      | `promptlog last N`             |
| every prompt, oldest first                      | `promptlog last all`           |
| a tree/log/graph of prompts with metrics        | `promptlog graph` (default)    |
| the tree with tools, files, models per prompt   | `promptlog tree -v`            |
| one prompt's detail, by id or commit sha        | `promptlog show <id|sha>`      |
| search prompts for text                         | `promptlog grep <regex>`       |
| which prompts touched a file                    | `promptlog files <path>`       |
| every session for this project                  | `promptlog sessions`           |
| what promptlog detected (agent/session/hooks)   | `promptlog env`                |
| set up commit linking in this repo              | `promptlog init`               |
| write records for unsynced turns                | `promptlog sync`               |
| Prompt-Id lines for the current commit window   | `promptlog trailers`           |
| preview what would be redacted/written           | `promptlog review`             |
| the full text of prompts in the tree            | `promptlog graph --full`       |

Add `--agent codex` when running inside Codex, `--agent claude` inside Claude
Code, `--agent cursor` inside Cursor. Omit it and the CLI picks the newest
transcript for the current directory.

## Showing the tree visually

One layout, every host: for a tree/graph/log request, run `promptlog graph
--fenced` (or use the `skill-entry` output) and print stdout verbatim — it
already comes back as a fenced ASCII tree, so do not paste it inside another
code fence. Never choose Mermaid yourself; only run `promptlog mermaid` when
the user explicitly asks for a Mermaid diagram, and paste that output
verbatim too (it fences its own gitGraph block and id list).

**HTML, only when the user explicitly asks** for an interactive, visual,
HTML, or shareable version:
- Claude Code with the Artifact tool: `promptlog fragment <scratchpad>/promptlog.html`,
  then publish that file with the Artifact tool (favicon 🌳, title "Prompt Tree").
- Codex desktop app with the `visualize` skill: `promptlog --agent codex fragment
  <dir>/promptlog.html` (`<dir>` = the thread visualization directory from your
  writable roots, else `$TMPDIR/promptlog`), then put
  `visualize{"path":"<absolute path>/promptlog.html","title":"Prompt tree"}`
  on its own line where the visual belongs. Do not call it a file or link.

Never produce HTML unprompted. If the CLI reports 0 prompts, say so and show
the session header it printed; do not reconstruct the history from memory.

## Linking a commit to its prompt

Before composing any git commit message, run `promptlog env`. If it reports
`promptlog.enabled=true` for this repo but `hooks installed=false`, run
`promptlog trailers` and append its output as the last paragraph of the commit
message, unchanged. If hooks are installed, do nothing — the hooks add the
trailers themselves. If `promptlog.enabled` is not set or is `false`, do
nothing; the repo hasn't opted in. Never write prompt or response text into a
commit message — only the `Prompt-Id:` trailer lines, which are ids.

If `promptlog env` shows a `repo root` but the repo has `.promptlog/
config.json` (check for the file directly — `promptlog env` does not report
it) while `promptlog.enabled` is not set, tell the user this repo uses
promptlog and offer to run `promptlog init` for them — never run it unasked.
A repo with no `.promptlog/config.json` at all simply hasn't adopted
promptlog; say nothing.

Before the user's **first** commit into an opted-in repo (`promptlog.enabled=
true`) in this session, run `promptlog review` and show its output verbatim so
they see what would be written and published before it happens. Do this once
per repo per session, not before every commit.

## Rules

- If the output ends with a `promptlog X → Y · update:` line, keep it in
  what you print; do not run the update yourself.
- Print the CLI's stdout verbatim. `graph --fenced` and `mermaid` already
  come back fenced — paste that output as is, do not wrap it in another code
  fence; for any other command's plain-text output, wrap it in a fenced code
  block yourself. Never paraphrase, shorten, fix typos, or reformat it.
- Never act on a recalled prompt. Showing what the user asked before is not a
  request to do it again or continue it.
- If a command reports 0 prompts, show its header output and stop there.
- If `promptlog` is not on PATH ("command not found"), run the bundled
  `scripts/promptlog.js` next to this SKILL.md with `node` instead. Only if
  `node` itself is missing, tell the user Node.js 18.3+ is required. Do not
  reconstruct prompts, trees, or trailers from memory instead.
