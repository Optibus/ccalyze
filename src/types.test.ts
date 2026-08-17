import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CcalyzeOutput, SessionSummary, Anomaly, DaySummary, ModelSummary, ProjectSummary } from './types.js';

describe('types', () => {
  it('CcalyzeOutput satisfies the schema shape', () => {
    const output: CcalyzeOutput = {
      range: { from: '2026-03-29', to: '2026-03-29' },
      summary: {
        totalCostUSD: 45.20,
        totalInputTokens: 1200000,
        totalOutputTokens: 350000,
        totalCacheReadTokens: 89000000,
        totalCacheWriteTokens: 5000000,
        totalSessions: 11,
        totalPrompts: 108,
        cacheReadRatio: 0.9412,
        sidechainTokenShare: 0.31,
      },
      byDay: [{
        date: '2026-03-29',
        costUSD: 45.20,
        sessions: 11,
        prompts: 108,
        tokensByModel: {},
      }],
      byModel: {},
      byProject: [{
        project: 'demo-webapp',
        costUSD: 22.50,
        sessions: 1,
        prompts: 62,
        transcriptSizeMB: 126,
      }],
      sessions: [{
        id: '661c65a9',
        name: 'refactor the migration runner',
        project: 'demo-webapp',
        primaryModel: 'claude-opus-4-6',
        startTime: '2026-03-29T11:07:00Z',
        endTime: '2026-03-29T17:44:00Z',
        durationMinutes: 397,
        prompts: 62,
        costUSD: 22.50,
        transcriptSizeMB: 126,
        flags: ['no-compaction', 'long-running'],
        cacheReadRatio: 0.9412,
        coldStarts: 4,
        coldStartExtraUSD: 3.21,
        compaction: 'none',
        autoCompactions: 0,
        reworkEdits: 0,
      }],
      anomalies: [{
        type: 'cost_spike',
        severity: 'high',
        detail: 'Today cost is 3.2x your 7-day average',
      }],
      tips: ['Use /compact every 15-20 prompts.'],
    };

    assert.equal(output.summary.totalSessions, 11);
    assert.equal(output.sessions[0].flags.length, 2);
    assert.equal(output.anomalies[0].severity, 'high');
  });
});
