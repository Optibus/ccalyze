import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { discoverSessionFiles, mergeSessions } from './discovery.ts';
import type { EnrichedSession } from './aggregator.ts';
import type { ParsedMessage } from './types.ts';

describe('discoverSessionFiles', () => {
  let root: string;
  const from = new Date(Date.now() - 86_400_000);
  const to = new Date();

  before(() => {
    root = mkdtempSync(resolve(tmpdir(), 'ccalyze-discovery-'));
    const projects = resolve(root, 'projects');
    // A real project dir with one main transcript and one subagent transcript.
    const real = resolve(projects, '-Users-x-dev-AIStuff');
    mkdirSync(resolve(real, 'sess-a', 'subagents'), { recursive: true });
    writeFileSync(resolve(real, 'sess-a.jsonl'), '{}\n');
    writeFileSync(resolve(real, 'sess-a', 'subagents', 'agent-1.jsonl'), '{}\n');

    // The git-aware-history case: a worktree slug symlinked to the same dir, so
    // every transcript inside is reachable through a second path.
    symlinkSync(real, resolve(projects, '-Users-x-orca-worktree-AIStuff'));

    // A hardlinked transcript in an unrelated project dir — same inode, different path.
    const other = resolve(projects, '-Users-x-dev-Other');
    mkdirSync(other, { recursive: true });
    linkSync(resolve(real, 'sess-a.jsonl'), resolve(other, 'sess-a.jsonl'));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('returns each physical transcript once despite symlinked project dirs', () => {
    const found = discoverSessionFiles(root, from, to);
    // 2 physical files exist (main + subagent), reachable via several paths.
    assert.equal(found.length, 2, `expected 2 physical files, got ${found.length}`);
  });

  it('does not return the same path twice', () => {
    const found = discoverSessionFiles(root, from, to);
    assert.equal(new Set(found.map((f) => f.filePath)).size, found.length);
  });

  it('still finds both a main and a subagent transcript', () => {
    const found = discoverSessionFiles(root, from, to);
    assert.equal(found.filter((f) => f.filePath.includes('/subagents/')).length, 1);
    assert.equal(found.filter((f) => !f.filePath.includes('/subagents/')).length, 1);
  });

  it('excludes transcripts whose mtime is outside the range', () => {
    const future = new Date(Date.now() + 86_400_000);
    assert.deepEqual(discoverSessionFiles(root, future, future), []);
  });
});

describe('mergeSessions', () => {
  function msg(requestId: string, over: Partial<ParsedMessage> = {}): ParsedMessage {
    return {
      requestId,
      sessionId: 'sess-a',
      model: 'claude-opus-4-6',
      timestamp: '2026-03-29T10:00:00Z',
      isSidechain: false,
      editedFiles: [],
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...over,
    };
  }

  function session(over: Partial<EnrichedSession> = {}): EnrichedSession {
    return {
      sessionId: 'sess-a',
      project: 'AIStuff',
      startTime: '2026-03-29T10:00:00Z',
      endTime: '2026-03-29T11:00:00Z',
      transcriptSizeMB: 10,
      promptCount: 5,
      messages: [msg('req-1')],
      filePaths: ['/p/sess-a.jsonl'],
      ...over,
    };
  }

  it('counts a duplicated requestId once', () => {
    // The same physical transcript reaching merge twice must not double the tokens.
    const merged = mergeSessions([
      session({ filePaths: ['/a/sess-a.jsonl'] }),
      session({ filePaths: ['/b/sess-a.jsonl'] }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].messages.length, 1, 'duplicate requestId must collapse');
  });

  it('keeps distinct requestIds from subagent transcripts', () => {
    const merged = mergeSessions([
      session({ messages: [msg('req-1')] }),
      session({ messages: [msg('sub-1'), msg('sub-2')], filePaths: ['/p/subagents/a.jsonl'] }),
    ]);
    assert.equal(merged[0].messages.length, 3);
    assert.deepEqual(
      merged[0].messages.map((m) => m.requestId).sort(),
      ['req-1', 'sub-1', 'sub-2'],
    );
  });

  it('takes the max of each token field for a duplicated requestId', () => {
    // Mirrors the parser's own dedup rule: streaming updates grow, so max wins.
    const small = msg('req-1', {
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    });
    const large = msg('req-1', {
      usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
    });
    const merged = mergeSessions([session({ messages: [small] }), session({ messages: [large] })]);
    assert.equal(merged[0].messages.length, 1);
    assert.deepEqual(merged[0].messages[0].usage, {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 50,
    });
  });

  it('keeps separate sessions separate', () => {
    const merged = mergeSessions([
      session({ sessionId: 'sess-a' }),
      session({ sessionId: 'sess-b', messages: [msg('req-9', { sessionId: 'sess-b' })] }),
    ]);
    assert.equal(merged.length, 2);
  });

  it('unions filePaths and widens the time window', () => {
    const merged = mergeSessions([
      session({ startTime: '2026-03-29T10:00:00Z', endTime: '2026-03-29T11:00:00Z', filePaths: ['/a.jsonl'] }),
      session({
        startTime: '2026-03-29T09:00:00Z',
        endTime: '2026-03-29T12:00:00Z',
        filePaths: ['/b.jsonl'],
        messages: [msg('req-2')],
      }),
    ]);
    assert.equal(merged[0].startTime, '2026-03-29T09:00:00Z');
    assert.equal(merged[0].endTime, '2026-03-29T12:00:00Z');
    assert.deepEqual(merged[0].filePaths, ['/a.jsonl', '/b.jsonl']);
  });

  it('does not double promptCount or transcriptSizeMB for an identical filePath', () => {
    const merged = mergeSessions([
      session({ filePaths: ['/same.jsonl'], promptCount: 5, transcriptSizeMB: 10 }),
      session({ filePaths: ['/same.jsonl'], promptCount: 5, transcriptSizeMB: 10 }),
    ]);
    assert.equal(merged[0].promptCount, 5);
    assert.equal(merged[0].transcriptSizeMB, 10);
    assert.deepEqual(merged[0].filePaths, ['/same.jsonl']);
  });

  it('sums promptCount across genuinely different transcripts', () => {
    const merged = mergeSessions([
      session({ filePaths: ['/main.jsonl'], promptCount: 5, transcriptSizeMB: 10 }),
      session({
        filePaths: ['/subagents/a.jsonl'],
        promptCount: 3,
        transcriptSizeMB: 2,
        messages: [msg('sub-1')],
      }),
    ]);
    assert.equal(merged[0].promptCount, 8);
    assert.equal(merged[0].transcriptSizeMB, 12);
  });
});
