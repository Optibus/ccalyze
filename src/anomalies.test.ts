import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAnomalies,
  LOW_CACHE_RATIO_THRESHOLD,
  LOW_CACHE_MIN_COST_USD,
  COLD_START_MIN_EVENTS,
} from './anomalies.ts';
import type { CcalyzeOutput, SessionSummary } from './types.ts';

/**
 * A well-behaved session. Defaults are deliberately *healthy* (high cache ratio,
 * no cold starts) so a test that adds an anomaly-worthy field is the only reason
 * an anomaly fires.
 */
function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    name: 'do the thing',
    project: 'proj',
    primaryModel: 'claude-opus-4-6',
    startTime: '2026-03-29T11:00:00Z',
    endTime: '2026-03-29T14:00:00Z',
    durationMinutes: 180,
    prompts: 62,
    costUSD: 22.5,
    transcriptSizeMB: 126,
    flags: [],
    cacheReadRatio: 0.96,
    coldStarts: 0,
    coldStartExtraUSD: 0,
    compaction: 'none',
    autoCompactions: 0,
    ...over,
  };
}

function makeOutput(overrides: Partial<CcalyzeOutput> = {}): CcalyzeOutput {
  return {
    range: { from: '2026-03-29', to: '2026-03-29' },
    summary: {
      totalCostUSD: 45, totalInputTokens: 0, totalOutputTokens: 0,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalSessions: 2,
      totalPrompts: 70, cacheReadRatio: 0.96, sidechainTokenShare: 0,
    },
    byDay: [{ date: '2026-03-29', costUSD: 45, sessions: 2, prompts: 70, tokensByModel: {} }],
    byModel: {},
    byProject: [],
    sessions: [],
    anomalies: [],
    tips: [],
    ...overrides,
  };
}

describe('detectAnomalies', () => {
  it('detects no-compaction sessions', () => {
    const output = makeOutput({
      sessions: [session({ flags: ['no-compaction', 'large-transcript'] })],
    });
    const anomalies = detectAnomalies(output);
    const noCompact = anomalies.find(a => a.type === 'session_no_compaction');
    assert.ok(noCompact);
    assert.equal(noCompact!.severity, 'high');
    assert.equal(noCompact!.sessionId, 'sess-1');
  });

  it('detects long-running sessions', () => {
    const output = makeOutput({
      sessions: [session({
        endTime: '2026-03-29T17:00:00Z', durationMinutes: 360, prompts: 10,
        costUSD: 5, transcriptSizeMB: 10, flags: ['long-running'],
      })],
    });
    const anomalies = detectAnomalies(output);
    assert.ok(anomalies.find(a => a.type === 'long_running_session'));
  });

  it('detects large transcripts', () => {
    const output = makeOutput({
      sessions: [session({
        endTime: '2026-03-29T12:00:00Z', durationMinutes: 60, prompts: 5,
        costUSD: 5, transcriptSizeMB: 80, flags: ['large-transcript'],
      })],
    });
    const anomalies = detectAnomalies(output);
    assert.ok(anomalies.find(a => a.type === 'large_transcript'));
  });

  it('detects concurrent opus sessions', () => {
    const output = makeOutput({
      sessions: [
        session({ id: 's1', project: 'p1', startTime: '2026-03-29T11:00:00Z', endTime: '2026-03-29T13:00:00Z', durationMinutes: 120, prompts: 10, costUSD: 5, transcriptSizeMB: 5 }),
        session({ id: 's2', project: 'p2', startTime: '2026-03-29T11:30:00Z', endTime: '2026-03-29T14:00:00Z', durationMinutes: 150, prompts: 10, costUSD: 5, transcriptSizeMB: 5 }),
        session({ id: 's3', project: 'p3', startTime: '2026-03-29T12:00:00Z', endTime: '2026-03-29T15:00:00Z', durationMinutes: 180, prompts: 10, costUSD: 5, transcriptSizeMB: 5 }),
      ],
    });
    const anomalies = detectAnomalies(output);
    assert.ok(anomalies.find(a => a.type === 'concurrent_opus'));
  });

  it('detects cost spike', () => {
    const output = makeOutput({
      byDay: [
        { date: '2026-03-23', costUSD: 5, sessions: 2, prompts: 10, tokensByModel: {} },
        { date: '2026-03-24', costUSD: 6, sessions: 2, prompts: 12, tokensByModel: {} },
        { date: '2026-03-25', costUSD: 4, sessions: 1, prompts: 8, tokensByModel: {} },
        { date: '2026-03-26', costUSD: 5, sessions: 2, prompts: 10, tokensByModel: {} },
        { date: '2026-03-27', costUSD: 7, sessions: 3, prompts: 15, tokensByModel: {} },
        { date: '2026-03-28', costUSD: 5, sessions: 2, prompts: 10, tokensByModel: {} },
        { date: '2026-03-29', costUSD: 45, sessions: 8, prompts: 70, tokensByModel: {} },
      ],
    });
    const anomalies = detectAnomalies(output);
    const spike = anomalies.find(a => a.type === 'cost_spike');
    assert.ok(spike);
    assert.equal(spike!.severity, 'high');
  });

  it('returns empty for well-behaved usage', () => {
    const output = makeOutput({
      sessions: [session({
        id: 's1', project: 'p1', endTime: '2026-03-29T11:30:00Z',
        durationMinutes: 30, prompts: 5, costUSD: 2, transcriptSizeMB: 1,
      })],
    });
    const anomalies = detectAnomalies(output);
    assert.equal(anomalies.length, 0);
  });
});

describe('detectAnomalies — cache efficiency', () => {
  it('flags an expensive session that served little of its input from cache', () => {
    const found = detectAnomalies(makeOutput({
      sessions: [session({ costUSD: 40, cacheReadRatio: 0.62 })],
    }));
    const low = found.find((a) => a.type === 'low_cache_efficiency');
    assert.ok(low, 'expected a low_cache_efficiency anomaly');
    assert.equal(low!.sessionId, 'sess-1');
    assert.match(low!.detail, /62/, 'detail should cite the actual ratio');
  });

  it('stays quiet for a cheap session with a poor ratio', () => {
    // A $0.40 session at 40% cache is not worth anyone's attention.
    const found = detectAnomalies(makeOutput({
      sessions: [session({ costUSD: LOW_CACHE_MIN_COST_USD - 1, cacheReadRatio: 0.4 })],
    }));
    assert.equal(found.filter((a) => a.type === 'low_cache_efficiency').length, 0);
  });

  it('stays quiet at the healthy end, where real sessions actually sit', () => {
    // Measured on real data: sessions cluster 84-99%, median ~94%. A threshold
    // that fires at 96% would flag everybody and mean nothing.
    const found = detectAnomalies(makeOutput({
      sessions: [session({ costUSD: 200, cacheReadRatio: 0.96 })],
    }));
    assert.equal(found.filter((a) => a.type === 'low_cache_efficiency').length, 0);
  });

  it('treats the threshold as exclusive', () => {
    const found = detectAnomalies(makeOutput({
      sessions: [session({ costUSD: 40, cacheReadRatio: LOW_CACHE_RATIO_THRESHOLD })],
    }));
    assert.equal(found.filter((a) => a.type === 'low_cache_efficiency').length, 0);
  });

  it('reports the worst ratio first', () => {
    const found = detectAnomalies(makeOutput({
      sessions: [
        session({ id: 'mild', costUSD: 40, cacheReadRatio: 0.88 }),
        session({ id: 'awful', costUSD: 40, cacheReadRatio: 0.51 }),
      ],
    })).filter((a) => a.type === 'low_cache_efficiency');
    assert.equal(found.length, 2);
    assert.equal(found[0].sessionId, 'awful');
  });
});

describe('detectAnomalies — cold starts', () => {
  it('flags a session that repeatedly rebuilt its cache from cold', () => {
    const found = detectAnomalies(makeOutput({
      sessions: [session({ coldStarts: 12, coldStartExtraUSD: 34.5 })],
    }));
    const cold = found.find((a) => a.type === 'cache_cold_start');
    assert.ok(cold, 'expected a cache_cold_start anomaly');
    assert.equal(cold!.sessionId, 'sess-1');
    assert.match(cold!.detail, /12/, 'detail should cite how many times');
    assert.match(cold!.detail, /\$34\.50/, 'detail should cite the premium paid');
  });

  it('ignores an occasional cold start', () => {
    // Coming back to a session after lunch once is not a habit worth a warning.
    const found = detectAnomalies(makeOutput({
      sessions: [session({ coldStarts: COLD_START_MIN_EVENTS - 1, coldStartExtraUSD: 3 })],
    }));
    assert.equal(found.filter((a) => a.type === 'cache_cold_start').length, 0);
  });

  it('reports the costliest rebuild habit first', () => {
    const found = detectAnomalies(makeOutput({
      sessions: [
        session({ id: 'cheap', coldStarts: 20, coldStartExtraUSD: 2 }),
        session({ id: 'pricey', coldStarts: 5, coldStartExtraUSD: 60 }),
      ],
    })).filter((a) => a.type === 'cache_cold_start');
    assert.equal(found.length, 2);
    assert.equal(found[0].sessionId, 'pricey');
  });
});

describe('detectAnomalies — model churn', () => {
  /** A deep session entry; only --deep runs carry the churn counts. */
  function deepSession(over: Record<string, unknown> = {}) {
    return {
      id: 'sess-1',
      name: 'do the thing',
      project: 'proj',
      primaryModel: 'claude-opus-4-6',
      costUSD: 250,
      durationMinutes: 600,
      prompts: 700,
      flags: ['high-cost' as const],
      transcripts: [],
      promptDisplays: [],
      promptDisplaysTruncated: false,
      modelTimeline: [],
      modelSwitchCount: 400,
      mainModelSwitchCount: 12,
      ...over,
    };
  }

  function withDeep(sessions: ReturnType<typeof deepSession>[]): CcalyzeOutput {
    return makeOutput({
      sessions: sessions.map((s) => session({
        id: s.id, project: s.project, primaryModel: s.primaryModel,
        startTime: '2026-03-29T10:00:00Z', endTime: '2026-03-29T20:00:00Z',
        durationMinutes: s.durationMinutes, prompts: s.prompts,
        costUSD: s.costUSD, transcriptSizeMB: 10, flags: s.flags,
      })),
      deep: { note: 'test', sessions: sessions as never },
    });
  }

  it('flags a session with heavy MAIN-THREAD churn AND high cost', () => {
    const found = detectAnomalies(withDeep([deepSession()]));
    const churn = found.find((a) => a.type === 'high_model_churn');
    assert.ok(churn, 'expected a high_model_churn anomaly');
    assert.equal(churn!.sessionId, 'sess-1');
    assert.match(churn!.detail, /12/, 'detail should cite the main-thread switch count');
    assert.match(churn!.detail, /\$250/, 'detail should cite the cost — churn matters when it is expensive');
  });

  it('does not flag heavy churn on a cheap session', () => {
    const found = detectAnomalies(withDeep([deepSession({ costUSD: 0.4, flags: [] })]));
    assert.equal(found.filter((a) => a.type === 'high_model_churn').length, 0);
  });

  it('ignores churn that is entirely subagent delegation', () => {
    // The whole point of counting the main thread separately: 400 switches
    // driven by subagents alternating models is normal and breaks no cache.
    const found = detectAnomalies(withDeep([
      deepSession({ modelSwitchCount: 400, mainModelSwitchCount: 1 }),
    ]));
    assert.equal(found.filter((a) => a.type === 'high_model_churn').length, 0);
  });

  it('emits nothing about churn when --deep was not used', () => {
    const output = makeOutput({ sessions: [session({ costUSD: 250, flags: ['high-cost'] })] });
    assert.equal(detectAnomalies(output).filter((a) => a.type === 'high_model_churn').length, 0);
  });

  it('reports the churniest session first when several qualify', () => {
    const found = detectAnomalies(withDeep([
      deepSession({ id: 'quiet', mainModelSwitchCount: 6 }),
      deepSession({ id: 'churny', mainModelSwitchCount: 19 }),
    ])).filter((a) => a.type === 'high_model_churn');
    assert.equal(found.length, 2);
    assert.equal(found[0].sessionId, 'churny');
  });
});

describe('detectAnomalies — unknown model pricing', () => {
  it('flags a model that has no published pricing', () => {
    const found = detectAnomalies(makeOutput({
      byModel: {
        'claude-opus-5': { costUSD: 10, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 1 },
        'claude-opus-9': { costUSD: 5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 1 },
      },
    }));
    const unknown = found.find((a) => a.type === 'unknown_model_pricing');
    assert.ok(unknown, 'expected an unknown_model_pricing anomaly');
    assert.match(unknown!.detail, /claude-opus-9/);
    assert.doesNotMatch(unknown!.detail, /claude-opus-5/, 'known models must not be listed');
  });

  it('says nothing when every model is priced', () => {
    const found = detectAnomalies(makeOutput({
      byModel: {
        'claude-opus-5': { costUSD: 10, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 1 },
        'claude-haiku-4-5-20251001': { costUSD: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 1 },
      },
    }));
    assert.equal(found.filter((a) => a.type === 'unknown_model_pricing').length, 0);
  });
});
