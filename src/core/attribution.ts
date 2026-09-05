/**
 * Attribution: which prompt turns produced the change being committed.
 *
 * PLAN-v0.3.md §3. Two independent questions:
 *
 *   contributors - for every staged file, every turn of every candidate
 *                  session that edited that file since the previous commit,
 *                  proved by evidence from the transcript (tool calls), not
 *                  by a time window and not by "highest overlap wins".
 *   committer    - the turn the commit is being issued FROM: the active turn
 *                  of the session named by an agent's own env var. Linked even
 *                  when it edited nothing; absent for a human commit.
 *
 * Evidence tiers (PLAN §3.2):
 *
 *   A  Claude Edit/Write/MultiEdit, Codex apply_patch  hunk level, high
 *   B  shell commands parsed for written paths          file level, medium
 *   C  per-turn checkpoints via a recorder hook         roadmap, not here
 *
 * Nothing in here guesses. A hunk no turn can be shown to have written stays
 * unattributed, which is the honest answer for a hand edit.
 */

import crypto from 'node:crypto';
import { byId } from '../agents/index';
import type { Edit } from '../agents/types';
import type { DiffHunk } from './git';
import { normalizeRepoPath, stagedBlobHash } from './git';
import type { Session } from './model';
import type { CommitFileEvidence, CommitRole } from './records';

// ------------------------------------------------------------- line matching

/** Whitespace-normalised single line: indentation and run-length are not
 * evidence, so `  a( b )` and `a( b )` compare equal. */
export function normLine(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text -> normalised, blank-free lines. */
export function normLines(text: string | null | undefined): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(normLine)
    .filter((l) => l !== '');
}

/** Array of lines -> normalised, blank-free lines. */
export function normArray(lines: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const l of lines ?? []) {
    const n = normLine(l);
    if (n !== '') out.push(n);
  }
  return out;
}

const MIN_SINGLE_LINE_CHARS = 12;

/**
 * Is this needle specific enough to prove anything?
 *
 * A single short line is not evidence: `}`, `)`, `else {`, `return;` and
 * `import os` occur in half the hunks of a repo, so matching on one would
 * credit a turn with code it never wrote. Two lines in order are specific
 * enough; one line has to be substantial - at least 12 non-whitespace
 * characters - and contain something other than punctuation.
 */
export function isSpecificNeedle(needle: readonly string[]): boolean {
  if (needle.length >= 2) return true;
  if (needle.length !== 1) return false;
  const nonWs = String(needle[0]).replace(/\s+/g, '');
  if (nonWs.length < MIN_SINGLE_LINE_CHARS) return false;
  return /[A-Za-z0-9_]/.test(nonWs);
}

/**
 * Do `needle`'s lines all appear in `hay`, in order? Not necessarily
 * contiguously: `git diff -U0` splits one logical edit into several hunks and
 * reformatting drops blank lines, so requiring adjacency would reject real
 * matches. An empty or unspecific needle proves nothing and never matches.
 */
export function containsInOrder(hay: readonly string[], needle: readonly string[]): boolean {
  if (!isSpecificNeedle(needle)) return false;
  let i = 0;
  for (const line of hay) {
    if (line === needle[i]) {
      i += 1;
      if (i === needle.length) return true;
    }
  }
  return false;
}

/**
 * The lines `after` adds relative to `before`, normalised.
 *
 * An `Edit`'s `new_string` almost always repeats unchanged context lines - it
 * has to, to be unambiguous - while `git diff -U0` shows ONLY the changed
 * lines. Comparing `new_string` whole against a `-U0` hunk therefore fails on
 * the commonest edit there is (insert a line, keep its neighbours), so the
 * context is subtracted first: what is left is what this edit actually
 * introduced, and that is what the hunk must contain.
 */
export function addedRelativeTo(
  before: string | null | undefined,
  after: string | null | undefined,
): string[] {
  const have = new Map<string, number>();
  for (const l of normLines(before)) have.set(l, (have.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of normLines(after)) {
    const n = have.get(l) ?? 0;
    if (n > 0) {
      have.set(l, n - 1);
      continue;
    }
    out.push(l);
  }
  return out;
}

/** git's blob object id for this content: sha1("blob <len>\0" + bytes). */
export function blobSha1(content: string | null | undefined): string {
  const buf = Buffer.from(String(content ?? ''), 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// ------------------------------------------------------------------ helpers

function gidOf(
  turn: { gid: string; id: string } | null | undefined,
  agent: string,
  sessionId: string | null | undefined,
): string {
  if (turn?.gid) return turn.gid;
  return `${agent}:${String(sessionId ?? '').slice(0, 8)}:${turn?.id}`;
}

export interface CandidateSession {
  agent: string;
  sessionId: string | null;
  session: Session | null;
  how?: string | null;
}

/** Mark every hunk this edit can be shown to have produced.
 *
 * Added lines are the evidence; an edit that only DELETED lines has none, and
 * is matched against the hunks' removed lines instead - otherwise a deletion
 * could never be attributed to anyone. */
function matchHunks(
  rec: { matched: Set<number>; kinds: Set<string> },
  normHunks: string[][],
  rawHunks: readonly DiffHunk[],
  added: string[],
  removed: string[],
): boolean {
  let hit = false;
  for (let i = 0; i < normHunks.length; i += 1) {
    let ok = false;
    if (added.length) ok = containsInOrder(normHunks[i] as string[], added);
    else if (removed.length) ok = containsInOrder(normArray(rawHunks[i]?.removed), removed);
    if (!ok) continue;
    rec.matched.add(i);
    hit = true;
  }
  return hit;
}

/** The evidence kind that best describes a file entry. */
function summarizeConfidence(kinds: Set<string>): string {
  if (kinds.size === 1) return [...kinds][0] as string;
  if (kinds.size > 1) return 'mixed';
  return 'shell';
}

/** Every edit every candidate session can be shown to have made. */
function collectEdits({
  repoRoot,
  candidateSessions,
  sinceMicros,
}: {
  repoRoot: string;
  candidateSessions: CandidateSession[];
  sinceMicros: number | null;
}): Edit[] {
  const out: Edit[] = [];
  for (const cand of candidateSessions) {
    const adapter = byId(cand.agent);
    if (!adapter || cand.session == null) continue;
    if (adapter.capabilities.edits === false) continue;
    let list: Edit[] = [];
    try {
      list = adapter.edits(cand.session, { root: repoRoot });
    } catch {
      list = [];
    }
    for (const e of list) {
      if (!e.rel) continue;
      if (sinceMicros != null && Number.isFinite(e.tsMicros) && e.tsMicros < sinceMicros) continue;
      out.push(e);
    }
  }
  return out;
}

export interface LinkedEntry {
  role: CommitRole;
  files: Record<string, CommitFileEvidence>;
}

export interface AttributeResult {
  linked: Map<string, LinkedEntry>;
  unattributed: Record<string, number>;
}

export interface AttributeOptions {
  repoRoot: string;
  stagedFiles?: string[];
  hunksByFile?: Map<string, DiffHunk[]>;
  candidateSessions?: CandidateSession[];
  /** Previous commit time, null for all. */
  sinceMicros?: number | null;
  /** The env-identified session, or null. */
  committerSession?: CandidateSession | null;
}

/**
 * `attribute(...) -> { linked, unattributed }`. `linked` maps a turn's gid to
 * its role (`contributor`, `committer`, or `both`) and the per-file evidence
 * it earned; `unattributed` counts, per staged file, the hunks no turn can be
 * shown to have written.
 */
export function attribute({
  repoRoot,
  stagedFiles = [],
  hunksByFile = new Map(),
  candidateSessions = [],
  sinceMicros = null,
  committerSession = null,
}: AttributeOptions): AttributeResult {
  const staged: string[] = [];
  for (const f of stagedFiles) {
    const n = normalizeRepoPath(f, repoRoot);
    if (n && !staged.includes(n)) staged.push(n);
  }
  const stagedSet = new Set(staged);

  const edits = collectEdits({ repoRoot, candidateSessions, sinceMicros }).filter(
    (e) => e.rel != null && stagedSet.has(e.rel),
  );

  const linked = new Map<string, LinkedEntry>();
  const unattributed: Record<string, number> = {};

  const noteFile = (gid: string, file: string, entry: CommitFileEvidence) => {
    const existing = linked.get(gid);
    if (existing) existing.files[file] = entry;
    else linked.set(gid, { role: 'contributor', files: { [file]: entry } });
  };

  for (const file of staged) {
    const fileEdits = edits.filter((e) => e.rel === file);
    if (!fileEdits.length) continue;
    const fileHunks = hunksByFile.get(file) ?? [];
    const hunkCount = fileHunks.length;
    const normHunks = fileHunks.map((h) => normArray(h.added));

    const perTurn = new Map<string, { matched: Set<number>; kinds: Set<string> }>();
    const bump = (gid: string) => {
      let rec = perTurn.get(gid);
      if (!rec) {
        rec = { matched: new Set(), kinds: new Set() };
        perTurn.set(gid, rec);
      }
      return rec;
    };

    let stagedBlob: string | null = null;
    let stagedBlobRead = false;
    const blobOf = () => {
      if (!stagedBlobRead) {
        stagedBlob = stagedBlobHash(repoRoot, file);
        stagedBlobRead = true;
      }
      return stagedBlob;
    };

    for (const e of fileEdits) {
      const rec = bump(e.turnId);
      if (e.kind === 'write') {
        // A Write whose content hashes to the staged blob wrote the whole
        // file: every hunk in it belongs to that turn, no line matching
        // needed. Otherwise fall back to containment (something edited it
        // afterwards).
        if (e.after != null && blobOf() && blobSha1(e.after) === blobOf()) {
          for (let i = 0; i < hunkCount; i += 1) rec.matched.add(i);
          rec.kinds.add('write');
          continue;
        }
        // The hash did not match, so something edited the file after this
        // Write. It can still account for a hunk whose ADDED LINES all appear
        // in the content it wrote - the containment runs hunk-inside-content,
        // never content-inside-hunk: a whole file's text is never a subset of
        // one `-U0` hunk, so the old direction matched a Write's own hunks
        // essentially never.
        const content = normLines(e.after);
        let hit = false;
        for (let i = 0; i < normHunks.length; i += 1) {
          if (!containsInOrder(content, normHunks[i] as string[])) continue;
          rec.matched.add(i);
          hit = true;
        }
        if (hit) rec.kinds.add('write');
      } else if (e.kind === 'edit') {
        // An Edit is matched by the lines it introduced.
        const added = addedRelativeTo(e.before, e.after);
        const removed = addedRelativeTo(e.after, e.before);
        if (matchHunks(rec, normHunks, fileHunks, added, removed)) rec.kinds.add('edit');
      } else if (e.kind === 'patch') {
        let hit = false;
        for (const ph of e.hunks ?? []) {
          if (matchHunks(rec, normHunks, fileHunks, normArray(ph.added), normArray(ph.removed))) hit = true;
        }
        if (hit) rec.kinds.add('patch');
      }
      // 'shell' and 'notebook' carry no line evidence: handled below.
    }

    const matchedAny = new Set<number>();
    for (const [gid, rec] of perTurn.entries()) {
      if (!rec.matched.size) continue;
      for (const i of rec.matched) matchedAny.add(i);
      noteFile(gid, file, {
        hunks: hunkCount,
        matched: rec.matched.size,
        confidence: summarizeConfidence(rec.kinds),
      });
    }

    // File-level evidence: a shell command, a notebook cell replacement, or a
    // patch with no lines at all (`*** Delete File:`, the old side of a
    // `*** Move to:`). Recorded with matched 0, so it is never overstated.
    const noLines = (e: Edit) => !(e.hunks ?? []).some((h) => h.added.length || h.removed.length);
    let fileLevel = false;
    for (const e of fileEdits) {
      const fileOnly = e.kind === 'shell' || e.kind === 'notebook' || (e.kind === 'patch' && noLines(e));
      if (!fileOnly) continue;
      const rec = perTurn.get(e.turnId);
      if (rec?.matched.size) continue; // already has tier A evidence
      const existing = linked.get(e.turnId);
      if (existing?.files[file]?.matched) continue;
      fileLevel = true;
      noteFile(e.turnId, file, {
        hunks: hunkCount,
        matched: 0,
        confidence: e.kind === 'patch' ? 'patch' : e.kind === 'notebook' ? 'notebook' : 'shell',
      });
    }

    // Hunks nobody matched are unattributed - unless tier B accounted for the
    // file, which per PLAN §3.3 is what "without tier B or C evidence" means.
    const left = hunkCount - matchedAny.size;
    if (left > 0 && !fileLevel) unattributed[file] = left;
  }

  // Files nobody can be shown to have touched are unattributed in full.
  for (const file of staged) {
    if (unattributed[file] != null) continue;
    if (edits.some((e) => e.rel === file)) continue;
    const n = (hunksByFile.get(file) ?? []).length;
    if (n > 0) unattributed[file] = n;
  }

  // The committer: the active turn of the session an agent named in our own
  // environment. Linked whatever it edited - the commit is being issued from
  // inside it - unless it is a slash command, which never earns a trailer.
  if (committerSession?.session) {
    const turns = committerSession.session.turns;
    const active = turns.length ? turns[turns.length - 1] : null;
    if (active && !active.isCommand) {
      const gid = gidOf(active, committerSession.agent, committerSession.sessionId);
      const prev = linked.get(gid);
      if (prev) prev.role = 'both';
      else linked.set(gid, { role: 'committer', files: {} });
    }
  }

  return { linked, unattributed };
}
