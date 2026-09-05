/**
 * Origin resolution, per DESIGN.md "Origin resolution".
 *
 * A stored record is a redacted copy. The transcript is authoritative, so when
 * it is still on disk and still says the same thing we show the original text
 * and label the row `origin`. When the transcript is there but the text has
 * changed (edited, compacted, rewritten) we keep the repo copy and label it
 * `origin-modified`. With no transcript at all, `repo`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { byId } from '../agents/index';
import type { Session, Source } from './model';
import type { TurnRecord } from './records';
import { homeExpand, sha256 } from './store';

const parseCache = new Map<string, Session | null>();

/** Guess the agent from a record or its origin path. */
export function agentOf(record: TurnRecord | null, explicit?: string | null): string {
  if (explicit) return explicit;
  const p = record?.origin.path ?? '';
  if (p.includes('.codex')) return 'codex';
  return 'claude';
}

function parseCached(agent: string, filePath: string): Session | null {
  const key = `${agent}:${filePath}`;
  if (parseCache.has(key)) return parseCache.get(key) ?? null;
  let session: Session | null = null;
  try {
    const adapter = byId(agent) ?? byId('claude');
    session = adapter ? adapter.parse(filePath) : null;
  } catch {
    session = null;
  }
  parseCache.set(key, session);
  return session;
}

export function clearCache(): void {
  parseCache.clear();
}

function findTurn(session: Session | null, record: TurnRecord): Session['turns'][number] | null {
  if (!session) return null;
  const uuid = record.origin.uuid || record.fullId;
  for (const t of session.turns) {
    if (uuid && (t.fullId === uuid || t.id === uuid)) return t;
  }
  if (record.id) {
    for (const t of session.turns) if (t.id === record.id) return t;
  }
  return null;
}

export interface ResolvedTurn {
  source: Source;
  prompt: string | null;
  response: string | null;
}

/**
 * `resolve(record, { agent })` -> `{ source, prompt, response }`.
 *
 * `source` is one of `origin`, `origin-modified`, `repo`.
 */
export function resolve(
  record: TurnRecord | null,
  { agent = null }: { agent?: string | null } = {},
): ResolvedTurn {
  const repoResult: ResolvedTurn = {
    source: 'repo',
    prompt: record?.prompt ?? null,
    response: record?.response ?? null,
  };
  if (!record) return repoResult;

  const originPath = homeExpand(record.origin.path || '');
  if (!originPath) return repoResult;
  try {
    if (!fs.statSync(originPath).isFile()) return repoResult;
  } catch {
    return repoResult;
  }

  const session = parseCached(agentOf(record, agent), path.resolve(originPath));
  const turn = findTurn(session, record);
  if (!turn) return repoResult;

  const wantHash = record.origin.promptHash;
  const gotHash = sha256(turn.prompt ?? '');
  if (!wantHash || gotHash !== wantHash) {
    return { source: 'origin-modified', prompt: record.prompt, response: repoResult.response };
  }

  let response = turn.response ?? repoResult.response;
  const wantResp = record.origin.responseHash;
  if (turn.response != null && wantResp && sha256(turn.response) !== wantResp) {
    // Prompt matches but the response drifted (e.g. the turn was still running
    // when we recorded it and has since finished): the transcript wins.
    response = turn.response;
  }
  return { source: 'origin', prompt: turn.prompt, response };
}
