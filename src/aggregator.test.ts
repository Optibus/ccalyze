import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  buildDeepData,
  computeColdStarts,
  deriveSessionName,
  DEEP_MAX_PROMPT_DISPLAYS,
  DEEP_MAX_PROMPT_DISPLAY_CHARS,
  SESSION_NAME_MAX_CHARS,
} from './aggregator.ts';
import type { EnrichedSession } from './aggregator.ts';
import type { SessionParseResult } from './parser.ts';
import type { HistoryEntry, DateRange, SessionSummary, ParsedMessage } from './types.ts';

describe('aggregate', () => {
  const sessionResults: (SessionParseResult & { project: string; transcriptSizeMB: number })[] = [
    {
      sessionId: 'sess-1',
      project: 'demo-webapp',
      startTime: '2026-03-29T11:00:00Z',
      endTime: '2026-03-29T17:30:00Z',
      transcriptSizeMB: 126,
      promptCount: 62,
      messages: [
        {
          requestId: 'req_001',
          sessionId: 'sess-1',
          model: 'claude-opus-4-6',
          timestamp: '2026-03-29T11:00:00Z',
          isSidechain: false,
          usage: { input_tokens: 100, output_tokens: 500, cache_creation_input_tokens: 10000, cache_read_input_tokens: 50000 },
        },
        {
          requestId: 'req_002',
          sessionId: 'sess-1',
          model: 'claude-opus-4-6',
          timestamp: '2026-03-29T17:30:00Z',
          isSidechain: false,
          usage: { input_tokens: 200, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80000 },
        },
      ],
    },
    {
      sessionId: 'sess-2',
      project: 'demo-api',
      startTime: '2026-03-29T17:15:00Z',
      endTime: '2026-03-29T19:00:00Z',
      transcriptSizeMB: 5.6,
      promptCount: 6,
      messages: [
        {
          requestId: 'req_003',
          sessionId: 'sess-2',
          model: 'claude-haiku-4-5-20251001',
          timestamp: '2026-03-29T17:15:00Z',
          isSidechain: false,
          usage: { input_tokens: 50, output_tokens: 200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 20000 },
        },
      ],
    },
  ];

  const history: HistoryEntry[] = [
    { display: 'hello', timestamp: Date.parse('2026-03-29T11:00:00Z'), project: '/dev/demo-webapp', sessionId: 'sess-1' },
    { display: '/compact', timestamp: Date.parse('2026-03-29T14:00:00Z'), project: '/dev/demo-webapp', sessionId: 'sess-1' },
  ];

  const range: DateRange = { from: '2026-03-29', to: '2026-03-29' };

  it('aggregates summary totals', () => {
    const result = aggregate(sessionResults, history, range);
    assert.equal(result.summary.totalSessions, 2);
    assert.equal(result.summary.totalPrompts, 68); // 62 + 6
    assert.ok(result.summary.totalCostUSD > 0);
  });

  it('groups by model', () => {
    const result = aggregate(sessionResults, history, range);
    assert.ok('claude-opus-4-6' in result.byModel);
    assert.ok('claude-haiku-4-5-20251001' in result.byModel);
    assert.equal(result.byModel['claude-opus-4-6'].sessions, 1);
  });

  it('groups by project', () => {
    const result = aggregate(sessionResults, history, range);
    assert.equal(result.byProject.length, 2);
    const localstack = result.byProject.find(p => p.project === 'demo-webapp');
    assert.ok(localstack);
    assert.equal(localstack!.sessions, 1);
    assert.equal(localstack!.prompts, 62);
  });

  it('groups by day', () => {
    const result = aggregate(sessionResults, history, range);
    assert.equal(result.byDay.length, 1);
    assert.equal(result.byDay[0].date, '2026-03-29');
    assert.equal(result.byDay[0].sessions, 2);
  });

  it('produces session summaries with flags', () => {
    const result = aggregate(sessionResults, history, range);
    const sess1 = result.sessions.find(s => s.id === 'sess-1');
    assert.ok(sess1);
    assert.ok(sess1!.flags.includes('long-running'), 'should flag as long-running (6.5h)');
    assert.ok(sess1!.flags.includes('large-transcript'), 'should flag as large transcript (126MB)');
    // sess-1 HAS a /compact in history, so should NOT have no-compaction flag
    assert.ok(!sess1!.flags.includes('no-compaction'), 'should not flag no-compaction — has /compact');
  });

  it('omits deep data by default', () => {
    const result = aggregate(sessionResults, history, range);
    assert.equal(result.deep, undefined);
  });

  it('emits a cost-aware deep index when deep=true', () => {
    const result = aggregate(sessionResults, history, range, true);
    assert.ok(result.deep, 'deep should be populated');
    assert.equal(result.deep!.sessions.length, 2);
    // Sorted by cost descending — sess-1 (opus, big) leads.
    assert.equal(result.deep!.sessions[0].id, 'sess-1');
    assert.ok(result.deep!.sessions[0].costUSD >= result.deep!.sessions[1].costUSD);
  });

  it('carries the user prompt-displays from history into deep sessions', () => {
    const result = aggregate(sessionResults, history, range, true);
    const sess1 = result.deep!.sessions.find(s => s.id === 'sess-1')!;
    // sess-1 has 'hello' and '/compact' in history, chronological.
    assert.deepEqual(sess1.promptDisplays, ['hello', '/compact']);
    assert.equal(sess1.promptDisplaysTruncated, false);
    // sess-2 has no history entries.
    const sess2 = result.deep!.sessions.find(s => s.id === 'sess-2')!;
    assert.deepEqual(sess2.promptDisplays, []);
  });

  it('collapses the model timeline and defaults transcripts', () => {
    const result = aggregate(sessionResults, history, range, true);
    const sess1 = result.deep!.sessions.find(s => s.id === 'sess-1')!;
    // Both sess-1 messages are opus → a single timeline entry.
    assert.equal(sess1.modelTimeline.length, 1);
    assert.equal(sess1.modelTimeline[0].model, 'claude-opus-4-6');
    // A single model means zero switches.
    assert.equal(sess1.modelSwitchCount, 0);
    // These fixtures set no filePaths → empty transcripts.
    assert.deepEqual(sess1.transcripts, []);
  });
});

describe('aggregate — compaction', () => {
  const range: DateRange = { from: '2026-03-29', to: '2026-03-29' };

  function longSession(over: Partial<SessionParseResult & { project: string; transcriptSizeMB: number }> = {}) {
    return {
      sessionId: 'sess-a',
      project: 'proj',
      startTime: '2026-03-29T10:00:00Z',
      endTime: '2026-03-29T11:00:00Z',
      transcriptSizeMB: 1,
      promptCount: 40, // over the 30-prompt no-compaction floor
      messages: [],
      ...over,
    };
  }

  it('classifies manual over auto when a session has both', () => {
    const history: HistoryEntry[] = [
      { display: '/compact', timestamp: Date.parse('2026-03-29T10:30:00Z'), project: 'p', sessionId: 'sess-a' },
    ];
    const result = aggregate([longSession({ autoCompactions: 2 })], history, range);
    assert.equal(result.sessions[0].compaction, 'manual');
    assert.equal(result.sessions[0].autoCompactions, 2);
  });

  it('classifies auto when only the wall was hit, and does not flag no-compaction', () => {
    const result = aggregate([longSession({ autoCompactions: 1 })], [], range);
    assert.equal(result.sessions[0].compaction, 'auto');
    assert.ok(
      !result.sessions[0].flags.includes('no-compaction'),
      'a session that hit the auto-compact wall was not left unmanaged',
    );
  });

  it('classifies none, and still flags no-compaction, when neither happened', () => {
    const result = aggregate([longSession()], [], range);
    assert.equal(result.sessions[0].compaction, 'none');
    assert.ok(result.sessions[0].flags.includes('no-compaction'));
  });

  it('reads autoCompactions as 0 when the parser omits it (older transcripts)', () => {
    const { autoCompactions, ...withoutField } = longSession();
    const result = aggregate([withoutField], [], range);
    assert.equal(result.sessions[0].autoCompactions, 0);
    assert.equal(result.sessions[0].compaction, 'none');
  });
});

describe('buildDeepData', () => {
  const range: DateRange = { from: '2026-03-29', to: '2026-03-29' };

  function makeSession(over: Partial<EnrichedSession> = {}): EnrichedSession {
    return {
      sessionId: 'sess-a',
      project: 'proj',
      startTime: '2026-03-29T10:00:00Z',
      endTime: '2026-03-29T11:00:00Z',
      transcriptSizeMB: 1,
      promptCount: 1,
      messages: [],
      ...over,
    };
  }

  function makeSummary(over: Partial<SessionSummary> = {}): SessionSummary {
    return {
      id: 'sess-a',
      name: 'a session',
      project: 'proj',
      primaryModel: 'claude-opus-4-6',
      startTime: '2026-03-29T10:00:00Z',
      endTime: '2026-03-29T11:00:00Z',
      durationMinutes: 60,
      prompts: 1,
      costUSD: 1,
      transcriptSizeMB: 1,
      flags: [],
      cacheReadRatio: 0.96,
      coldStarts: 0,
      coldStartExtraUSD: 0,
      compaction: 'none',
      autoCompactions: 0,
      ...over,
    };
  }

  describe('transcript grouping', () => {
    /** Rebuild every full path from the grouped shape. */
    function flatten(groups: { dir: string; files: string[] }[]): string[] {
      return groups.flatMap((g) => g.files.map((f) => `${g.dir}/${f}`));
    }

    it('states a shared directory once for many sibling transcripts', () => {
      const dir = '/Users/x/.claude/projects/-proj/sess-a/subagents';
      const deep = buildDeepData(
        [makeSession({ filePaths: [`${dir}/agent-one.jsonl`, `${dir}/agent-two.jsonl`] })],
        [makeSummary()],
        [],
      );
      assert.deepEqual(deep.sessions[0].transcripts, [
        { dir, files: ['agent-one.jsonl', 'agent-two.jsonl'] },
      ]);
    });

    it('is lossless — dir/file rebuilds every original path', () => {
      const originals = [
        '/Users/x/.claude/projects/-proj/sess-a.jsonl',
        '/Users/x/.claude/projects/-proj/sess-a/subagents/agent-one.jsonl',
        '/Users/x/.claude/projects/-proj/sess-a/subagents/agent-two.jsonl',
      ];
      const deep = buildDeepData(
        [makeSession({ filePaths: originals })],
        [makeSummary()],
        [],
      );
      assert.deepEqual(flatten(deep.sessions[0].transcripts).sort(), [...originals].sort());
    });

    it('groups transcripts spanning several project directories', () => {
      // The real merge case: one session id with transcripts under two project dirs.
      const originals = [
        '/c/projects/-projA/sess-a.jsonl',
        '/c/projects/-projA/sess-a/subagents/one.jsonl',
        '/c/projects/-projB/sess-a.jsonl',
      ];
      const groups = buildDeepData(
        [makeSession({ filePaths: originals })],
        [makeSummary()],
        [],
      ).sessions[0].transcripts;
      assert.equal(groups.length, 3, 'three distinct directories');
      assert.deepEqual(flatten(groups).sort(), [...originals].sort());
      // Each directory is stated exactly once.
      assert.equal(new Set(groups.map((g) => g.dir)).size, groups.length);
    });

    it('handles a single transcript', () => {
      const deep = buildDeepData(
        [makeSession({ filePaths: ['/a/b/c/sess-a.jsonl'] })],
        [makeSummary()],
        [],
      );
      assert.deepEqual(deep.sessions[0].transcripts, [
        { dir: '/a/b/c', files: ['sess-a.jsonl'] },
      ]);
    });

    it('keeps sibling-looking directories distinct', () => {
      // /a/session-10 and /a/session-2 share the string "/a/session-" but are
      // different directories and must not be merged.
      const groups = buildDeepData(
        [makeSession({ filePaths: ['/a/session-10/t.jsonl', '/a/session-2/t.jsonl'] })],
        [makeSummary()],
        [],
      ).sessions[0].transcripts;
      assert.deepEqual(groups, [
        { dir: '/a/session-10', files: ['t.jsonl'] },
        { dir: '/a/session-2', files: ['t.jsonl'] },
      ]);
    });
  });

  describe('prompt-display caps', () => {
    it('truncates an over-long individual display and marks it', () => {
      const long = 'x'.repeat(DEEP_MAX_PROMPT_DISPLAY_CHARS + 500);
      const history: HistoryEntry[] = [
        { display: long, timestamp: 1, project: '/p', sessionId: 'sess-a' },
      ];
      const deep = buildDeepData([makeSession()], [makeSummary()], history);
      const [display] = deep.sessions[0].promptDisplays;
      assert.ok(
        display.length <= DEEP_MAX_PROMPT_DISPLAY_CHARS + 20,
        `display should be capped, got ${display.length}`,
      );
      assert.ok(display.startsWith('xxx'), 'should keep the head of the prompt');
      assert.ok(display.endsWith('…[truncated]'), 'should mark the truncation');
    });

    it('leaves a short display byte-identical', () => {
      const history: HistoryEntry[] = [
        { display: 'fix the parser', timestamp: 1, project: '/p', sessionId: 'sess-a' },
      ];
      const deep = buildDeepData([makeSession()], [makeSummary()], history);
      assert.deepEqual(deep.sessions[0].promptDisplays, ['fix the parser']);
    });

    it('caps the display count and flags it', () => {
      const history: HistoryEntry[] = Array.from(
        { length: DEEP_MAX_PROMPT_DISPLAYS + 10 },
        (_, i) => ({
          display: `prompt ${i}`,
          timestamp: i,
          project: '/p',
          sessionId: 'sess-a',
        }),
      );
      const deep = buildDeepData([makeSession()], [makeSummary()], history);
      const s = deep.sessions[0];
      assert.equal(s.promptDisplays.length, DEEP_MAX_PROMPT_DISPLAYS);
      assert.equal(s.promptDisplaysTruncated, true);
      assert.equal(s.promptDisplays[0], 'prompt 0', 'keeps the earliest prompts');
    });
  });

  describe('modelSwitchCount', () => {
    const noUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    it('counts switches, not messages', () => {
      const session = makeSession({
        messages: [
          { requestId: 'r1', sessionId: 'sess-a', model: 'opus', timestamp: '2026-03-29T10:00:00Z', isSidechain: false, usage: noUsage },
          { requestId: 'r2', sessionId: 'sess-a', model: 'opus', timestamp: '2026-03-29T10:05:00Z', isSidechain: false, usage: noUsage },
          { requestId: 'r3', sessionId: 'sess-a', model: 'haiku', timestamp: '2026-03-29T10:10:00Z', isSidechain: false, usage: noUsage },
          { requestId: 'r4', sessionId: 'sess-a', model: 'opus', timestamp: '2026-03-29T10:15:00Z', isSidechain: false, usage: noUsage },
        ],
      });
      const deep = buildDeepData([session], [makeSummary()], []);
      const s = deep.sessions[0];
      // opus → haiku → opus = 3 timeline entries, 2 switches.
      assert.equal(s.modelTimeline.length, 3);
      assert.equal(s.modelSwitchCount, 2);
    });

    it('reports zero switches for an empty session', () => {
      const deep = buildDeepData([makeSession()], [makeSummary()], []);
      assert.equal(deep.sessions[0].modelSwitchCount, 0);
      assert.deepEqual(deep.sessions[0].modelTimeline, []);
    });
  });

  it('describes the real transcripts shape in the agent-facing note', () => {
    // The note is instructions the consuming agent follows literally. It drifted
    // once already — describing the rejected {baseDir, files[]} shape while the
    // code emitted [{dir, files[]}], which would break every fusion read.
    const { note } = buildDeepData([makeSession()], [makeSummary()], []);
    assert.doesNotMatch(note, /baseDir/, 'note must not reference the rejected shape');
    assert.match(note, /dir/, 'note should describe the {dir, files} grouping');
  });

  it('falls back safely when a session has no matching summary', () => {
    const deep = buildDeepData([makeSession({ sessionId: 'orphan' })], [], []);
    const s = deep.sessions[0];
    assert.equal(s.primaryModel, 'unknown');
    assert.equal(s.costUSD, 0);
    assert.equal(s.modelSwitchCount, 0);
    assert.deepEqual(s.transcripts, []);
    assert.ok(range.from, 'range fixture referenced');
  });
});

describe('deriveSessionName', () => {
  it('collapses a multi-line prompt into one line', () => {
    assert.equal(deriveSessionName('fix the parser\n\n  it double counts  '), 'fix the parser it double counts');
  });

  it('truncates a long prompt at the cap', () => {
    const name = deriveSessionName('x'.repeat(200));
    assert.equal(name.length, SESSION_NAME_MAX_CHARS + 1, 'capped text plus the ellipsis');
    assert.ok(name.endsWith('…'));
  });

  it('keeps a slash command as-is — it identifies the session just as well', () => {
    assert.equal(deriveSessionName('/compact'), '/compact');
  });
});

describe('computeColdStarts', () => {
  const usage = (cacheWrite: number) => ({
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: 0,
  });
  const msg = (minutesFromStart: number, cacheWrite: number): ParsedMessage => ({
    requestId: `r${minutesFromStart}`,
    sessionId: 'sess-a',
    model: 'claude-opus-5',
    timestamp: new Date(Date.parse('2026-03-29T10:00:00Z') + minutesFromStart * 60_000).toISOString(),
    isSidechain: false,
    usage: usage(cacheWrite),
  });

  it('counts a large cache write after a long idle gap', () => {
    const { count } = computeColdStarts([msg(0, 0), msg(180, 100_000)]);
    assert.equal(count, 1);
  });

  it('ignores a large cache write with no idle gap before it', () => {
    // Normal incremental caching mid-conversation is not a cold start.
    const { count } = computeColdStarts([msg(0, 0), msg(5, 100_000)]);
    assert.equal(count, 0);
  });

  it('ignores a long gap that resumed cheaply', () => {
    // A gap only costs when there was a big context to rebuild.
    const { count } = computeColdStarts([msg(0, 0), msg(180, 500)]);
    assert.equal(count, 0);
  });

  it('prices only the premium over a warm cache, not the whole rebuild', () => {
    // Opus input is $5/M, so a cache write is $6.25/M and a cache read $0.50/M.
    // 1M rebuilt tokens therefore cost $5.75 more than they would have warm.
    const { extraUSD } = computeColdStarts([msg(0, 0), msg(180, 1_000_000)]);
    assert.equal(extraUSD, 5.75);
  });

  it('reads messages in time order regardless of input order', () => {
    const { count } = computeColdStarts([msg(180, 100_000), msg(0, 0)]);
    assert.equal(count, 1);
  });
});

describe('aggregate — cache metrics', () => {
  const range: DateRange = { from: '2026-03-29', to: '2026-03-29' };

  function session(over: Partial<EnrichedSession> = {}): EnrichedSession {
    return {
      sessionId: 'sess-a',
      project: 'proj',
      startTime: '2026-03-29T10:00:00Z',
      endTime: '2026-03-29T11:00:00Z',
      transcriptSizeMB: 1,
      promptCount: 1,
      messages: [],
      ...over,
    };
  }

  const message = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
    requestId: 'r1',
    sessionId: 'sess-a',
    model: 'claude-opus-5',
    timestamp: '2026-03-29T10:00:00Z',
    isSidechain: false,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
  });

  it('computes the cache-read share of input-side tokens', () => {
    const result = aggregate([session({
      messages: [message({
        usage: { input_tokens: 100, output_tokens: 9_999, cache_creation_input_tokens: 100, cache_read_input_tokens: 800 },
      })],
    })], [], range);
    // 800 / (100 + 800 + 100) = 0.8 — output tokens are excluded, since they are
    // never cacheable and would only dilute the signal.
    assert.equal(result.summary.cacheReadRatio, 0.8);
    assert.equal(result.sessions[0].cacheReadRatio, 0.8);
  });

  it('reports a zero ratio rather than dividing by zero', () => {
    const result = aggregate([session({ messages: [message()] })], [], range);
    assert.equal(result.summary.cacheReadRatio, 0);
  });

  it('measures what share of tokens ran inside subagents', () => {
    const result = aggregate([session({
      messages: [
        message({ requestId: 'main', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 250 } }),
        message({ requestId: 'sub', isSidechain: true, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 750 } }),
      ],
    })], [], range);
    assert.equal(result.summary.sidechainTokenShare, 0.75);
  });

  it('names a session after the first prompt the user typed', () => {
    const history: HistoryEntry[] = [
      { display: 'second thing', timestamp: Date.parse('2026-03-29T10:30:00Z'), project: 'p', sessionId: 'sess-a' },
      { display: 'make the parser dedupe by requestId', timestamp: Date.parse('2026-03-29T10:00:00Z'), project: 'p', sessionId: 'sess-a' },
    ];
    const result = aggregate([session({ messages: [message()] })], history, range);
    assert.equal(result.sessions[0].name, 'make the parser dedupe by requestId');
  });

  it('leaves the name empty when history has nothing for the session', () => {
    const result = aggregate([session({ messages: [message()] })], [], range);
    assert.equal(result.sessions[0].name, '');
  });
});

describe('buildDeepData — main-thread churn', () => {
  const message = (over: Partial<ParsedMessage> = {}): ParsedMessage => ({
    requestId: 'r1',
    sessionId: 'sess-a',
    model: 'claude-opus-5',
    timestamp: '2026-03-29T10:00:00Z',
    isSidechain: false,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
  });

  const base: EnrichedSession = {
    sessionId: 'sess-a', project: 'proj',
    startTime: '2026-03-29T10:00:00Z', endTime: '2026-03-29T11:00:00Z',
    transcriptSizeMB: 1, promptCount: 1, messages: [],
  };

  it('ignores model changes that happened inside subagents', () => {
    // This is the whole point of the split: subagents alternate models
    // constantly and never touch the main conversation's cached prefix.
    const deep = buildDeepData([{ ...base, messages: [
      message({ requestId: 'a', model: 'claude-opus-5', timestamp: '2026-03-29T10:00:00Z' }),
      message({ requestId: 'b', model: 'claude-haiku-4-5', timestamp: '2026-03-29T10:01:00Z', isSidechain: true }),
      message({ requestId: 'c', model: 'claude-sonnet-5', timestamp: '2026-03-29T10:02:00Z', isSidechain: true }),
      message({ requestId: 'd', model: 'claude-opus-5', timestamp: '2026-03-29T10:03:00Z' }),
    ] }], [], []);
    assert.equal(deep.sessions[0].mainModelSwitchCount, 0);
    assert.ok(deep.sessions[0].modelSwitchCount > 0, 'the all-inclusive count still sees them');
  });

  it('counts a genuine mid-session model switch on the main thread', () => {
    const deep = buildDeepData([{ ...base, messages: [
      message({ requestId: 'a', model: 'claude-opus-5', timestamp: '2026-03-29T10:00:00Z' }),
      message({ requestId: 'b', model: 'claude-haiku-4-5', timestamp: '2026-03-29T10:01:00Z' }),
    ] }], [], []);
    assert.equal(deep.sessions[0].mainModelSwitchCount, 1);
  });
});
