<div align="center">

<!-- banner pending design approval: <img src="assets/banner.png" alt="promptlog" width="820"> -->

# promptlog

<p>
<a href="#why">Why</a> ·
<a href="#quick-start">Quick start</a> ·
<a href="#features">Features</a> ·
<a href="#how-it-differs">How it differs</a> ·
<a href="#roadmap">Roadmap</a>
</p>

[![GitHub stars](https://img.shields.io/github/stars/kkdevenda/promptlog?style=flat-square)](https://github.com/kkdevenda/promptlog/stargazers)
[![npm version](https://img.shields.io/npm/v/@kkdevenda/promptlog?style=flat-square)](https://www.npmjs.com/package/@kkdevenda/promptlog)
[![license MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![node >=18.3](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen?style=flat-square)](package.json)
[![skills: Claude Code · Codex · Cursor](https://img.shields.io/badge/skills-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Cursor-informational?style=flat-square)](skills/promptlog/SKILL.md)

</div>

Promptlog helps you to see all the prompts that were given to the agents in a repo in git-tree format. It ships with sub-commands that make it easier to
reach past prompts during long sessions with the agents.

## Demo

```
session c86e0429 · claude · /Users/krishna/Developer/promptlog · 2026-09-02 15:49 · 4 prompts · 9m15s · ↑16.2k ↓9.4M

* e05ab5e  16:46  1m35s    ↑ 6.2k  ↓ 2.1M  🔧  4  Ok fine. Please understand that everything that we do on this repo fr…
* ea41f99  16:23  2m36s    ↑ 7.1k  ↓ 3.3M  🔧  7  Is this change a step in the right direction or it was implemented ju…
* bb8c29d  16:10  4m       ↑ 7.5k  ↓ 2.8M  🔧  5  /promptlog
* 7cf870c  16:08  1m04s    ↑ 1.1k  ↓ 1.2M  🔧  2  Earlier the options of promptlog would show up in the input line of t…
  4 of 34 prompts (1 cmd)  span 38m54s  active 9m15s  ↑16.2k  ↓ 9.4M  🔧 18
```

```
🌳 36 prompts · active 5h19m · ↑211.8k ↓62.8M · 🔧186
```

<!-- demo.gif: terminal recording pending -->

## Why

Once an agent is a few tool calls deep, the instruction that started it has
scrolled off screen. A week later, nobody — not even the person who typed
it — can say why a commit exists, or what was actually asked for. The agent
already wrote all of this down: its own transcript on disk is the record.

promptlog's stance is to read that record, not capture a new one. No hook
sits in the agent's loop, no daemon watches keystrokes. What it shows is
plain text that renders the same in a terminal, in an editor, and on
GitHub. Anything that leaves the transcript for a repo goes through
redaction first, and that only happens if you opt in.

## Quick start

**Claude Code**

```
/plugin marketplace add kkdevenda/promptlog
/plugin install promptlog@promptlog
```

**Codex (desktop app or CLI)**

```
codex plugin marketplace add kkdevenda/promptlog
codex plugin add promptlog@promptlog
```

Restart the desktop app if it was open. Plugin management runs through the
terminal `codex` CLI; the desktop app reads the same configuration.

**Cursor, and other agentskills.io hosts**

```
npx skills add kkdevenda/promptlog
```

Then type `/promptlog` in Claude Code, `$promptlog` in Codex, or just ask in
plain English — "what did I ask you", "show my prompts".

### Other ways to install

- **Codex, without leaving a thread:** paste `$skill-installer install
  https://github.com/kkdevenda/promptlog/tree/main/skills/promptlog` into a
  thread and its built-in installer fetches the skill.
- **A `promptlog` command on PATH:** `npm i -g @kkdevenda/promptlog &&
  promptlog skill install` installs the binary and copies the skill into
  every agent directory it finds on the machine.

**Link prompts to commits (optional)**

Run `promptlog init` once in a repo. From then on, `.promptlog/` holds
redacted session records and commits get `Prompt-Id:` trailers for the
prompts whose edits they contain; commits with no attributable prompt,
merges, squashes and `--no-verify` commits get none. Run `promptlog review`
first to see what would be written before it happens.

## Features

| Feature | What you get |
|---|---|
| Prompt tree | git-log style view of every prompt in a session, oldest or newest first; `--full` shows complete prompt text |
| Last prompt recall | your last prompt verbatim, or the Nth one back |
| Search and per-file lookup | `grep` across prompts; `files <path>` for what touched a file |
| Status line | a one-line summary — prompts, active time, tokens, tool calls — for a Claude Code statusLine script |
| Commit linking | `promptlog init` adds opt-in git hooks that write a `Prompt-Id:` trailer per prompt behind a commit |
| Hunk-level attribution | tool edits (`Edit`/`Write`/`apply_patch`) matched to diff hunks; shell edits attributed by command parsing; unmatched hunks stay unattributed |
| Truthful token counts | subagent transcripts attributed to the prompt that spawned them; rows show own usage, totals show both |
| Redaction that cannot be bypassed for secrets | known secret shapes and high-entropy tokens are always replaced before anything reaches the repo; allow-lists cannot exempt them. Emails and large pastes are also replaced, with documented settings (`keepEmails`, `pasteLines`) |
| Origin pointer and source labels | every record points back at its transcript line; renderers label it `origin`, `origin-modified`, or `repo` |
| Multi-agent and multi-person safe | per-session records never collide, a union merge driver handles concurrent clones, `index.jsonl` is rebuilt lazily |
| Three agents, one adapter contract | Claude Code, Codex, and Cursor share one core; adding an agent is one directory plus fixtures |

## How it differs

| | promptlog | [Git AI](https://usegitai.com) | [ai-trailers](https://github.com/EslaMx7/ai-trailers) |
|---|---|---|---|
| Starting point | prompt-first | commit-first | trailer-only |
| Storage | plain files, readable on GitHub | — | trailers only |
| Capture | zero: reads transcripts already on disk | — | — |
| Origin pointer | points back at the source transcript line | — | — |

## Privacy

Recall commands read transcripts and write nothing to the repo; the only
files they touch are two small timestamps under `~/.promptlog/`
(`update-check.json`, `skill-staleness-checked`). `.promptlog/` records exist only
after `init`, live in your own repo, and pass through redaction before they
are written: known secret shapes and high-entropy tokens are always replaced
and no allow-list can exempt them; emails and large pastes are replaced too,
governed by documented settings (`keepEmails`, `pasteLines`). Machine
identity in a session document is a hash of hostname and username.

The one exception to "no network call" is a published-version check, and it
is scoped tightly:

- It runs only for the interactive view commands `tree`, `graph`, `last`,
  `skill-entry`, `status`, `doctor`, and `sessions` — never for `hook`,
  `statusline`, `trailers`, `sync`, `review`, `init`, `merge-driver`, or any
  other repo command.
- At most once every 24 hours (tracked in `~/.promptlog/update-check.json`);
  on a run where that cache is still fresh, no network call is made at all.
  The cache is stamped before the request goes out, so two commands started
  at the same moment do not both fetch.
- When it does run, it makes up to two origin requests — `GET
  https://registry.npmjs.org/@kkdevenda/promptlog/latest`, then `GET
  https://raw.githubusercontent.com/kkdevenda/promptlog/main/skills/promptlog/SKILL.md`
  only if npm fails — each following at most one redirect, each cut off
  after 1.5 seconds or 64 KB of response. It sends no data beyond the
  default HTTP client headers and gives up silently on any failure.
- Turn it off with `PROMPTLOG_NO_UPDATE_CHECK=1`, `{"updateCheck": false}`
  in `~/.promptlog/config.json`, or the `--no-update-check` flag.
  `promptlog doctor` shows whether it's on and when it last checked.
- The only thing it can print is one dim line at the very end of a
  command's output: `promptlog 0.3.0 → 0.4.0 · update: <command>` — or on
  stderr when `--json` is used, so structured stdout always parses.

## Supported agents

| Agent | Status |
|---|---|
| Claude Code | supported |
| Codex | supported |
| Cursor | supported |
| Copilot, Windsurf, OpenCode | detected, not yet |
| Gemini CLI | planned |

**Platforms:** macOS and Linux, verified on real machines. Windows with Git for
Windows runs in CI from 0.5.0; hooks and recall are exercised there but not yet
verified by hand on a Windows desktop. Reports welcome.

## Roadmap

- [ ] Recorder hook for agents without readable transcripts (opt-in)
- [ ] Tier C checkpoints (`refs/promptlog/checkpoints` via `git write-tree`)
- [ ] Copilot, Windsurf, and OpenCode adapters
- [ ] Gemini CLI extension
- [ ] Cost estimates with editable rates
- [ ] Demo GIF

## Status

0.5.0, written in TypeScript and shipped as one bundled file. Transcript
formats are undocumented upstream and may change without notice. Claude Code, Codex, and
Cursor are verified against real transcript files on this machine.

## Community

[Issues](https://github.com/kkdevenda/promptlog/issues) ·
[Discussions](https://github.com/kkdevenda/promptlog/discussions) ·
[Contributing](CONTRIBUTING.md) ·
[Design docs](docs/)

## License

MIT
