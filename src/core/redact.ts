/**
 * Deterministic, model-free redaction. See docs/DESIGN.md "Redaction" section
 * for the contract. Layers run in this order, each protecting its matches
 * from every later layer:
 *
 *   1. known secret shapes (aws keys incl. the context-gated aws-secret
 *      pass, github/slack/stripe/google/openai tokens, jwts, private key
 *      blocks, bearer headers, url credentials, .env-style secret
 *      assignments)
 *   2. config.allow (protect; never redacted by anything after)
 *   3. config.deny (force redact)
 *   4. high entropy tokens
 *   5. home directory collapse (~)
 *   6. large paste blocks
 *   7. emails
 *
 * Known secret shapes run BEFORE config.allow on purpose: allow rules exist
 * to keep ordinary text (a project codename, a public fingerprint, a known
 * hash) out of the deny, entropy, paste and email layers, but they can never
 * exempt something that matches a secret shape. An `allow: ['.*']` still
 * redacts an AWS key. That is what makes "redaction cannot be bypassed for
 * secrets" true rather than a matter of configuration.
 *
 * Implementation note: the text is represented as a list of "pieces", each
 * tagged with its span in the ORIGINAL text. Only pieces still tagged 'raw'
 * are visible to later layers, which is what makes "protected from all
 * later layers" and "no double redaction" true for free, and is also why
 * every finding's start/end is exact against the original text: pieces are
 * never renumbered, only split.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface RedactConfig {
  pasteLines: number;
  pasteBytes: number;
  allow: string[];
  deny: string[];
  keepEmails: boolean;
}

export type RedactConfigInput = Partial<RedactConfig>;

export interface Finding {
  kind: string;
  hash4: string;
  start: number;
  end: number;
}

export interface RedactResult {
  text: string;
  findings: Finding[];
}

export const DEFAULT_CONFIG: RedactConfig = Object.freeze({
  pasteLines: 40,
  pasteBytes: 4000,
  allow: [],
  deny: [],
  keepEmails: false,
});

export function mergeConfig(userConfig?: RedactConfigInput): RedactConfig {
  const u = userConfig ?? {};
  return {
    pasteLines: Number.isFinite(u.pasteLines) ? (u.pasteLines as number) : DEFAULT_CONFIG.pasteLines,
    pasteBytes: Number.isFinite(u.pasteBytes) ? (u.pasteBytes as number) : DEFAULT_CONFIG.pasteBytes,
    allow: Array.isArray(u.allow) ? u.allow : DEFAULT_CONFIG.allow,
    deny: Array.isArray(u.deny) ? u.deny : DEFAULT_CONFIG.deny,
    keepEmails: typeof u.keepEmails === 'boolean' ? u.keepEmails : DEFAULT_CONFIG.keepEmails,
  };
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function hash4Of(s: string): string {
  return sha256Hex(s).slice(0, 4);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shannonEntropy(str: string): number {
  if (!str.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let ent = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;

// ---- piece list machinery ----
//
// status is one of 'raw' (still scannable), 'protected' (config.allow match,
// left verbatim, never scanned again), 'replaced' (already redacted / paste
// / home-dir collapsed).

type PieceStatus = 'raw' | 'protected' | 'replaced';

interface Piece {
  text: string;
  origStart: number;
  origEnd: number;
  status: PieceStatus;
  kind?: string;
  hash4?: string;
}

interface Decision {
  kind: string;
  status?: PieceStatus;
  replacement?: string;
  localStart?: number;
  localEnd?: number;
  hash4?: string;
}

function rawSlice(piece: Piece, s: number, e: number): Piece {
  return {
    text: piece.text.slice(s, e),
    origStart: piece.origStart + s,
    origEnd: piece.origStart + e,
    status: 'raw',
  };
}

/**
 * Scan every 'raw' piece with `regex` (must have the 'g' flag). For each
 * match, `decide(m, pieceText)` returns null (leave untouched, keep
 * scanning) or a `Decision` (localStart/localEnd default to the whole match;
 * replacement defaults to the standard `[redacted:<kind>:<hash4>]`
 * placeholder computed from the original matched substring; status defaults
 * to 'replaced').
 */
function scanAndReplace(
  pieces: Piece[],
  regex: RegExp,
  decide: (m: RegExpExecArray, pieceText: string) => Decision | null,
): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.status !== 'raw') {
      out.push(piece);
      continue;
    }
    const text = piece.text;
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    const sub: Piece[] = [];
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
    while ((m = regex.exec(text))) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      if (m.index < lastIndex) continue; // inside an already-consumed match
      const decision = decide(m, text);
      if (!decision) continue;
      const localStart = decision.localStart ?? m.index;
      const localEnd = decision.localEnd ?? m.index + m[0].length;
      if (localStart > lastIndex) sub.push(rawSlice(piece, lastIndex, localStart));
      const orig = text.slice(localStart, localEnd);
      const hash4 = decision.hash4 ?? hash4Of(orig);
      const replacement = decision.replacement ?? `[redacted:${decision.kind}:${hash4}]`;
      sub.push({
        text: replacement,
        origStart: piece.origStart + localStart,
        origEnd: piece.origStart + localEnd,
        status: decision.status ?? 'replaced',
        kind: decision.kind,
        hash4,
      });
      lastIndex = localEnd;
    }
    if (sub.length === 0) {
      out.push(piece);
    } else {
      if (lastIndex < text.length) sub.push(rawSlice(piece, lastIndex, text.length));
      out.push(...sub);
    }
  }
  return out;
}

function wholeMatch(kind: string): () => Decision {
  return () => ({ kind });
}

// ---- layer 2/3: config.allow / config.deny ----

function compileUserRegexes(patterns: string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    try {
      out.push(new RegExp(p, 'g'));
    } catch {
      // ignore unparsable user regex rather than throwing
    }
  }
  return out;
}

function applyAllow(pieces: Piece[], patterns: string[]): Piece[] {
  for (const re of compileUserRegexes(patterns)) {
    pieces = scanAndReplace(pieces, re, (m, text) => ({
      kind: 'allow',
      status: 'protected',
      replacement: text.slice(m.index, m.index + m[0].length),
    }));
  }
  return pieces;
}

function applyDeny(pieces: Piece[], patterns: string[]): Piece[] {
  for (const re of compileUserRegexes(patterns)) {
    pieces = scanAndReplace(pieces, re, wholeMatch('deny'));
  }
  return pieces;
}

// ---- layer 1: known secret shapes ----

const SECRET_LAYERS: Array<{
  re: RegExp;
  decide: (m: RegExpExecArray, text: string) => Decision | null;
}> = [
  { re: /AKIA[0-9A-Z]{16}/g, decide: wholeMatch('aws-key') },
  {
    re: /aws_secret(?:_access_key)?\s*[:=]\s*(['"]?)([A-Za-z0-9/+=]{40})\1/gi,
    decide: (m) => {
      const value = m[2] as string;
      const localEnd = m.index + m[0].length - (m[1] ? 1 : 0);
      const localStart = localEnd - value.length;
      return { kind: 'aws-secret', localStart, localEnd };
    },
  },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, decide: wholeMatch('github-token') },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, decide: wholeMatch('github-token') },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, decide: wholeMatch('slack-token') },
  { re: /(?:sk|rk)_live_[A-Za-z0-9]{10,}/g, decide: wholeMatch('stripe-key') },
  { re: /AIza[0-9A-Za-z_-]{35}/g, decide: wholeMatch('google-api-key') },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, decide: wholeMatch('api-key') },
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, decide: wholeMatch('jwt') },
  {
    re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    decide: wholeMatch('private-key'),
  },
  {
    // Character class covers standard and url-safe base64 plus '.' so a
    // token is consumed whole; a partial match would leave a short tail
    // that the entropy layer cannot see.
    re: /Bearer\s+([A-Za-z0-9\-_.=+/]+)/g,
    decide: (m) => {
      const value = m[1] as string;
      const localEnd = m.index + m[0].length;
      const localStart = localEnd - value.length;
      return { kind: 'bearer-token', localStart, localEnd };
    },
  },
  {
    // scheme://user:pass@... -> redact only the "user:pass@" part.
    re: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/\s:@]+):([^/\s:@]+)@/g,
    decide: (m) => {
      const schemeLen = m[0].indexOf('//') + 2;
      const localStart = m.index + schemeLen;
      const localEnd = m.index + m[0].length - 1; // exclude trailing '@' so it survives as a separator
      return { kind: 'url-credentials', localStart, localEnd };
    },
  },
  {
    // KEY = value / KEY: value where KEY looks like a secret name. The value
    // is either quoted (may contain spaces, e.g. API_KEY="two words here")
    // or a bare unquoted run.
    re: /^([ \t]*[\w.-]*(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|auth)[\w.-]*)\s*[:=]\s*(?:(['"])([^'"\n]+)\2|([^\s'"#]+))/gim,
    decide: (m) => {
      const quoted = m[2] ?? '';
      const value = quoted ? m[3] : m[4];
      // Require a plausibly secret-shaped value: short words ("Bearer",
      // "Basic", "true", a JSON short value) are common false-positive
      // triggers for the loose /auth|token|secret/ key-name match.
      if (!value || value.length < 8) return null;
      const localEnd = m.index + m[0].length - quoted.length;
      const localStart = localEnd - value.length;
      return { kind: 'env-secret', localStart, localEnd };
    },
  },
];

function applySecretShapes(pieces: Piece[], origText: string): Piece[] {
  for (const layer of SECRET_LAYERS) {
    pieces = scanAndReplace(pieces, layer.re, layer.decide);
  }
  pieces = applyAwsSecretContext(pieces, origText);
  return pieces;
}

// A bare 40-char base64-ish token is only a redactable AWS secret when it
// shows up within a few lines of an AKIA access key or the word "secret" —
// otherwise it's just an opaque token (this catches the common
// "AKIA... and secret <value>" shape that the aws_secret_access_key=
// assignment regex above misses because there's no key=value operator).
const AWS_SECRET_TOKEN_RE = /[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;

function findAwsSecretContextMarkers(origText: string): number[] {
  const markers: number[] = [];
  const akiaRe = /AKIA[0-9A-Z]{16}/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = akiaRe.exec(origText))) markers.push(m.index + m[0].length);
  const secretWordRe = /secret/gi;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = secretWordRe.exec(origText))) markers.push(m.index + m[0].length);
  return markers;
}

function linesBetween(origText: string, from: number, to: number): number {
  const between = origText.slice(from, to);
  const matches = between.match(/\n/g);
  return matches ? matches.length : 0;
}

function replaceExactRawSpan(pieces: Piece[], start: number, end: number, kind: string): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const overlaps = p.origStart < end && p.origEnd > start;
    if (!overlaps || p.status !== 'raw' || p.origStart > start || p.origEnd < end) {
      out.push(p);
      continue;
    }
    const localStart = start - p.origStart;
    const localEnd = end - p.origStart;
    if (localStart > 0) out.push(rawSlice(p, 0, localStart));
    const orig = p.text.slice(localStart, localEnd);
    const hash4 = hash4Of(orig);
    out.push({
      text: `[redacted:${kind}:${hash4}]`,
      origStart: start,
      origEnd: end,
      status: 'replaced',
      kind,
      hash4,
    });
    if (localEnd < p.text.length) out.push(rawSlice(p, localEnd, p.text.length));
  }
  return out;
}

function applyAwsSecretContext(pieces: Piece[], origText: string): Piece[] {
  const markers = findAwsSecretContextMarkers(origText);
  if (markers.length === 0) return pieces;

  const tokenSpans: Array<{ start: number; end: number }> = [];
  AWS_SECRET_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
  while ((m = AWS_SECRET_TOKEN_RE.exec(origText))) {
    tokenSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  if (tokenSpans.length === 0) return pieces;

  const chosen = new Map<string, { start: number; end: number }>();
  for (const marker of markers) {
    for (const span of tokenSpans) {
      if (span.start < marker) continue;
      if (linesBetween(origText, marker, span.start) > 3) continue;
      chosen.set(`${span.start}-${span.end}`, span);
    }
  }
  const finalSpans = Array.from(chosen.values()).sort((a, b) => a.start - b.start);
  for (const span of finalSpans) {
    pieces = replaceExactRawSpan(pieces, span.start, span.end, 'aws-secret');
  }
  return pieces;
}

// ---- layer 4: high entropy ----

const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/_=-]{32,}/g;

function decideEntropy(m: RegExpExecArray): Decision | null {
  const tok = m[0];
  if (UUID_RE.test(tok)) return null;
  if (SHA40_RE.test(tok)) return null;
  if (/^(?:\.{0,2}\/|~\/)/.test(tok)) return null; // absolute/relative/home path prefix
  if (/\.[a-z]{1,5}$/i.test(tok)) return null; // dot-extension suffix (filename-like)
  if (/^[A-Za-z]+$/.test(tok)) return null; // plain word, no digits/symbols
  if (shannonEntropy(tok) <= 4.0) return null;
  return { kind: 'entropy' };
}

function applyEntropy(pieces: Piece[]): Piece[] {
  return scanAndReplace(pieces, ENTROPY_TOKEN_RE, decideEntropy);
}

// ---- layer 5: home directory collapse ----

function buildHomeDirRegex(): RegExp | null {
  const homeDir = os.homedir();
  const candidates = new Set<string>();
  if (homeDir) {
    candidates.add(homeDir);
    // A Windows homeDir (`C:\Users\name`) may show up in transcript text
    // with forward slashes instead (some tools normalise paths that way even
    // on win32), so match that spelling too.
    const homeDirFwd = homeDir.replace(/\\/g, '/');
    if (homeDirFwd !== homeDir) candidates.add(homeDirFwd);
    const user = path.basename(homeDir);
    if (user) {
      candidates.add(`/Users/${user}`);
      candidates.add(`/home/${user}`);
      candidates.add(`C:/Users/${user}`);
    }
  }
  const escaped = Array.from(candidates).filter(Boolean).map(escapeRegex);
  if (escaped.length === 0) return null;
  return new RegExp(`(?:${escaped.join('|')})(?![A-Za-z0-9_.-])`, 'g');
}

function applyHomeDirCollapse(pieces: Piece[]): Piece[] {
  const re = buildHomeDirRegex();
  if (!re) return pieces;
  return scanAndReplace(pieces, re, () => ({ kind: 'home-dir', replacement: '~' }));
}

// ---- layer 6: large paste blocks ----

interface Block {
  start: number;
  end: number;
  lines: number;
  bytes: number;
}

function computeBlocks(text: string, pasteLines: number, pasteBytes: number): Block[] {
  const blocks: Block[] = [];
  const n = text.length;
  let pos = 0;
  let curStart: number | null = null;
  let curLines = 0;

  function finalize(end: number): void {
    if (curStart === null) return;
    const bytes = Buffer.byteLength(text.slice(curStart, end), 'utf8');
    if (curLines > pasteLines || bytes > pasteBytes) {
      blocks.push({ start: curStart, end, lines: curLines, bytes });
    }
    curStart = null;
    curLines = 0;
  }

  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const line = text.slice(pos, lineEnd);
    if (line.trim() !== '') {
      if (curStart === null) curStart = pos;
      curLines++;
    } else {
      finalize(pos);
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  finalize(n);
  return blocks;
}

function splitPiecesAt(pieces: Piece[], pos: number): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.status === 'raw' && pos > p.origStart && pos < p.origEnd) {
      const local = pos - p.origStart;
      out.push({ text: p.text.slice(0, local), origStart: p.origStart, origEnd: pos, status: 'raw' });
      out.push({ text: p.text.slice(local), origStart: pos, origEnd: p.origEnd, status: 'raw' });
    } else {
      out.push(p);
    }
  }
  return out;
}

function applyPasteBlocks(pieces: Piece[], origText: string, cfg: RedactConfig): Piece[] {
  const blocks = computeBlocks(origText, cfg.pasteLines, cfg.pasteBytes);
  for (const block of blocks) {
    let { start, end } = block;

    // Snap the range outward until it fully contains any non-raw piece it
    // partially overlaps (we never split an already-replaced/protected
    // piece in half).
    let changed = true;
    let guard = 0;
    while (changed && guard < 20) {
      changed = false;
      guard++;
      for (const p of pieces) {
        const overlaps = p.origStart < end && p.origEnd > start;
        if (!overlaps || p.status === 'raw') continue;
        if (p.origStart < start) {
          start = p.origStart;
          changed = true;
        }
        if (p.origEnd > end) {
          end = p.origEnd;
          changed = true;
        }
      }
    }

    const anyProtected = pieces.some(
      (p) => p.origStart < end && p.origEnd > start && p.status === 'protected',
    );
    if (anyProtected) continue;

    pieces = splitPiecesAt(pieces, start);
    pieces = splitPiecesAt(pieces, end);

    const coveredIdx: number[] = [];
    pieces.forEach((p, idx) => {
      if (p.origStart >= start && p.origEnd <= end && p.origEnd > p.origStart) coveredIdx.push(idx);
    });
    if (coveredIdx.length === 0) continue;
    const firstIdx = coveredIdx[0] as number;
    const lastIdx = coveredIdx[coveredIdx.length - 1] as number;

    const orig = origText.slice(start, end);
    const hashFull = sha256Hex(orig);
    const newPiece: Piece = {
      text: `[pasted: ${block.lines} lines, ${block.bytes} bytes, sha256:${hashFull.slice(0, 12)}]`,
      origStart: start,
      origEnd: end,
      status: 'replaced',
      kind: 'pasted',
      hash4: hashFull.slice(0, 4),
    };
    pieces.splice(firstIdx, lastIdx - firstIdx + 1, newPiece);
  }
  return pieces;
}

// ---- layer 7: emails ----

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function applyEmails(pieces: Piece[], cfg: RedactConfig): Piece[] {
  if (cfg.keepEmails) return pieces;
  return scanAndReplace(pieces, EMAIL_RE, wholeMatch('email'));
}

// ---- entry points ----

export function redact(text: string | null | undefined, config?: RedactConfigInput): RedactResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', findings: [] };
  }
  const cfg = mergeConfig(config);

  let pieces: Piece[] = [{ text, origStart: 0, origEnd: text.length, status: 'raw' }];

  // Secret shapes first so config.allow can never exempt them (see header).
  pieces = applySecretShapes(pieces, text);
  pieces = applyAllow(pieces, cfg.allow);
  pieces = applyDeny(pieces, cfg.deny);
  pieces = applyEntropy(pieces);
  pieces = applyHomeDirCollapse(pieces);
  pieces = applyPasteBlocks(pieces, text, cfg);
  pieces = applyEmails(pieces, cfg);

  const outText = pieces.map((p) => p.text).join('');
  const findings: Finding[] = pieces
    .filter((p) => p.status === 'replaced')
    .map((p) => ({ kind: p.kind as string, hash4: p.hash4 as string, start: p.origStart, end: p.origEnd }))
    .sort((a, b) => a.start - b.start);

  return { text: outText, findings };
}

export function describeFindings(findings: Finding[] | null | undefined): string {
  if (!findings || findings.length === 0) return 'No redactions.';
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return Array.from(counts.keys())
    .sort()
    .map((kind) => `${kind}: ${counts.get(kind)}`)
    .join('\n');
}
