import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSessionFile, parseHistoryFile } from './parser.ts';

const TMP = path.join(os.tmpdir(), 'ccalyze-test-' + Date.now());

before(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('parseSessionFile', () => {
  it('extracts usage from assistant messages, deduplicating by requestId', async () => {
    const sessionFile = path.join(TMP, 'session.jsonl');
    const lines = [
      // Streaming update 1 (partial)
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_001',
        sessionId: 'sess-1',
        timestamp: '2026-03-29T11:00:00Z',
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          usage: {
            input_tokens: 3,
            output_tokens: 9,
            cache_creation_input_tokens: 33888,
            cache_read_input_tokens: 10426,
          },
        },
      }),
      // Streaming update 2 (final — higher output_tokens)
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_001',
        sessionId: 'sess-1',
        timestamp: '2026-03-29T11:00:01Z',
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          usage: {
            input_tokens: 3,
            output_tokens: 173,
            cache_creation_input_tokens: 33888,
            cache_read_input_tokens: 10426,
          },
        },
      }),
      // Different request
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_002',
        sessionId: 'sess-1',
        timestamp: '2026-03-29T11:05:00Z',
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          usage: {
            input_tokens: 5,
            output_tokens: 245,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 44000,
          },
        },
      }),
      // Non-assistant line (should be skipped)
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        timestamp: '2026-03-29T11:04:00Z',
        message: { role: 'user', content: 'hello' },
      }),
    ];
    fs.writeFileSync(sessionFile, lines.join('\n') + '\n');

    const result = await parseSessionFile(sessionFile);

    assert.equal(result.messages.length, 2, 'should deduplicate to 2 requests');
    assert.equal(result.messages[0].requestId, 'req_001');
    assert.equal(result.messages[0].usage.output_tokens, 173, 'should take max output_tokens');
    assert.equal(result.messages[1].requestId, 'req_002');
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(result.startTime, '2026-03-29T11:00:00Z');
    assert.equal(result.endTime, '2026-03-29T11:05:00Z');
  });

  it('returns empty result for file with no assistant messages', async () => {
    const sessionFile = path.join(TMP, 'empty-session.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'user',
      sessionId: 'sess-2',
      timestamp: '2026-03-29T12:00:00Z',
      message: { role: 'user', content: 'hello' },
    }) + '\n');

    const result = await parseSessionFile(sessionFile);
    assert.equal(result.messages.length, 0);
  });

  it('marks subagent messages, and treats an absent flag as main-thread', async () => {
    // Subagent transcripts live in their own files and set isSidechain on every
    // entry; older transcripts omit the field entirely. Both must read correctly,
    // because the main-thread churn signal depends on telling them apart.
    const sessionFile = path.join(TMP, 'sidechain.jsonl');
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'assistant', requestId: 'main', sessionId: 's', timestamp: '2026-03-29T11:00:00Z', message: { model: 'claude-opus-5', usage } }),
      JSON.stringify({ type: 'assistant', requestId: 'sub', sessionId: 's', timestamp: '2026-03-29T11:00:01Z', isSidechain: true, message: { model: 'claude-haiku-4-5', usage } }),
      JSON.stringify({ type: 'assistant', requestId: 'explicit-main', sessionId: 's', timestamp: '2026-03-29T11:00:02Z', isSidechain: false, message: { model: 'claude-opus-5', usage } }),
    ].join('\n') + '\n');

    const result = await parseSessionFile(sessionFile);
    const byId = Object.fromEntries(result.messages.map((m) => [m.requestId, m.isSidechain]));
    assert.deepEqual(byId, { main: false, sub: true, 'explicit-main': false });
  });

  it('counts an auto-compact continuation message, and does not count it as a prompt', async () => {
    // Claude Code injects this synthetic type:"user" message when context
    // fills up mid-session — it is not something the person typed.
    const sessionFile = path.join(TMP, 'auto-compact.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-03-29T11:00:00Z', message: { role: 'user', content: 'real prompt' } }),
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-03-29T11:05:00Z', isCompactSummary: true, compactMetadata: {}, message: { role: 'user', content: 'This session is being continued...' } }),
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-03-29T11:06:00Z', message: { role: 'user', content: 'another real prompt' } }),
    ].join('\n') + '\n');

    const result = await parseSessionFile(sessionFile);
    assert.equal(result.promptCount, 2, 'the synthetic continuation message must not count as a prompt');
    assert.equal(result.autoCompactions, 1);
  });

  it('reads autoCompactions as 0 on a transcript that never auto-compacted', async () => {
    const sessionFile = path.join(TMP, 'no-auto-compact.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({
      type: 'user', sessionId: 's', timestamp: '2026-03-29T11:00:00Z', message: { role: 'user', content: 'hi' },
    }) + '\n');

    const result = await parseSessionFile(sessionFile);
    assert.equal(result.autoCompactions, 0);
  });

  it('extracts file paths from Edit/Write/MultiEdit tool_use blocks, ignoring other tools', async () => {
    const sessionFile = path.join(TMP, 'edits.jsonl');
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'assistant', requestId: 'r1', sessionId: 's', timestamp: '2026-03-29T11:00:00Z',
        message: {
          model: 'claude-opus-5', usage,
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant', requestId: 'r2', sessionId: 's', timestamp: '2026-03-29T11:01:00Z',
        message: {
          model: 'claude-opus-5', usage,
          content: [
            { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/b.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/c.ts' } },
          ],
        },
      }),
    ].join('\n') + '\n');

    const result = await parseSessionFile(sessionFile);
    const byId = Object.fromEntries(result.messages.map((m) => [m.requestId, m.editedFiles]));
    assert.deepEqual(byId, { r1: ['/a.ts'], r2: ['/b.ts', '/c.ts'] });
  });

  it('keeps the fuller edited-files list across a streaming update, never clobbering with empty', async () => {
    const sessionFile = path.join(TMP, 'edits-stream.jsonl');
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    fs.writeFileSync(sessionFile, [
      // Partial update: tool_use not yet in content.
      JSON.stringify({ type: 'assistant', requestId: 'r1', sessionId: 's', timestamp: '2026-03-29T11:00:00Z', message: { model: 'claude-opus-5', usage, content: [] } }),
      // Final update: full content.
      JSON.stringify({
        type: 'assistant', requestId: 'r1', sessionId: 's', timestamp: '2026-03-29T11:00:01Z',
        message: { model: 'claude-opus-5', usage, content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }] },
      }),
    ].join('\n') + '\n');

    const result = await parseSessionFile(sessionFile);
    assert.deepEqual(result.messages[0].editedFiles, ['/a.ts']);
  });
});

describe('parseHistoryFile', () => {
  it('extracts prompts within date range', async () => {
    const historyFile = path.join(TMP, 'history.jsonl');
    const lines = [
      JSON.stringify({ display: 'hello', timestamp: 1774780000000, project: '/dev/proj-a', sessionId: 'sess-1' }),
      JSON.stringify({ display: '/compact', timestamp: 1774780100000, project: '/dev/proj-a', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'fix bug', timestamp: 1774780200000, project: '/dev/proj-b', sessionId: 'sess-2' }),
      // Old entry (outside range)
      JSON.stringify({ display: 'old', timestamp: 1700000000000, project: '/dev/proj-a', sessionId: 'sess-old' }),
    ];
    fs.writeFileSync(historyFile, lines.join('\n') + '\n');

    const result = await parseHistoryFile(historyFile, new Date('2026-03-29'), new Date('2026-03-30'));

    assert.equal(result.length, 3);
    assert.equal(result[0].display, 'hello');
    assert.equal(result[1].display, '/compact');
  });

  it('identifies /compact commands per session', async () => {
    const historyFile = path.join(TMP, 'history2.jsonl');
    const lines = [
      JSON.stringify({ display: '/compact', timestamp: 1774780000000, project: '/dev/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: 'do stuff', timestamp: 1774780100000, project: '/dev/proj', sessionId: 'sess-1' }),
      JSON.stringify({ display: '/compact', timestamp: 1774780200000, project: '/dev/proj', sessionId: 'sess-1' }),
    ];
    fs.writeFileSync(historyFile, lines.join('\n') + '\n');

    const result = await parseHistoryFile(historyFile, new Date('2026-03-29'), new Date('2026-03-30'));
    const compacts = result.filter(e => e.display.startsWith('/compact'));
    assert.equal(compacts.length, 2);
  });
});
