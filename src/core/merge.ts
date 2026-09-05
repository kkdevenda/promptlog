/**
 * The `merge=promptlog` union merge driver for session documents
 * (docs/DESIGN.md "Multi-person"): two clones can write to the SAME session
 * document (the same agent, the same session id) when a turn is committed
 * from two branches, or when a rebase/cherry-pick replays a commit whose
 * `post-commit` hook fires again. Git's default 3-way merge on a JSON file
 * conflicts on almost any concurrent edit; a session document instead
 * merges structurally, by turn `gid`, because `commits` is documented cache
 * (docs/DESIGN.md "Session document"): whichever side has more evidence for
 * a file simply wins.
 *
 * Nothing here reads or writes files - `src/core/commands/repo.ts` wires
 * this to the `merge-driver` CLI entry, which is what `.gitattributes` +
 * `git config merge.promptlog.driver` actually invoke.
 */

import type { CommitEntry, CommitFileEvidence, CommitRole, SessionDoc, TurnRecord } from './records';

/**
 * A turn's `commits` is a list of `CommitEntry`. Union by sha; for a sha
 * present on both sides, `role` widens to `'both'` when they differ, and
 * `files` is merged per path by taking whichever side's evidence matched
 * more hunks.
 */
export function mergeRoles(a: CommitRole, b: CommitRole): CommitRole {
  const known = new Set([a, b].filter((r) => r && r !== 'unknown'));
  if (known.size === 0) return 'unknown';
  if (known.size === 1) return Array.from(known)[0] as CommitRole;
  return 'both'; // both 'contributor' and 'committer' seen: a role actually differs
}

function pickFileEntry(
  a: CommitFileEvidence | undefined,
  b: CommitFileEvidence | undefined,
): CommitFileEvidence | undefined {
  if (!a) return b;
  if (!b) return a;
  const am = Number(a.matched) || 0;
  const bm = Number(b.matched) || 0;
  return bm > am ? b : a;
}

export function mergeFiles(
  a: Record<string, CommitFileEvidence>,
  b: Record<string, CommitFileEvidence>,
): Record<string, CommitFileEvidence> {
  const out: Record<string, CommitFileEvidence> = { ...(a ?? {}) };
  for (const [file, entry] of Object.entries(b ?? {})) {
    const merged = pickFileEntry(out[file], entry);
    if (merged) out[file] = merged;
  }
  return out;
}

export function mergeCommitLists(a: CommitEntry[] | undefined, b: CommitEntry[] | undefined): CommitEntry[] {
  const bySha = new Map<string, CommitEntry>();
  for (const raw of [...(a ?? []), ...(b ?? [])]) {
    if (!raw?.sha) continue;
    const prev = bySha.get(raw.sha);
    if (!prev) {
      bySha.set(raw.sha, { sha: raw.sha, role: raw.role || 'unknown', files: raw.files || {} });
      continue;
    }
    bySha.set(raw.sha, {
      sha: raw.sha,
      role: mergeRoles(prev.role, raw.role || 'unknown'),
      files: mergeFiles(prev.files, raw.files),
    });
  }
  return Array.from(bySha.values()).sort((x, y) => (x.sha < y.sha ? -1 : x.sha > y.sha ? 1 : 0));
}

/**
 * Merge one turn record. `ours` wins for every field except `commits` (a
 * union), `response` (a non-null value is never dropped for a null one -
 * whichever side finished backfilling it), and `redactions` (kept when ours
 * has none but theirs does).
 */
export function mergeTurnRecord(ours: TurnRecord | null, theirs: TurnRecord | null): TurnRecord | null {
  if (!ours) return theirs;
  if (!theirs) return ours;
  const merged: TurnRecord = { ...ours };
  merged.commits = mergeCommitLists(ours.commits, theirs.commits);
  if (merged.response == null && theirs.response != null) {
    merged.response = theirs.response;
    merged.responsePending = !!theirs.responsePending;
    if (theirs.origin?.responseHash) {
      merged.origin = { ...merged.origin, responseHash: theirs.origin.responseHash };
    }
  }
  if (!merged.redactions?.length && theirs.redactions?.length) {
    merged.redactions = theirs.redactions;
  }
  return merged;
}

/**
 * `mergeSessionDocs(base, ours, theirs) -> merged`.
 *
 * `base` is advisory only (the common ancestor's blob, or null for an
 * add/add conflict) - the merge itself is a pure union of `ours` and
 * `theirs` by turn gid, because session documents are append-only per turn:
 * a gid that exists on either side belongs in the result, and a turn that
 * exists on both sides is merged field by field (see `mergeTurnRecord`).
 * Document-level metadata (`version`, `agent`, `sessionId`, `cwd`,
 * `machine`, `started`) prefers `ours`, falling back to `theirs` then
 * `base`.
 */
export function mergeSessionDocs(
  base: Partial<SessionDoc> | null,
  ours: Partial<SessionDoc> | null,
  theirs: Partial<SessionDoc> | null,
): Partial<SessionDoc> {
  const b = base ?? {};
  const o = ours ?? {};
  const t = theirs ?? {};
  const merged: Partial<SessionDoc> = {};
  const keys: Array<keyof SessionDoc> = ['version', 'agent', 'sessionId', 'cwd', 'machine', 'started'];
  for (const key of keys) {
    if (o[key] != null) (merged as Record<string, unknown>)[key] = o[key];
    else if (t[key] != null) (merged as Record<string, unknown>)[key] = t[key];
    else if (b[key] != null) (merged as Record<string, unknown>)[key] = b[key];
  }

  const oTurns = o.turns ?? {};
  const tTurns = t.turns ?? {};
  const gids = new Set([...Object.keys(oTurns), ...Object.keys(tTurns)]);
  const turns: Record<string, TurnRecord> = {};
  for (const gid of Array.from(gids).sort()) {
    const mergedTurn = mergeTurnRecord(oTurns[gid] ?? null, tTurns[gid] ?? null);
    if (mergedTurn) turns[gid] = mergedTurn;
  }
  merged.turns = turns;
  return merged;
}
