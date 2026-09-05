/**
 * Narrowing helpers for reading untrusted JSON (transcript records, store
 * documents). Every field read off a parsed record goes through one of
 * these instead of a cast.
 */

import type { JsonRecord } from './model';

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bool(v: unknown): boolean {
  return v === true;
}

export function rec(v: unknown): JsonRecord | null {
  return isRecord(v) ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `obj[key]` when `obj` is a record, else undefined. */
export function get(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

/** Parse JSON that may be malformed; null instead of a throw. */
export function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
