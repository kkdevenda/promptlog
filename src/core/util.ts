/**
 * Shared helpers: number/duration humanizing, ANSI color wrapping, small
 * text helpers, command output plumbing, and timestamp parsing (ISO-8601
 * strings from Claude/Codex transcripts) at microsecond precision, stored
 * as integer epoch microseconds.
 */

import os from 'node:os';
import type { Turn } from './model';

/** What a command handler is given to read its environment and write its
 * output; `out`/`err` write to `stdout`/`stderr`. */
export interface Ctx {
  cwd: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
}

/**
 * Home directory for a command: `env.HOME` first (tests inject a fake home
 * this way), then `env.USERPROFILE` (Windows, when something has set it
 * without also setting HOME — Git for Windows' own bash always sets HOME,
 * but a plain `cmd`/PowerShell launch of a Node-based command would not),
 * falling back to `os.homedir()` (which already reads USERPROFILE itself on
 * win32 when neither env var path applies).
 */
export function envHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

/** A subcommand's parsed argv: flag values and the positionals after the
 * subcommand name. Shared by every `commands/*.ts` handler. */
export interface CommandArgs {
  values: Record<string, unknown>;
  positionals: string[];
}

export function humanizeNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  let v = Math.trunc(n);
  const sign = v < 0 ? '-' : '';
  v = Math.abs(v);
  if (v < 1000) return `${sign}${v}`;
  const units: Array<[string, number]> = [
    ['M', 1000000],
    ['k', 1000],
  ];
  for (const [unit, div] of units) {
    if (v >= div) {
      const val = v / div;
      let s = val.toFixed(1);
      if (s.endsWith('.0')) s = s.slice(0, -2);
      return `${sign}${s}${unit}`;
    }
  }
  return `${sign}${v}`;
}

export function humanizeDuration(seconds: number): string {
  let s = Math.round(Number(seconds));
  if (!Number.isFinite(s)) s = 0;
  if (s < 0) s = 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec ? `${m}m${String(sec).padStart(2, '0')}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const m = Math.floor(rem / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

// ---- text ----

/** First non-empty line of `text`, trimmed; '' for empty/null input. */
export function firstLine(text: string | null | undefined): string {
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Backslash-escape double quotes (Mermaid `"..."` labels). */
export function escQuotes(s: string): string {
  return String(s).replace(/"/g, '\\"');
}

// ---- command plumbing ----
// Command handlers receive a Ctx; these write one line to it, adding the
// newline only when `s` lacks one.

export function out(ctx: Ctx, s: string): void {
  ctx.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
}

export function err(ctx: Ctx, s: string): void {
  ctx.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
}

const CODES = {
  RESET: '\x1b[0m',
  DIM: '\x1b[2m',
  YELLOW: '\x1b[33m',
  GREEN: '\x1b[32m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
};

export class Colors {
  enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = !!enabled;
  }
  wrap(code: string, text: string): string {
    if (!this.enabled) return text;
    return `${code}${text}${CODES.RESET}`;
  }
  yellow(t: string): string {
    return this.wrap(CODES.YELLOW, t);
  }
  dim(t: string): string {
    return this.wrap(CODES.DIM, t);
  }
  green(t: string): string {
    return this.wrap(CODES.GREEN, t);
  }
  blue(t: string): string {
    return this.wrap(CODES.BLUE, t);
  }
  magenta(t: string): string {
    return this.wrap(CODES.MAGENTA, t);
  }
  cyan(t: string): string {
    return this.wrap(CODES.CYAN, t);
  }
}

// ---- timestamp handling (epoch microseconds, integer) ----

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([+-]\d{2}:\d{2})?$/;

/**
 * Parse an ISO-8601 string (as produced by Claude/Codex transcripts) into
 * epoch microseconds (UTC), or null if unparsable. A naive datetime (no
 * offset) is treated as UTC.
 */
export function parseIsoStringToMicros(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null;
  let str = s;
  if (str.endsWith('Z')) str = `${str.slice(0, -1)}+00:00`;
  const m = ISO_RE.exec(str);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, offset] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
  ];
  let micros = 0;
  if (frac) {
    // frac includes leading '.', e.g. ".680" or ".680000123"
    let digits = frac.slice(1);
    if (digits.length > 6) digits = digits.slice(0, 6);
    else digits = digits.padEnd(6, '0');
    micros = Number.parseInt(digits, 10);
  }
  const epochMs = Date.UTC(
    Number.parseInt(y, 10),
    Number.parseInt(mo, 10) - 1,
    Number.parseInt(d, 10),
    Number.parseInt(h, 10),
    Number.parseInt(mi, 10),
    Number.parseInt(sec, 10),
  );
  if (Number.isNaN(epochMs)) return null;
  let totalMicros = epochMs * 1000 + micros;
  if (offset) {
    const sign = offset[0] === '-' ? -1 : 1;
    const oh = Number.parseInt(offset.slice(1, 3), 10);
    const om = Number.parseInt(offset.slice(4, 6), 10);
    const offsetMinutes = sign * (oh * 60 + om);
    totalMicros -= offsetMinutes * 60 * 1000000;
  }
  return totalMicros;
}

export function nowMicros(): number {
  return Date.now() * 1000;
}

/** epoch microseconds -> Date object (millisecond precision, fine for
 * display purposes: minute-level formatting only). */
export function microsToDate(micros: number): Date {
  return new Date(Math.floor(micros / 1000));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** epoch microseconds -> isoformat() string in UTC, e.g.
 * "2026-09-02T10:19:46.680000+00:00" or, with zero microseconds,
 * "2026-09-02T10:19:46+00:00". */
export function isoFormatUtc(micros: number): string {
  const seconds = Math.floor(micros / 1000000);
  let frac = micros - seconds * 1000000;
  if (frac < 0) frac += 1000000;
  const d = new Date(seconds * 1000);
  const y = d.getUTCFullYear();
  const mo = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const h = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const s = pad2(d.getUTCSeconds());
  let result = `${y}-${mo}-${day}T${h}:${mi}:${s}`;
  if (frac !== 0) {
    result += `.${String(frac).padStart(6, '0')}`;
  }
  return `${result}+00:00`;
}

/** local HH:MM */
export function localHHMM(micros: number): string {
  const d = microsToDate(micros);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Source chip for a turn: null for a live-transcript turn, 'modified' for
 * a repo record whose origin was edited, 'repo' for a repo-only record. */
export function sourceLabel(turn: Pick<Turn, 'source'> | null | undefined): string | null {
  if (!turn?.source || turn.source === 'origin') return null;
  return turn.source === 'origin-modified' ? 'modified' : 'repo';
}

/** local "YYYY-MM-DD HH:MM" */
export function localYMDHM(micros: number): string {
  const d = microsToDate(micros);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
