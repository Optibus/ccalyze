import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateTips } from './tips.ts';
import type { CcalyzeOutput, Anomaly } from './types.ts';

function makeOutput(anomalies: Anomaly[], sessions: CcalyzeOutput['sessions'] = []): CcalyzeOutput {
  return {
    range: { from: '2026-03-29', to: '2026-03-29' },
    summary: { totalCostUSD: 45, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalSessions: 2, totalPrompts: 70, cacheReadRatio: 0.96, sidechainTokenShare: 0 },
    byDay: [],
    byModel: {},
    byProject: [],
    sessions,
    anomalies,
    tips: [],
  };
}

describe('generateTips', () => {
  it('generates compaction tip when no-compaction anomalies exist', () => {
    const anomalies: Anomaly[] = [
      { type: 'session_no_compaction', severity: 'high', sessionId: 's1', detail: '' },
      { type: 'session_no_compaction', severity: 'high', sessionId: 's2', detail: '' },
    ];
    const tips = generateTips(makeOutput(anomalies));
    assert.ok(tips.some(t => t.includes('/compact')));
    assert.ok(tips.some(t => t.includes('2 sessions')));
  });

  it('generates concurrent opus tip', () => {
    const anomalies: Anomaly[] = [
      { type: 'concurrent_opus', severity: 'medium', detail: '4 Opus sessions' },
    ];
    const tips = generateTips(makeOutput(anomalies));
    assert.ok(tips.some(t => t.toLowerCase().includes('cheaper') || t.toLowerCase().includes('haiku') || t.toLowerCase().includes('sonnet')));
  });

  it('generates long-running tip', () => {
    const anomalies: Anomaly[] = [
      { type: 'long_running_session', severity: 'medium', sessionId: 's1', detail: '' },
    ];
    const tips = generateTips(makeOutput(anomalies));
    assert.ok(tips.some(t => t.includes('fresh session') || t.includes('new session')));
  });

  it('returns empty for no anomalies', () => {
    const tips = generateTips(makeOutput([]));
    assert.equal(tips.length, 0);
  });
});

describe('generateTips — model churn', () => {
  it('explains the cache cost of switching model mid-session', () => {
    const tips = generateTips(makeOutput([{
      type: 'high_model_churn', severity: 'medium', sessionId: 'sess-1',
      detail: '12 main-thread model switches in a $250.00 session',
    }]));
    const tip = tips.find((t) => /cache is keyed to the model/i.test(t));
    assert.ok(tip, `expected a churn tip, got: ${JSON.stringify(tips)}`);
  });

  it('says nothing about churn when none was flagged', () => {
    const tips = generateTips(makeOutput([]));
    assert.equal(tips.filter((t) => /keyed to the model/i.test(t)).length, 0);
  });
});

describe('generateTips — cache efficiency', () => {
  it('explains why a low cache ratio matters when sessions are flagged', () => {
    const tips = generateTips(makeOutput([{
      type: 'low_cache_efficiency', severity: 'medium', sessionId: 'sess-1', detail: '',
    }]));
    assert.ok(tips.some((t) => /served an unusually low share of input from cache/i.test(t)));
  });

  it('warns on a poor range-wide ratio even when no single session is flagged', () => {
    const output = makeOutput([]);
    output.summary.cacheReadRatio = 0.55;
    assert.ok(generateTips(output).some((t) => /55\.0%/.test(t)));
  });

  it('stays silent about a healthy range-wide ratio', () => {
    const output = makeOutput([]);
    output.summary.cacheReadRatio = 0.963;
    assert.equal(generateTips(output).length, 0);
  });
});

describe('generateTips — cold starts', () => {
  it('explains the idle-gap rebuild when cold starts are flagged', () => {
    const tips = generateTips(makeOutput([{
      type: 'cache_cold_start', severity: 'medium', sessionId: 'sess-1', detail: '',
    }]));
    assert.ok(tips.some((t) => /expires after about an hour/i.test(t)));
  });
});
