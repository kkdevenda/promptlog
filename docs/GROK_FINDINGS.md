# Grok findings — promptlog 0.5.0

- **Reviewer:** Grok (Cursor Grok 4.6)
- **Date:** 2026-09-05
- **Scope:** whole-project review against five parameters (not a diff review)
- **Sources:** `src/`, `skills/promptlog/`, `docs/DESIGN.md`, CI, tests, [agentskills.io specification](https://agentskills.io/specification)
- **Tests:** not re-run for this review

## Verdict

**7.5 / 10.** Unusually serious for 0.5.0. The stance is real (read transcripts, do not capture), the adapter/core split is sound, and the skill is packaged the way a distributable skill should be. The cost of that seriousness is two god modules and a fragmented install/upgrade story.

| Parameter | Score | Judgment |
|---|---:|---|
| Code quality | 8.0 | Sound split, two god files |
| Features | 8.5 | Unusually complete for 0.5.0 |
| Installation | 6.5 | Five doors, unclear which to use |
| Upgrade / maintain | 6.0 | Channels fragment the update path |
| Skill shipping | 8.5 | Close to agentskills.io |

## Findings

Sorted by severity. Strengths are listed after the issues.

### P1 — Five install channels, no default

- **Parameter:** Installation (6.5)
- **Where:** `README.md` Quick start
- **What:** Claude plugin, Codex plugin, `$skill-installer`, `npx skills add`, and `npm i -g && promptlog skill install` are presented as peers. Codex alone has three paths. `npm i -g` without `skill install` gives a terminal binary and no `/promptlog`.
- **Why it matters:** Each path is short. Five of them is a menu, not an install. A new user has to already know which host they are on and which package manager that host prefers.
- **Fix:** One recommended command per host at the top of the README. Demote the rest under “also”.

### P1 — Upgrade path is split across five updaters

- **Parameter:** Upgrade / maintain (6.0)
- **Where:** `src/core/updateCheck.ts`, `src/core/commands/skill.ts` `update()`, `skills/promptlog/SKILL.md` Rules
- **What:** The once-a-day hint infers one command from `__dirname` (`/plugin update`, `codex plugin marketplace upgrade`, `npx skills update`, `promptlog skill update`, or `npm i -g`). It cannot refresh the others. Marketplace and `npx skills add` copies are “external”; `skill update` leaves them alone unless `--all` is passed.
- **Why it matters:** Version drift is already real: a user-level Claude skill can sit at 0.4.0 (old frontmatter, `argument-hint`) while this repo ships 0.5.0.
- **Fix:** Make `skill update` or `doctor` refresh external copies by default, with a dry-run. Keep `--all` as the explicit form, not the hidden one.

### P2 — `repo.ts` and `store.ts` are god modules

- **Parameter:** Code quality (8.0)
- **Where:** `src/core/commands/repo.ts` (~1,787 lines), `src/core/store.ts` (~1,411 lines)
- **What:** Init, hooks, attribution staging, merge drivers, review, trailers, and the whole `.promptlog/` lifecycle live in these two files. The adapter split is clean; this layer is not.
- **Why it matters:** The next attribution or hook bug will hide here. The stated values are simplicity and minimal abstraction. This is the opposite.
- **Fix:** Split `repo.ts` into hooks / init / recall-from-store before adding another hook case.

### P2 — Baked hook path fails open and goes quiet

- **Status:** Fixed 2026-09-05, alongside the sh-to-Node hook dispatcher port. See DESIGN.md "Hooks" ("Missing baked path"): `promptlog doctor` now warns when a hook file's baked path is missing.
- **Parameter:** Upgrade / maintain (6.0)
- **Where:** the generated hook files' baked `require()` path (`src/core/commands/repo.ts` `installHooks()`)
- **What:** `init` bakes an absolute path to `promptlog.js`. Moving Node, reinstalling, or changing the skill location requires `promptlog init` again. Fail-open means a missing binary does not block the commit — trailers just stop.
- **Why it matters:** Users will think commit linking is broken or “sometimes works.”
- **Fix:** `doctor` (and the dispatcher) should warn when the baked path is gone, once, on stderr.

### P3 — Adapter interface is fat

- **Parameter:** Code quality (8.0)
- **Where:** `src/agents/types.ts` `Adapter` (~15 required methods)
- **What:** Implementations stay thin (Claude index is 72 lines). A new agent still needs locate, parse, edits, children, and skillDirs before it is honest. CONTRIBUTING says “one directory plus fixtures”; that is true and still a lot of surface.
- **Why it matters:** Copilot / Windsurf / OpenCode adapters will copy this surface, including methods they cannot implement honestly.
- **Fix:** Keep the contract. Document which methods may be no-ops with `capabilities.* = false`, and add a template adapter that does exactly that.

### P3 — Design contract is drifting

- **Parameter:** Code quality (8.0)
- **Where:** `docs/DESIGN.md` “What promptlog is”, `docs/README.md`
- **What:** DESIGN.md still describes reading “Claude Code and Codex” transcripts. `docs/README.md` still says “contract for current (v0.2) behaviour.” Cursor is a shipped adapter. DISTRIBUTION.md is referenced and does not exist.
- **Why it matters:** DESIGN.md is treated as the contract. Drift here is how the next change disagrees with the last one.
- **Fix:** One sentence in DESIGN.md that names all three agents. Fix `docs/README.md` to say 0.5.0 / current.

### P3 — Skill frontmatter hygiene

- **Parameter:** Skill shipping (8.5)
- **Where:** `skills/promptlog/SKILL.md`
- **What:** No `license: MIT` (repo is MIT; field is optional in the spec). `allowed-tools` uses Claude `Bash()` syntax. `KNOWN_UNSUPPORTED` in `src/core/commands/skill.ts` still lists `cursor` (harmless — skipped when an adapter exists).
- **Why it matters:** Small, and `check-skill.mjs` already enforces the spec keys. These are the leftovers.
- **Fix:** Add `license: MIT`. Drop `cursor` from `KNOWN_UNSUPPORTED`. Leave `allowed-tools` if Claude Code actually honors it; do not pretend it is portable.

### P3 — Windows is not a product

- **Status:** Partially fixed 2026-09-05: hooks no longer depend on a POSIX shell (the shell hook dispatcher was ported to Node, `src/core/commands/dispatch.ts`), and `PROMPTLOG_GIT_CMD` now has a win32 path (`wmic`/PowerShell). CI still does not run a Windows matrix leg.
- **Parameter:** Features (8.5)
- **Where:** the old shell hook dispatcher (`ps -o args=`, POSIX `sh`), `.github/workflows/ci.yml` (ubuntu + macos only)
- **What:** Node itself would run. Hooks, amend detection, and CI would not.
- **Why it matters:** Fine to defer. Do not imply otherwise.
- **Fix:** Say “macOS and Linux” on the README badge / supported-agents table. No Windows work required for 1.0.

---

### Strengths (not issues)

**S1 — Adapter/core split is real.** Core never reads a transcript format. Three adapters, one registry (`src/agents/index.ts`). Untrusted JSON goes through `str` / `rec` / `arr`, not casts. Redaction fails closed. Hooks fail open. Unmatched hunks stay unattributed. Zero runtime deps. One readable esbuild bundle; CI fails if it drifts from `src/`.

**S2 — Feature depth is 1.x at 0.5.0.** Recall (tree / last / show / grep / files / sessions), hunk-level attribution where the payload allows, file-level and labelled for shell, redaction that allow-lists cannot exempt, subagent conservation tests, multi-person union merge, `review` before first write. Known gaps (Cursor `tokensPartial`, no live-session env, no cost estimates, no Copilot adapter) are named, not half-built.

**S3 — Skill packaging matches the spec.** Frontmatter is only agentskills.io keys, enforced by `scripts/check-skill.mjs`. Description has WHAT + WHEN + trigger phrases. Version lives in `metadata.version`. SKILL.md is 146 lines. One skill for every host; the Claude pre-run block is isolated and labelled. The CLI ships inside the skill. Pack smoke and standalone-skill smoke run from an empty HOME.

**S4 — Contributor hygiene is strong.** `bump-version.mjs` updates package.json, SKILL.md, and both plugin manifests together. `npm test` is typecheck + lint + check-skill + build + vitest. Matrix is Node 18/20/22/24 on Ubuntu and macOS.

**S5 — The product stance is enforced.** Recall writes two timestamp files under `~/.promptlog/`. Repo records exist only after `init`, after redaction. That constraint is consistent in code, skill, and README.

## Recommended order

1. One recommended install per host at the top of the README; demote the rest.
2. Make `skill update` / `doctor` refresh external copies by default (dry-run first).
3. Split `repo.ts` before the next hook case lands in it.
4. Add `license: MIT` to SKILL.md; drop Cursor from `KNOWN_UNSUPPORTED`; name all three agents in DESIGN.md.
5. Warn from `doctor` / the dispatcher when the baked `PROMPTLOG_JS` path is gone.
