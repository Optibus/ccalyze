import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildProse, thinSampleFloor, topLever, FLAGGED_SHARE_TARGET } from './prose.ts';
import type {
  HabitsLever,
  HabitsReport,
  HabitsScorecardRow,
  HabitsVerdict,
  HabitsWindow,
} from './types.ts';

// --- fixtures ---------------------------------------------------------------

function cohort(overrides: Partial<HabitsWindow['flagged']> = {}): HabitsWindow['flagged'] {
  return {
    sessions: 4,
    cost: 40,
    costShare: 50,
    prompts: 200,
    promptShare: 50,
    perPrompt: 0.2,
    ...overrides,
  };
}

/** A window with plausible, internally consistent figures; override what a test reads. */
function window_(overrides: Partial<HabitsWindow> = {}): HabitsWindow {
  return {
    range: { from: '2026-08-11', to: '2026-08-17' },
    unit: 'units',
    daysCovered: 6,
    cost: 80,
    prompts: 400,
    sessions: 20,
    perPrompt: 0.2,
    cacheReadShare: 95,
    subagentTokenShare: 12,
    coldStart: { extra: 4, share: 5, sessions: 2 },
    noCompactionShare: 60,
    autoCompactionShare: 10,
    reworkShare: 25,
    longRunningSessions: 5,
    top3Share: 30,
    offHoursShare: 20,
    flagged: cohort(),
    clean: cohort({ costShare: 50, promptShare: 50 }),
    cleanCohortUsable: true,
    byModel: [
      { model: 'opus-5', cost: 60, costShare: 75, prompts: 200, sessions: 10, perPrompt: 0.3 },
      { model: 'sonnet-5', cost: 20, costShare: 25, prompts: 200, sessions: 10, perPrompt: 0.1 },
    ],
    modelCostShare: [
      { model: 'opus-5', cost: 60, costShare: 75 },
      { model: 'sonnet-5', cost: 20, costShare: 25 },
    ],
    byDuration: [
      { band: 'under 1 h', sessions: 10, cost: 8, costShare: 10, prompts: 80 },
      { band: '1-3 h', sessions: 6, cost: 16, costShare: 20, prompts: 120 },
      { band: '3-8 h', sessions: 4, cost: 56, costShare: 70, prompts: 200 },
      { band: '8-24 h', sessions: 0, cost: 0, costShare: 0, prompts: 0 },
      { band: 'over 24 h', sessions: 0, cost: 0, costShare: 0, prompts: 0 },
    ],
    byProject: [
      { project: 'armada', cost: 60, prompts: 250, perPrompt: 0.24 },
      { project: 'ccalyze', cost: 32.5, prompts: 250, perPrompt: 0.13 },
    ],
    anomalyCounts: {},
    tips: [],
    ...overrides,
  };
}

function row(measure: string, prior: number | null, current: number | null, verdict: HabitsVerdict): HabitsScorecardRow {
  return { measure, prior, current, verdict };
}

const MODEL_LEVER: HabitsLever = {
  lever: 'model-mix',
  basis: '200 opus-5 prompts at 0.3 vs 0.1',
  ceiling: 40,
  ceilingShare: 50,
  realistic: 13.33,
  realisticShare: 16.7,
  ratio: 3,
  note: 'Ceiling assumes every expensive-model prompt was avoidable, which it is not.',
};

const PROJECT_LEVER: HabitsLever = {
  lever: 'project-floor',
  basis: "whole window at ccalyze's rate (0.13)",
  ceiling: 28,
  ceilingShare: 35,
  note: 'Independent of any model assumption — two large cohorts.',
};

function report_(overrides: Partial<HabitsReport> = {}): HabitsReport {
  return {
    generatedFrom: 'ccalyze',
    unit: 'units',
    current: window_(),
    prior: window_({ range: { from: '2026-08-04', to: '2026-08-10' }, cost: 60, prompts: 300 }),
    delta: { cost: 33.3, prompts: 33.3, perPrompt: 0, sessions: 0 },
    headline: { finding: 'volume', why: 'Consumption rose 33.3% on 33.3% more prompts; per-prompt moved 0%.' },
    scorecard: [
      row('Consumption per prompt', 0.2, 0.2, 'flat'),
      row('Cold-start premium, share of total', 12, 5, 'much better'),
      row('Off-hours share (nights + weekends)', 18, 20, 'worse'),
    ],
    levers: [MODEL_LEVER, PROJECT_LEVER],
    caveats: {
      costIsNotional: 'not money',
      baselineUnmeasured: 'Per-request baseline is not in this data.',
      cleanCohort: 'Unflagged sessions hold 50% of prompts — usable as a baseline.',
    },
    ...overrides,
  };
}

const TODAY = '2026-08-18';

// --- the mechanical recipes -------------------------------------------------

describe('topLever', () => {
  it('picks the largest ceiling, not the first row', () => {
    assert.equal(topLever(report_({ levers: [PROJECT_LEVER, MODEL_LEVER] }))?.lever, 'model-mix');
  });

  it('is null when nothing sized above zero', () => {
    assert.equal(topLever(report_({ levers: [] })), null);
  });
});

describe('thinSampleFloor', () => {
  it('is 2 x N, the floor references/habits.md states', () => {
    assert.equal(thinSampleFloor(7), 14);
    assert.equal(thinSampleFloor(30), 60);
  });
});

describe('buildProse — headline per finding', () => {
  const headlineFor = (finding: HabitsReport['headline']['finding']) =>
    buildProse(report_({ headline: { finding, why: 'because.' } }), { today: TODAY }).headline;

  it('names workload for volume', () => {
    assert.match(headlineFor('volume'), /workload, not a habit/);
  });

  it('names a habit for an efficiency regression', () => {
    assert.match(headlineFor('efficiency-regression'), /habit is driving this/);
  });

  it('sends a mixed finding to the scorecard', () => {
    assert.match(headlineFor('mixed'), /No single explanation/);
  });

  it('says habits are described, not tracked, for a single window', () => {
    assert.match(headlineFor('single-window'), /described, not tracked/);
  });
});

describe('buildProse — conclusion', () => {
  it('quotes headline.why verbatim rather than re-deriving the figures', () => {
    const report = report_();
    const prose = buildProse(report, { today: TODAY });
    assert.ok(prose.conclusion.startsWith(report.headline.why));
  });

  it('explains for volume that cost tracking prompts means no habit to fix', () => {
    assert.match(buildProse(report_(), { today: TODAY }).conclusion, /no habit to fix/);
  });

  it('names the rows moving the wrong way for an efficiency regression', () => {
    const prose = buildProse(
      report_({ headline: { finding: 'efficiency-regression', why: 'Per-prompt rose 22%.' } }),
      { today: TODAY },
    );
    assert.match(prose.conclusion, /off-hours share \(nights \+ weekends\) \(18 → 20\)/);
  });

  it('counts improved against worse for a mixed finding', () => {
    const prose = buildProse(
      report_({ headline: { finding: 'mixed', why: 'no single explanation.' } }),
      { today: TODAY },
    );
    assert.match(prose.conclusion, /1 of 3 measures improved and 1 moved the wrong way/);
  });

  it('describes the level, not a direction, with no prior window', () => {
    const prose = buildProse(
      report_({ prior: null, delta: null, headline: { finding: 'single-window', why: 'No prior window.' } }),
      { today: TODAY },
    );
    assert.match(prose.conclusion, /400 prompts across 20 sessions/);
    assert.match(prose.conclusion, /none of it is a trend yet/);
    // Nothing may claim a comparison the data cannot support.
    assert.doesNotMatch(prose.conclusion, /against/);
  });
});

describe('buildProse — the second paragraph', () => {
  it('lists every row that moved the wrong way', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.outlook, /What did not improve: off-hours share \(nights \+ weekends\) \(18 → 20\)\./);
  });

  it('says so plainly when nothing regressed', () => {
    const prose = buildProse(
      report_({ scorecard: [row('Consumption per prompt', 0.3, 0.2, 'much better')] }),
      { today: TODAY },
    );
    assert.match(prose.outlook, /No measure in the scorecard moved the wrong way/);
  });

  it('sizes the remaining savings off the largest lever, hedge included', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.outlook, /40 units at the ceiling \(50% of the window\)/);
    assert.match(prose.outlook, /13.33 \(16.7%\) is the band worth aiming at/);
  });

  it('reports an unhedged lever as its ceiling', () => {
    const prose = buildProse(report_({ levers: [PROJECT_LEVER] }), { today: TODAY });
    assert.match(prose.outlook, /28 units at the ceiling \(35% of the window\)\./);
    assert.doesNotMatch(prose.outlook, /band worth aiming at/);
  });

  it('calls an efficient window a finding rather than a consolation', () => {
    const prose = buildProse(report_({ levers: [] }), { today: TODAY });
    assert.match(prose.outlook, /No lever in this data sizes above zero/);
    assert.match(prose.outlook, /ceiling is the constraint/);
  });

  it('says the project split stands in when the clean cohort is unusable', () => {
    const prose = buildProse(
      report_({
        current: window_({ cleanCohortUsable: false, clean: cohort({ promptShare: 3 }) }),
      }),
      { today: TODAY },
    );
    assert.match(prose.outlook, /only 3% of prompts/);
    assert.match(prose.outlook, /stand in for it/);
  });

  it('is silent about the cohort when it is usable', () => {
    assert.doesNotMatch(buildProse(report_(), { today: TODAY }).outlook, /stand in for it/);
  });

  it('names a thin window and offers the longer re-run instead of defending it', () => {
    const prose = buildProse(
      report_({ current: window_({ sessions: 9 }), prior: window_({ sessions: 4 }) }),
      { today: TODAY },
    );
    assert.match(prose.outlook, /the current window \(9 sessions\) and the prior window \(4 sessions\)/);
    assert.match(prose.outlook, /14-session floor for a 7-day window/);
    assert.match(prose.outlook, /15d or 30d/);
  });

  it('leaves a well-populated pair unqualified', () => {
    assert.doesNotMatch(buildProse(report_(), { today: TODAY }).outlook, /anecdote/);
  });
});

describe('buildProse — recommendations', () => {
  it('leads with the model-mix lever when it is the largest', () => {
    const [first] = buildProse(report_(), { today: TODAY }).recommendations;
    assert.equal(first.rank, 1);
    assert.match(first.title, /expensive model/);
    assert.match(first.body, /3× rate difference/);
    assert.equal(first.size, '16.7%');
    assert.equal(first.sizeLabel, 'of the window');
    assert.ok(first.evidence.some((line) => line.includes('ceiling: 40 units (50% of the window)')));
  });

  it('leads with the project floor when that is the largest', () => {
    const [first] = buildProse(report_({ levers: [PROJECT_LEVER] }), { today: TODAY }).recommendations;
    assert.match(first.title, /cheapest project/);
    // No realistic hedge on this lever, so the ceiling share is what it may quote.
    assert.equal(first.size, '35%');
  });

  it('falls back to the regressed row when no lever sizes above zero', () => {
    const [first] = buildProse(report_({ levers: [] }), { today: TODAY }).recommendations;
    assert.match(first.title, /Pull off-hours share/);
    assert.equal(first.sizeLabel, 'the row to return');
  });

  it('asks for headroom when there is no lever and nothing regressed', () => {
    const prose = buildProse(
      report_({ levers: [], scorecard: [row('Consumption per prompt', 0.3, 0.2, 'much better')] }),
      { today: TODAY },
    );
    const [first] = prose.recommendations;
    assert.match(first.title, /Ask for headroom/);
    assert.equal(first.size, 'None');
    assert.match(first.body, /explicit end date/);
  });

  it('always carries the unsized baseline question second', () => {
    const [, second] = buildProse(report_(), { today: TODAY }).recommendations;
    assert.equal(second.rank, 2);
    assert.match(second.title, /per-request baseline/);
    assert.equal(second.size, 'Unknown');
    // The figure genuinely is not in the data, so it must not be invented.
    assert.ok(second.evidence.some((line) => line.includes('Per-request baseline is not in this data.')));
    assert.ok(second.evidence.some((line) => line.includes('prompts it would multiply against: 400')));
  });

  it('banks the rows that read much better third', () => {
    const [, , third] = buildProse(report_(), { today: TODAY }).recommendations;
    assert.match(third.title, /Keep doing what already worked/);
    assert.equal(third.size, 'Held');
    assert.deepEqual(third.evidence, ['Cold-start premium, share of total: 12 → 5 · much better']);
  });

  it('falls back to plain "better" rows when nothing moved strongly', () => {
    const prose = buildProse(
      report_({ scorecard: [row('Cache-read share of input tokens', 90, 94, 'better')] }),
      { today: TODAY },
    );
    const third = prose.recommendations[2];
    assert.match(third.title, /Keep doing what already worked/);
    assert.match(third.body, /One measure moved in the right direction/);
    assert.doesNotMatch(third.body, /strongly/);
  });

  it('says nothing is banked yet rather than manufacturing a win', () => {
    const prose = buildProse(
      report_({ scorecard: [row('Consumption per prompt', 0.2, 0.2, 'flat')] }),
      { today: TODAY },
    );
    const third = prose.recommendations[2];
    assert.match(third.title, /Nothing is banked yet/);
    assert.equal(third.size, 'Baseline');
    assert.deepEqual(third.evidence, ['Consumption per prompt: 0.2 → 0.2 · flat']);
  });

  it('makes a single-window run the baseline for the next one', () => {
    const prose = buildProse(
      report_({
        prior: null,
        delta: null,
        headline: { finding: 'single-window', why: 'No prior window.' },
        scorecard: [row('Consumption per prompt', null, 0.2, 'no-baseline')],
      }),
      { today: TODAY },
    );
    const third = prose.recommendations[2];
    assert.match(third.title, /Set the baseline/);
    assert.match(third.body, /cannot show anything holding/);
  });
});

describe('buildProse — figure captions', () => {
  it('names the heaviest duration band with both windows', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.durationCaption, /Sessions of 3-8 h carry 70% of the window's units across 4 sessions and 200 prompts/);
    assert.match(prose.durationCaption, /against 70% in the earlier window/);
    assert.match(prose.durationCaption, /wall clock/);
  });

  it('drops the comparison when there is no prior window', () => {
    const prose = buildProse(report_({ prior: null, delta: null }), { today: TODAY });
    assert.doesNotMatch(prose.durationCaption, /earlier window/);
  });

  it('quotes the model ratio from this window rather than a benchmark', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.modelCaption, /opus-5 runs 0.3 units per prompt across 200 prompts/);
    assert.match(prose.modelCaption, /a 3× difference/);
  });

  // An unfiltered max/min reaches for the thinnest row in the window: a real run
  // compared a 4-prompt model against a 120-prompt one and called it a 7x gap
  // while the lever beside it priced 10,718 prompts.
  it('ignores cohorts under the prompt floor when two real ones exist', () => {
    const prose = buildProse(
      report_({
        current: window_({
          byModel: [
            { model: 'sonnet-4-5', cost: 0.45, costShare: 1, prompts: 4, sessions: 1, perPrompt: 0.1129 },
            { model: 'opus-5', cost: 60, costShare: 74, prompts: 1_000, sessions: 40, perPrompt: 0.06 },
            { model: 'haiku-4-5', cost: 20, costShare: 25, prompts: 1_000, sessions: 20, perPrompt: 0.02 },
          ],
        }),
      }),
      { today: TODAY },
    );
    assert.match(prose.modelCaption, /opus-5 runs 0.06 units per prompt across 1,000 prompts/);
    assert.match(prose.modelCaption, /haiku-4-5 runs 0.02 across 1,000/);
    assert.doesNotMatch(prose.modelCaption, /sonnet-4-5/);
    assert.doesNotMatch(prose.modelCaption, /anecdote/);
  });

  it('says the sample is thin rather than quoting a ratio that means nothing', () => {
    const prose = buildProse(
      report_({
        current: window_({
          byModel: [
            { model: 'sonnet-4-5', cost: 0.45, costShare: 50, prompts: 4, sessions: 1, perPrompt: 0.1129 },
            { model: 'haiku-4-5', cost: 0.45, costShare: 50, prompts: 120, sessions: 2, perPrompt: 0.016 },
          ],
        }),
      }),
      { today: TODAY },
    );
    assert.match(prose.modelCaption, /7.06× difference/);
    assert.match(prose.modelCaption, /under the 200-prompt floor/);
    assert.match(prose.modelCaption, /anecdote rather than a rate/);
  });

  it('applies the same floor to the project spread', () => {
    const prose = buildProse(
      report_({
        current: window_({
          byProject: [
            { project: 'tab', cost: 1, prompts: 5, perPrompt: 0.9 },
            { project: 'armada', cost: 60, prompts: 250, perPrompt: 0.24 },
            { project: 'ccalyze', cost: 32.5, prompts: 250, perPrompt: 0.13 },
          ],
        }),
      }),
      { today: TODAY },
    );
    assert.doesNotMatch(prose.projectCaption, /tab/);
    assert.match(prose.projectCaption, /armada runs 0.24/);
  });

  it('does not invent a ratio when only one model is priced', () => {
    const prose = buildProse(
      report_({
        current: window_({
          byModel: [{ model: 'opus-5', cost: 80, costShare: 100, prompts: 400, sessions: 20, perPrompt: 0.2 }],
        }),
      }),
      { today: TODAY },
    );
    assert.match(prose.modelCaption, /no second model here to compare/);
    assert.doesNotMatch(prose.modelCaption, /difference/);
  });

  it('reads the project spread as the achievable target', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.projectCaption, /armada runs 0.24 units per prompt over 250 prompts/);
    assert.match(prose.projectCaption, /ccalyze runs 0.13 over 250/);
    assert.doesNotMatch(prose.projectCaption, /stands in for it/);
  });

  it('says the project spread is standing in for an unusable clean cohort', () => {
    const prose = buildProse(
      report_({ current: window_({ cleanCohortUsable: false }) }),
      { today: TODAY },
    );
    assert.match(prose.projectCaption, /stands in for it/);
  });

  it('says there is no spread when only one project is priced', () => {
    const prose = buildProse(
      report_({ current: window_({ byProject: [{ project: 'armada', cost: 80, prompts: 400, perPrompt: 0.2 }] }) }),
      { today: TODAY },
    );
    assert.match(prose.projectCaption, /no spread to read/);
  });
});

describe('buildProse — the re-measure', () => {
  it('lands N days out and re-runs at the same length', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.equal(prose.remeasure.date, '2026-08-25');
    assert.equal(prose.remeasure.command, 'ccalyze --habits 7d --html');
  });

  it('reads the length off the window, not a default', () => {
    const prose = buildProse(
      report_({
        current: window_({ range: { from: '2026-07-19', to: '2026-08-17' } }),
        prior: window_({ range: { from: '2026-06-19', to: '2026-07-18' } }),
      }),
      { today: TODAY },
    );
    assert.equal(prose.remeasure.date, '2026-09-17');
    assert.equal(prose.remeasure.command, 'ccalyze --habits 30d --html');
  });

  it('names numeric targets, so the advice has a destination', () => {
    const prose = buildProse(report_(), { today: TODAY });
    assert.match(prose.remeasure.targets, /consumption per prompt below 0.2/);
    assert.match(prose.remeasure.targets, new RegExp(`under ${FLAGGED_SHARE_TARGET}% \\(it is 50%\\)`));
    assert.match(prose.remeasure.targets, /16.7% of the window recovered from model-mix/);
  });

  it('asks an already-clean flagged share to hold rather than to fall', () => {
    const prose = buildProse(
      report_({ current: window_({ flagged: cohort({ costShare: 22 }) }) }),
      { today: TODAY },
    );
    assert.match(prose.remeasure.targets, /holding at or under 22%/);
  });

  it('tells a single-window run that the next one is the first comparison', () => {
    const prose = buildProse(report_({ prior: null, delta: null }), { today: TODAY });
    assert.match(prose.remeasure.targets, /no prior window/);
  });
});

describe('buildProse — the title', () => {
  it('carries the current window dates', () => {
    assert.equal(
      buildProse(report_(), { today: TODAY }).title,
      'Claude Code usage — 2026-08-11 → 2026-08-17',
    );
  });
});
