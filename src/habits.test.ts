import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHabitsReport,
  HabitsRefusal,
  headline,
  levers,
  pct,
  ratioDelta,
  resolveHabitWindows,
  scorecard,
  spanDays,
  summarizeWindow,
  validateWindowPair,
} from './habits.ts';
import type {
  Anomaly,
  CcalyzeOutput,
  DateRange,
  DaySummary,
  ModelSummary,
  ProjectSummary,
  SessionFlag,
  SessionSummary,
} from './types.ts';

// --- fixtures ---------------------------------------------------------------

interface SessionSpec {
  id?: string;
  project?: string;
  primaryModel?: string;
  durationMinutes?: number;
  prompts?: number;
  costUSD?: number;
  flags?: SessionFlag[];
  coldStartExtraUSD?: number;
}

function session(spec: SessionSpec = {}): SessionSummary {
  return {
    id: spec.id ?? 's1',
    name: spec.id ?? 's1',
    project: spec.project ?? 'proj-a',
    primaryModel: spec.primaryModel ?? 'claude-sonnet-4-5',
    startTime: '2026-08-10T09:00:00.000Z',
    endTime: '2026-08-10T10:00:00.000Z',
    durationMinutes: spec.durationMinutes ?? 60,
    prompts: spec.prompts ?? 10,
    costUSD: spec.costUSD ?? 1,
    transcriptSizeMB: 1,
    flags: spec.flags ?? [],
    cacheReadRatio: 0.95,
    coldStarts: spec.coldStartExtraUSD ? 1 : 0,
    coldStartExtraUSD: spec.coldStartExtraUSD ?? 0,
  };
}

interface OutputSpec {
  range?: DateRange;
  sessions?: SessionSummary[];
  daysCovered?: number;
  byModel?: Record<string, ModelSummary>;
  byProject?: ProjectSummary[];
  anomalies?: Anomaly[];
  cacheReadRatio?: number;
}

/** A CcalyzeOutput whose summary is derived from its sessions, as a real run's is. */
function output(spec: OutputSpec = {}): CcalyzeOutput {
  const sessions = spec.sessions ?? [session()];
  const range = spec.range ?? { from: '2026-08-10', to: '2026-08-16' };
  const daysCovered = spec.daysCovered ?? spanDays(range);
  const byDay: DaySummary[] = Array.from({ length: daysCovered }, (_, i) => ({
    date: new Date(Date.parse(`${range.from}T00:00:00Z`) + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
    costUSD: 0,
    sessions: 0,
    prompts: 0,
    tokensByModel: {},
  }));

  return {
    range,
    summary: {
      totalCostUSD: sessions.reduce((sum, s) => sum + s.costUSD, 0),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalSessions: sessions.length,
      totalPrompts: sessions.reduce((sum, s) => sum + s.prompts, 0),
      cacheReadRatio: spec.cacheReadRatio ?? 0.95,
      sidechainTokenShare: 0,
    },
    byDay,
    byModel: spec.byModel ?? {},
    byProject: spec.byProject ?? [],
    sessions,
    anomalies: spec.anomalies ?? [],
    tips: [],
  };
}

function project(name: string, costUSD: number, prompts: number): ProjectSummary {
  return { project: name, costUSD, sessions: 1, prompts, transcriptSizeMB: 1 };
}

// --- helpers ----------------------------------------------------------------

describe('pct / ratioDelta', () => {
  it('reads a zero whole as 0 rather than NaN', () => {
    assert.equal(pct(5, 0), 0);
  });

  it('returns null when there is no prior figure', () => {
    assert.equal(ratioDelta(10, null), null);
    assert.equal(ratioDelta(10, 0), null);
  });

  it('computes a percent change', () => {
    assert.equal(ratioDelta(150, 100), 50);
    assert.equal(ratioDelta(50, 100), -50);
  });
});

// --- window arithmetic ------------------------------------------------------

describe('resolveHabitWindows', () => {
  it('ends the current window yesterday, never today', () => {
    const { current } = resolveHabitWindows(7, '2026-08-17');
    assert.equal(current.to, '2026-08-16');
    assert.equal(current.from, '2026-08-10');
  });

  it('places the prior window immediately before, with no gap and no overlap', () => {
    const { current, prior } = resolveHabitWindows(7, '2026-08-17');
    assert.equal(prior.from, '2026-08-03');
    assert.equal(prior.to, '2026-08-09');
    assert.equal(
      Date.parse(`${current.from}T00:00:00Z`) - Date.parse(`${prior.to}T00:00:00Z`),
      86_400_000,
    );
  });

  it('makes both windows exactly N days, inclusive, at every length', () => {
    for (const length of [7, 15, 30]) {
      const { current, prior } = resolveHabitWindows(length, '2026-08-17');
      assert.equal(spanDays(current), length);
      assert.equal(spanDays(prior), length);
    }
  });

  it('crosses a month and a year boundary correctly', () => {
    assert.deepEqual(resolveHabitWindows(7, '2026-01-05'), {
      current: { from: '2025-12-29', to: '2026-01-04' },
      prior: { from: '2025-12-22', to: '2025-12-28' },
    });
  });

  it('rejects a length no comparison could use', () => {
    assert.throws(() => resolveHabitWindows(1, '2026-08-17'), /2 days or more/);
    assert.throws(() => resolveHabitWindows(7.5, '2026-08-17'), /whole number/);
  });
});

// --- window summary ---------------------------------------------------------

describe('summarizeWindow', () => {
  it('computes per-prompt consumption from the window totals', () => {
    const window = summarizeWindow(
      output({ sessions: [session({ costUSD: 30, prompts: 100 })] }),
    );
    assert.equal(window.cost, 30);
    assert.equal(window.prompts, 100);
    assert.equal(window.perPrompt, 0.3);
  });

  it('excludes high-cost from the behavioural split, so the metric is not circular', () => {
    const window = summarizeWindow(
      output({
        sessions: [
          session({ id: 'expensive-but-clean', costUSD: 40, prompts: 50, flags: ['high-cost'] }),
          session({ id: 'flagged', costUSD: 10, prompts: 50, flags: ['no-compaction'] }),
        ],
      }),
    );
    assert.equal(window.flagged.sessions, 1);
    assert.equal(window.flagged.cost, 10);
    assert.equal(window.clean.sessions, 1);
    assert.equal(window.clean.cost, 40);
  });

  it('marks the clean cohort unusable below the prompt floor', () => {
    const thin = summarizeWindow(
      output({
        sessions: [
          session({ id: 'a', prompts: 97, flags: ['long-running'] }),
          session({ id: 'b', prompts: 3 }),
        ],
      }),
    );
    assert.equal(thin.clean.promptShare, 3);
    assert.equal(thin.cleanCohortUsable, false);

    const usable = summarizeWindow(
      output({
        sessions: [
          session({ id: 'a', prompts: 80, flags: ['long-running'] }),
          session({ id: 'b', prompts: 20 }),
        ],
      }),
    );
    assert.equal(usable.cleanCohortUsable, true);
  });

  it('concentrates on the three priciest sessions', () => {
    const window = summarizeWindow(
      output({
        sessions: [
          session({ id: 'a', costUSD: 40 }),
          session({ id: 'b', costUSD: 30 }),
          session({ id: 'c', costUSD: 20 }),
          session({ id: 'd', costUSD: 10 }),
        ],
      }),
    );
    assert.equal(window.top3Share, 90);
  });

  it('sums the cold-start premium and counts the anomaly, not the sessions', () => {
    const window = summarizeWindow(
      output({
        sessions: [
          session({ id: 'a', costUSD: 50, coldStartExtraUSD: 4 }),
          session({ id: 'b', costUSD: 50, coldStartExtraUSD: 1 }),
        ],
        anomalies: [
          { type: 'cache_cold_start', severity: 'medium', sessionId: 'a', detail: 'x' },
        ],
      }),
    );
    assert.equal(window.coldStart.extra, 5);
    assert.equal(window.coldStart.share, 5);
    assert.equal(window.coldStart.sessions, 1);
  });

  it('bands sessions by duration, with over-24h its own band', () => {
    const window = summarizeWindow(
      output({
        sessions: [
          session({ id: 'short', durationMinutes: 30, costUSD: 10 }),
          session({ id: 'marathon', durationMinutes: 2000, costUSD: 90 }),
        ],
      }),
    );
    const over24h = window.byDuration.find((band) => band.band === 'over 24 h')!;
    assert.equal(over24h.sessions, 1);
    assert.equal(over24h.costShare, 90);
    assert.equal(window.byDuration.find((b) => b.band === 'under 1 h')!.sessions, 1);
  });

  it('keeps both model views: per-session for rates, token-level for share', () => {
    const window = summarizeWindow(
      output({
        sessions: [session({ primaryModel: 'claude-opus-4-6', costUSD: 100, prompts: 50 })],
        byModel: {
          'claude-opus-4-6': {
            costUSD: 60,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            sessions: 1,
          },
          'claude-haiku-4-5': {
            costUSD: 40,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            sessions: 1,
          },
        },
      }),
    );
    assert.equal(window.byModel[0].model, 'opus-4-6');
    assert.equal(window.byModel[0].perPrompt, 2);
    assert.deepEqual(
      window.modelCostShare.map((row) => [row.model, row.costShare]),
      [
        ['opus-4-6', 60],
        ['haiku-4-5', 40],
      ],
    );
  });

  it('caps the project table at --top', () => {
    const window = summarizeWindow(
      output({
        byProject: [project('a', 3, 10), project('b', 2, 10), project('c', 1, 10)],
      }),
      { topProjects: 2 },
    );
    assert.deepEqual(
      window.byProject.map((row) => row.project),
      ['a', 'b'],
    );
  });
});

// --- verdicts ---------------------------------------------------------------

describe('scorecard', () => {
  const withPerPrompt = (cost: number, prompts: number, range: DateRange) =>
    summarizeWindow(output({ sessions: [session({ costUSD: cost, prompts })], range }));

  const current = { from: '2026-08-10', to: '2026-08-16' };
  const prior = { from: '2026-08-03', to: '2026-08-09' };

  it('reads a sub-5% move as flat rather than booking it as a win', () => {
    const rows = scorecard(
      withPerPrompt(98, 100, current),
      withPerPrompt(100, 100, prior),
    );
    assert.equal(rows[0].measure, 'Consumption per prompt');
    assert.equal(rows[0].verdict, 'flat');
  });

  it('separates better from much better at 25%', () => {
    assert.equal(
      scorecard(withPerPrompt(90, 100, current), withPerPrompt(100, 100, prior))[0].verdict,
      'better',
    );
    assert.equal(
      scorecard(withPerPrompt(70, 100, current), withPerPrompt(100, 100, prior))[0].verdict,
      'much better',
    );
  });

  it('calls a rise worse', () => {
    assert.equal(
      scorecard(withPerPrompt(130, 100, current), withPerPrompt(100, 100, prior))[0].verdict,
      'worse',
    );
  });

  it('reads no-baseline for every row without a prior window', () => {
    const rows = scorecard(withPerPrompt(100, 100, current), null);
    assert.ok(rows.every((row) => row.verdict === 'no-baseline'));
    assert.ok(rows.every((row) => row.prior === null));
  });

  it('treats a rising cache-read share as better, not worse', () => {
    const row = scorecard(
      summarizeWindow(output({ range: current, cacheReadRatio: 0.98 })),
      summarizeWindow(output({ range: prior, cacheReadRatio: 0.8 })),
    ).find((r) => r.measure === 'Cache-read share of input tokens')!;
    assert.equal(row.verdict, 'better');
  });
});

describe('headline', () => {
  const window = (cost: number, prompts: number, range: DateRange) =>
    summarizeWindow(output({ sessions: [session({ costUSD: cost, prompts })], range }));
  const cur = { from: '2026-08-10', to: '2026-08-16' };
  const pri = { from: '2026-08-03', to: '2026-08-09' };

  it('calls extra usage volume when per-prompt held flat', () => {
    const found = headline(window(150, 150, cur), window(100, 100, pri));
    assert.equal(found.finding, 'volume');
    assert.match(found.why, /the rise is workload/);
  });

  it('calls it a habit when cost grew faster than volume', () => {
    const found = headline(window(150, 100, cur), window(100, 100, pri));
    assert.equal(found.finding, 'efficiency-regression');
  });

  it('refuses to pick when nothing dominates', () => {
    assert.equal(headline(window(103, 101, cur), window(100, 100, pri)).finding, 'mixed');
  });

  it('says habits cannot be tracked from one window', () => {
    assert.equal(headline(window(100, 100, cur), null).finding, 'single-window');
  });
});

// --- levers -----------------------------------------------------------------

describe('levers', () => {
  it('sizes the model-mix gap and aims at a third of the ceiling', () => {
    const window = summarizeWindow(
      output({
        sessions: [
          session({ id: 'o', primaryModel: 'claude-opus-4-6', costUSD: 300, prompts: 100 }),
          session({ id: 's', primaryModel: 'claude-sonnet-4-5', costUSD: 100, prompts: 100 }),
        ],
      }),
    );
    const lever = levers(window).find((l) => l.lever === 'model-mix')!;
    assert.equal(lever.ratio, 3);
    assert.equal(lever.ceiling, 200);
    assert.equal(lever.realistic, 66.67);
  });

  it('needs two large project cohorts before quoting a project floor', () => {
    const thin = summarizeWindow(
      output({ byProject: [project('a', 300, 100), project('b', 100, 100)] }),
    );
    assert.equal(
      thin.byProject.length >= 2 && levers(thin).some((l) => l.lever === 'project-floor'),
      false,
    );

    const large = summarizeWindow(
      output({
        sessions: [session({ costUSD: 400, prompts: 600 })],
        byProject: [project('pricey', 300, 200), project('cheap', 100, 400)],
      }),
    );
    const lever = levers(large).find((l) => l.lever === 'project-floor')!;
    assert.equal(lever.ceiling, 250);
  });
});

// --- refusals ---------------------------------------------------------------

describe('validateWindowPair', () => {
  const window = (range: DateRange, daysCovered?: number) =>
    summarizeWindow(output({ range, daysCovered }));

  it('refuses an unequal pair, because the deltas would measure the window', () => {
    assert.throws(
      () =>
        validateWindowPair(
          window({ from: '2026-08-10', to: '2026-08-16' }),
          window({ from: '2026-07-11', to: '2026-08-09' }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HabitsRefusal);
        assert.match(err.message, /unequal windows: current spans 7 days/);
        return true;
      },
    );
  });

  it('refuses an overlapping pair, because a session is compared against itself', () => {
    assert.throws(
      () =>
        validateWindowPair(
          window({ from: '2026-08-10', to: '2026-08-16' }),
          window({ from: '2026-08-04', to: '2026-08-10' }),
        ),
      /overlapping windows/,
    );
  });

  it('warns, but does not refuse, when days go unmeasured between the windows', () => {
    const warnings = validateWindowPair(
      window({ from: '2026-08-10', to: '2026-08-16' }),
      window({ from: '2026-08-01', to: '2026-08-07' }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 day\(s\) unmeasured/);
  });

  it('accepts a Monday-to-Friday pair — weekends are not sparsity', () => {
    const warnings = validateWindowPair(
      window({ from: '2026-08-10', to: '2026-08-16' }, 5),
      window({ from: '2026-08-03', to: '2026-08-09' }, 5),
    );
    assert.deepEqual(warnings, []);
  });

  it('refuses lopsided coverage and names a shorter length', () => {
    assert.throws(
      () =>
        validateWindowPair(
          window({ from: '2026-07-18', to: '2026-08-16' }, 26),
          window({ from: '2026-06-18', to: '2026-07-17' }, 11),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HabitsRefusal);
        assert.match(err.message, /lopsided coverage/);
        assert.match(err.advice, /Re-run with a shorter length \(try 13d\)/);
        return true;
      },
    );
  });

  it('refuses a pair where both windows are equally empty', () => {
    assert.throws(
      () =>
        validateWindowPair(
          window({ from: '2026-07-18', to: '2026-08-16' }, 8),
          window({ from: '2026-06-18', to: '2026-07-17' }, 7),
        ),
      /window too sparse/,
    );
  });
});

// --- the whole report -------------------------------------------------------

describe('buildHabitsReport', () => {
  const current = { from: '2026-08-10', to: '2026-08-16' };
  const prior = { from: '2026-08-03', to: '2026-08-09' };

  it('carries the deltas, the headline and the caveats', () => {
    const { report } = buildHabitsReport(
      output({ range: current, sessions: [session({ costUSD: 120, prompts: 100 })] }),
      output({ range: prior, sessions: [session({ costUSD: 100, prompts: 100 })] }),
    );
    assert.equal(report.generatedFrom, 'ccalyze');
    assert.equal(report.delta!.cost, 20);
    assert.equal(report.delta!.perPrompt, 20);
    assert.equal(report.headline.finding, 'efficiency-regression');
    assert.match(report.caveats.costIsNotional, /never as spend/);
    assert.match(report.caveats.cleanCohort, /100% of prompts/);
  });

  it('describes one window without pretending to track it', () => {
    const { report, warnings } = buildHabitsReport(output({ range: current }), null);
    assert.equal(report.prior, null);
    assert.equal(report.delta, null);
    assert.equal(report.headline.finding, 'single-window');
    assert.deepEqual(warnings, []);
  });

  it('labels the cost figure with --unit in both the report and each window', () => {
    const { report } = buildHabitsReport(output({ range: current }), null, { unit: 'quota units' });
    assert.equal(report.unit, 'quota units');
    assert.equal(report.current.unit, 'quota units');
  });

  it('aliases a project label before it can be shared', () => {
    const { report } = buildHabitsReport(
      output({ range: current, byProject: [project('acme-migration', 10, 10)] }),
      null,
      { aliases: { 'acme-migration': 'customer-a' } },
    );
    assert.equal(report.current.byProject[0].project, 'customer-a');
  });

  it('redacts every project label, in both windows', () => {
    const { report } = buildHabitsReport(
      output({
        range: current,
        byProject: [project('acme', 20, 10), project('side-project', 10, 10)],
      }),
      output({ range: prior, byProject: [project('acme', 20, 10)] }),
      { redactProjects: true },
    );
    assert.deepEqual(
      report.current.byProject.map((row) => row.project),
      ['project-1', 'project-2'],
    );
    assert.deepEqual(
      report.prior!.byProject.map((row) => row.project),
      ['project-1'],
    );
  });

  it('refuses rather than reporting a pair it cannot compare', () => {
    assert.throws(
      () =>
        buildHabitsReport(
          output({ range: { from: '2026-08-10', to: '2026-08-16' } }),
          output({ range: { from: '2026-07-11', to: '2026-08-09' } }),
        ),
      HabitsRefusal,
    );
  });
});
