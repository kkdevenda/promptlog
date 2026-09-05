import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseClaudeSession } from '../src/agents/claude/parser';
import { parseCodexSession } from '../src/agents/codex/parser';
import { tmpDir as sharedTmpDir } from './helpers';

function writeJsonl(filePath: string, records: unknown[]): void {
  fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

function tmpDir(): string {
  return sharedTmpDir('promptlog-test-');
}

function userRec(
  uuid: string,
  parent: string | null,
  ts: string,
  text: string,
  {
    isMeta = false,
    isSidechain = false,
    cwd = '/tmp/proj',
  }: { isMeta?: boolean; isSidechain?: boolean; cwd?: string } = {},
) {
  return {
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: ts,
    isMeta,
    isSidechain,
    cwd,
    sessionId: 'sess1',
    message: { role: 'user', content: text },
  };
}

function assistantRec(
  uuid: string,
  parent: string | null,
  ts: string,
  msgId: string,
  content: unknown[],
  usage: Record<string, unknown>,
  model = 'claude-x',
) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: ts,
    cwd: '/tmp/proj',
    sessionId: 'sess1',
    message: {
      role: 'assistant',
      id: msgId,
      model,
      content,
      usage,
    },
  };
}

const USAGE = {
  input_tokens: 5,
  cache_creation_input_tokens: 100,
  cache_read_input_tokens: 200,
  output_tokens: 50,
  output_tokens_details: { thinking_tokens: 10 },
};

describe('claude parser', () => {
  test('usage dedup across blocks', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('u1', null, '2026-01-01T00:00:00Z', 'hello there'),
      assistantRec('a1', 'u1', '2026-01-01T00:00:01Z', 'msg1', [{ type: 'thinking', thinking: '' }], USAGE),
      assistantRec('a2', 'a1', '2026-01-01T00:00:02Z', 'msg1', [{ type: 'text', text: 'hi' }], USAGE),
      assistantRec(
        'a3',
        'a2',
        '2026-01-01T00:00:03Z',
        'msg1',
        [{ type: 'tool_use', name: 'Bash', input: {} }],
        USAGE,
      ),
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
    const t = sess.turns[0];
    expect(t).toBeDefined();
    expect(t?.outputTokens).toBe(50);
    expect(t?.inputTokens).toBe(5);
    expect(t?.cacheReadTokens).toBe(200);
    expect(t?.cacheWriteTokens).toBe(100);
    expect(t?.thinkingTokens).toBe(10);
    expect(t?.toolCalls).toBe(1);
    expect(t?.toolNames.get('Bash')).toBe(1);
  });

  test('branch detection', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('root', null, '2026-01-01T00:00:00Z', 'root prompt'),
      assistantRec('a1', 'root', '2026-01-01T00:00:01Z', 'm1', [{ type: 'text', text: 'ok' }], USAGE),
      userRec('branchA', 'a1', '2026-01-01T00:01:00Z', 'branch A prompt'),
      assistantRec('a2', 'branchA', '2026-01-01T00:01:01Z', 'm2', [{ type: 'text', text: 'ok' }], USAGE),
      userRec('branchB', 'a1', '2026-01-01T00:02:00Z', 'branch B prompt'),
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(3);
    const root = sess.byId('root');
    expect(root).toBeTruthy();
    expect(root?.children.includes('branchA')).toBeTruthy();
    expect(root?.children.includes('branchB')).toBeTruthy();
    expect(root?.children.length).toBe(2);
  });

  test('slash command marking', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec(
        'u1',
        null,
        '2026-01-01T00:00:00Z',
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      ),
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
    const t = sess.turns[0];
    expect(t?.isCommand).toBe(true);
    expect(t?.prompt).toBe('/model opus');
  });

  test('meta and sidechain skipped', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('meta1', null, '2026-01-01T00:00:00Z', '<local-command-caveat>skip me</local-command-caveat>', {
        isMeta: true,
      }),
      userRec('side1', null, '2026-01-01T00:00:01Z', 'sidechain prompt', { isSidechain: true }),
      userRec('real1', null, '2026-01-01T00:00:02Z', 'real prompt'),
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
    expect(sess.turns[0]?.prompt).toBe('real prompt');
  });

  test('tool_result-only content is not a prompt', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('real1', null, '2026-01-01T00:00:00Z', 'real prompt'),
      {
        type: 'user',
        uuid: 'tr1',
        parentUuid: 'real1',
        timestamp: '2026-01-01T00:00:05Z',
        cwd: '/tmp/proj',
        sessionId: 'sess1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'output', tool_use_id: 'x' }] },
      },
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
  });

  test('malformed lines skipped', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    const lines = [
      'not json at all',
      JSON.stringify(userRec('u1', null, '2026-01-01T00:00:00Z', 'hi')),
      '{"broken": ',
      JSON.stringify({ type: 'mode', mode: 'normal' }),
    ];
    fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf-8');
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
  });

  test('response captures last assistant message text blocks', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('u1', null, '2026-01-01T00:00:00Z', 'hello there'),
      assistantRec('a1', 'u1', '2026-01-01T00:00:01Z', 'msg1', [{ type: 'thinking', thinking: '' }], USAGE),
      assistantRec('a2', 'a1', '2026-01-01T00:00:02Z', 'msg1', [{ type: 'text', text: 'first' }], USAGE),
      assistantRec('a3', 'a2', '2026-01-01T00:00:03Z', 'msg2', [{ type: 'text', text: 'second' }], USAGE),
      assistantRec('a4', 'a3', '2026-01-01T00:00:04Z', 'msg2', [{ type: 'text', text: 'third' }], USAGE),
    ]);
    const sess = parseClaudeSession(p);
    const t = sess.turns[0];
    expect(t?.response).toBe('second\nthird');
    expect(t?.responsePending).toBe(false);
  });

  test('responsePending when no assistant text yet', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('u1', null, '2026-01-01T00:00:00Z', 'hello there'),
      assistantRec(
        'a1',
        'u1',
        '2026-01-01T00:00:01Z',
        'msg1',
        [{ type: 'tool_use', name: 'Bash', input: {} }],
        USAGE,
      ),
    ]);
    const sess = parseClaudeSession(p);
    const t = sess.turns[0];
    expect(t?.response).toBe(null);
    expect(t?.responsePending).toBe(true);
  });

  test('no assistant records at all -> responsePending', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [userRec('u1', null, '2026-01-01T00:00:00Z', 'hello there')]);
    const sess = parseClaudeSession(p);
    expect(sess.turns[0]?.response).toBe(null);
    expect(sess.turns[0]?.responsePending).toBe(true);
  });

  test('compaction records are skipped (isCompactSummary and summary type)', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [
      userRec('u1', null, '2026-01-01T00:00:00Z', 'real prompt'),
      { type: 'summary', uuid: 'sum1', summary: 'a compaction summary that should never be a prompt' },
      {
        type: 'user',
        uuid: 'cs1',
        parentUuid: 'u1',
        timestamp: '2026-01-01T00:00:01Z',
        cwd: '/tmp/proj',
        sessionId: 'sess1',
        isCompactSummary: true,
        message: { role: 'user', content: 'compacted transcript text, should not count' },
      },
    ]);
    const sess = parseClaudeSession(p);
    expect(sess.turns.length).toBe(1);
    expect(sess.turns[0]?.prompt).toBe('real prompt');
  });

  test('gid format is agent:sessionId8:shortId', () => {
    const d = tmpDir();
    const p = path.join(d, 'sess1.jsonl');
    writeJsonl(p, [userRec('u1234567-aaaa-bbbb-cccc-dddddddddddd', null, '2026-01-01T00:00:00Z', 'hi')]);
    const sess = parseClaudeSession(p);
    const t = sess.turns[0];
    expect(t).toBeDefined();
    expect(t?.gid).toBe(`claude:${sess.id.slice(0, 8)}:${t?.id}`);
    expect(t?.toJSON().gid).toBe(t?.gid);
    expect(t?.toJSON().session_id).toBe(sess.id);
  });
});

// ---- codex ----

function codexMeta({
  cwd = '/tmp/codexproj',
  ts = '2026-01-01T00:00:00Z',
}: {
  cwd?: string;
  ts?: string;
} = {}) {
  return { timestamp: ts, type: 'session_meta', payload: { id: 'cxsess1', cwd, timestamp: ts } };
}

function codexEvent(ts: string, etype: string, payloadExtra: Record<string, unknown>) {
  const payload = { type: etype, ...payloadExtra };
  return { timestamp: ts, type: 'event_msg', payload };
}

function codexResponse(ts: string, rtype: string, extra: Record<string, unknown>) {
  const payload = { type: rtype, ...extra };
  return { timestamp: ts, type: 'response_item', payload };
}

describe('codex parser', () => {
  test('turn splitting and token delta', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'first prompt' }),
      codexResponse('2026-01-01T00:00:02Z', 'function_call', {
        name: 'shell',
        arguments: '{"path": "a.py"}',
      }),
      codexEvent('2026-01-01T00:00:03Z', 'token_count', {
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 5,
            total_tokens: 150,
          },
        },
      }),
      codexEvent('2026-01-01T00:00:05Z', 'task_complete', {
        turn_id: 't1',
        started_at: 1000,
        completed_at: 1005,
      }),

      codexEvent('2026-01-01T00:01:00Z', 'task_started', { turn_id: 't2' }),
      codexEvent('2026-01-01T00:01:01Z', 'user_message', { message: 'second prompt' }),
      codexEvent('2026-01-01T00:01:03Z', 'token_count', {
        info: {
          total_token_usage: {
            input_tokens: 250,
            cached_input_tokens: 20,
            output_tokens: 120,
            reasoning_output_tokens: 15,
            total_tokens: 385,
          },
        },
      }),
      codexEvent('2026-01-01T00:01:05Z', 'task_complete', {
        turn_id: 't2',
        started_at: 1060,
        completed_at: 1063,
      }),
    ]);
    const sess = parseCodexSession(p);
    expect(sess.turns.length).toBe(2);
    const [t1, t2] = sess.turns;
    expect(t1?.prompt).toBe('first prompt');
    expect(t1?.parentId).toBe(null);
    expect(t2?.parentId).toBe(t1?.fullId);
    expect(t1?.outputTokens).toBe(50);
    expect(t1?.inputTokens).toBe(100);
    expect(t1?.cacheReadTokens).toBe(10);
    expect(t1?.durationS).toBe(5.0);
    expect(t1?.toolCalls).toBe(1);
    expect(t1?.files.has('a.py')).toBeTruthy();
    // second turn's tokens should be delta, not cumulative
    expect(t2?.outputTokens).toBe(70);
    expect(t2?.inputTokens).toBe(150);
    expect(t2?.durationS).toBe(3.0);
  });

  test('skip environment_context prompt', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', {
        message: '<environment_context>foo</environment_context>',
      }),
      codexEvent('2026-01-01T00:00:02Z', 'user_message', { message: 'real prompt' }),
      codexEvent('2026-01-01T00:00:03Z', 'task_complete', {
        turn_id: 't1',
        started_at: 1000,
        completed_at: 1001,
      }),
    ]);
    const sess = parseCodexSession(p);
    expect(sess.turns.length).toBe(1);
    expect(sess.turns[0]?.prompt).toBe('real prompt');
  });

  test('malformed lines skipped', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    const lines = [
      JSON.stringify(codexMeta()),
      'garbage not json',
      JSON.stringify(codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'hi' })),
      '{"type": "unknown_thing"}',
    ];
    fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf-8');
    const sess = parseCodexSession(p);
    expect(sess.turns.length).toBe(1);
    expect(sess.turns[0]?.prompt).toBe('hi');
  });

  test('response from event_msg/agent_message', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'first prompt' }),
      codexEvent('2026-01-01T00:00:02Z', 'agent_message', { message: 'partial answer' }),
      codexEvent('2026-01-01T00:00:03Z', 'agent_message', { message: 'final answer' }),
      codexEvent('2026-01-01T00:00:04Z', 'task_complete', {
        turn_id: 't1',
        started_at: 1000,
        completed_at: 1004,
      }),
    ]);
    const sess = parseCodexSession(p);
    const t = sess.turns[0];
    expect(t?.response).toBe('final answer');
    expect(t?.responsePending).toBe(false);
  });

  test('response falls back to response_item assistant message', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'first prompt' }),
      codexResponse('2026-01-01T00:00:02Z', 'message', {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'from response_item' }],
      }),
      codexEvent('2026-01-01T00:00:03Z', 'task_complete', {
        turn_id: 't1',
        started_at: 1000,
        completed_at: 1003,
      }),
    ]);
    const sess = parseCodexSession(p);
    const t = sess.turns[0];
    expect(t?.response).toBe('from response_item');
    expect(t?.responsePending).toBe(false);
  });

  test('responsePending when turn has no assistant text yet', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'first prompt' }),
      codexResponse('2026-01-01T00:00:02Z', 'function_call', { name: 'shell', arguments: '{}' }),
    ]);
    const sess = parseCodexSession(p);
    const t = sess.turns[0];
    expect(t?.response).toBe(null);
    expect(t?.responsePending).toBe(true);
  });

  test('gid format is agent:sessionId8:shortId', () => {
    const d = tmpDir();
    const p = path.join(d, 'rollout-1.jsonl');
    writeJsonl(p, [
      codexMeta(),
      codexEvent('2026-01-01T00:00:00Z', 'task_started', { turn_id: 't1' }),
      codexEvent('2026-01-01T00:00:01Z', 'user_message', { message: 'first prompt' }),
    ]);
    const sess = parseCodexSession(p);
    const t = sess.turns[0];
    expect(t?.gid).toBe(`codex:${sess.id.slice(0, 8)}:${t?.id}`);
  });
});
