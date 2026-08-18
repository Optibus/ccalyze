import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { embedFindings, escapeHtml, renderHabitsHtml } from './report.ts';
import type { HabitsReport, HabitsWindow } from './types.ts';

// --- fixtures ---------------------------------------------------------------

function window_(overrides: Partial<HabitsWindow> = {}): HabitsWindow {
  const cohort = { sessions: 4, cost: 40, costShare: 50, prompts: 200, promptShare: 50, perPrompt: 0.2 };
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
    flagged: cohort,
    clean: { ...cohort },
    cleanCohortUsable: true,
    byModel: [
      { model: 'opus-5', cost: 60, costShare: 75, prompts: 200, sessions: 10, perPrompt: 0.3 },
      { model: 'sonnet-5', cost: 20, costShare: 25, prompts: 200, sessions: 10, perPrompt: 0.1 },
    ],
    modelCostShare: [{ model: 'opus-5', cost: 60, costShare: 75 }],
    byDuration: [{ band: '1-3 h', sessions: 20, cost: 80, costShare: 100, prompts: 400 }],
    byProject: [
      { project: 'armada', cost: 60, prompts: 250, perPrompt: 0.24 },
      { project: 'ccalyze', cost: 20, prompts: 150, perPrompt: 0.13 },
    ],
    anomalyCounts: {},
    tips: [],
    ...overrides,
  };
}

function report_(overrides: Partial<HabitsReport> = {}): HabitsReport {
  return {
    generatedFrom: 'ccalyze',
    unit: 'units',
    current: window_(),
    prior: window_({ range: { from: '2026-08-04', to: '2026-08-10' }, cost: 60 }),
    delta: { cost: 33.3, prompts: 0, perPrompt: 33.3, sessions: 0 },
    headline: { finding: 'volume', why: 'Cost tracked volume.' },
    scorecard: [{ measure: 'Consumption per prompt', prior: 0.2, current: 0.2, verdict: 'flat' }],
    levers: [],
    caveats: { costIsNotional: 'not money' },
    ...overrides,
  };
}

const TODAY = '2026-08-18';

// --- escaping ---------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes the four characters that can break out of text or an attribute', () => {
    assert.equal(escapeHtml('<b> "a" & \'b\''), '&lt;b&gt; &quot;a&quot; &amp; \'b\'');
  });

  it('escapes the ampersand first, so an escape is never double-escaped', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });
});

describe('embedFindings', () => {
  // `</script` closes the element wherever it appears, including inside a JSON
  // string — a project directory named that would otherwise turn the rest of the
  // report into markup.
  it('cannot be terminated by a project label that looks like markup', () => {
    const report = report_({
      current: window_({ byProject: [{ project: '</script><img>', cost: 1, prompts: 1, perPrompt: 1 }] }),
    });
    const embedded = embedFindings(report);
    assert.doesNotMatch(embedded, /<\/script/);
    assert.equal(JSON.parse(embedded).current.byProject[0].project, '</script><img>');
  });
});

// --- the page ---------------------------------------------------------------

describe('renderHabitsHtml', () => {
  it('embeds findings the browser can parse back', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    const block = html.match(/<script id="findings" type="application\/json">\n([\s\S]*?)\n<\/script>/);
    assert.ok(block, 'findings block is present');
    const parsed = JSON.parse(block[1]) as HabitsReport;
    assert.equal(parsed.current.cost, 80);
    assert.equal(parsed.headline.finding, 'volume');
  });

  it('leaves no template slot unfilled', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    // `[[SLOT]]` markers only — the chart code legitimately contains `[["a", …]]`.
    assert.doesNotMatch(html, /\[\[[A-Z]/);
  });

  it('renders the prose the findings imply', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.match(html, /<h1>The extra usage is workload, not a habit<\/h1>/);
    assert.match(html, /Cost tracked volume\./);
    assert.match(html, /<div class="cmdbox">ccalyze --habits 7d --html<\/div>/);
    assert.match(html, /On <strong>2026-08-25<\/strong>/);
  });

  it('keeps the conclusion above the charts, which is the whole point of the order', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.ok(html.indexOf('class="verdict"') < html.indexOf('id="recs"'));
    assert.ok(html.indexOf('id="recs"') < html.indexOf('id="c-dur"'));
    assert.ok(html.indexOf('id="c-dur"') < html.indexOf('id="notes"'));
  });

  it('renders one .rec per recommendation, ranked', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.equal(html.match(/<div class="rec">/g)?.length, 3);
    assert.match(html, /<span class="rank">2<\/span>/);
  });

  it('escapes prose that came out of a project label', () => {
    const html = renderHabitsHtml(
      report_({
        current: window_({
          byProject: [
            { project: '<script>x</script>', cost: 60, prompts: 250, perPrompt: 0.24 },
            { project: 'ccalyze', cost: 20, prompts: 150, perPrompt: 0.13 },
          ],
        }),
      }),
      { today: TODAY },
    );
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt; runs 0.24/);
    // The only <script> tags in the page are the two the template owns.
    assert.equal(html.match(/<script/g)?.length, 2);
  });

  it('renders a single-window report without a comparison', () => {
    const html = renderHabitsHtml(
      report_({
        prior: null,
        delta: null,
        headline: { finding: 'single-window', why: 'No prior window.' },
      }),
      { today: TODAY },
    );
    assert.match(html, /<h1>One window: habits described, not tracked<\/h1>/);
    assert.equal(JSON.parse(html.match(/type="application\/json">\n([\s\S]*?)\n<\/script>/)![1]).prior, null);
  });

  it('titles the page with the window it measures', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.match(html, /<title>Claude Code usage — 2026-08-11 → 2026-08-17<\/title>/);
  });

  it('carries every caveat key it ships a title for', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    for (const key of [
      'costIsNotional',
      'durationIsWallClock',
      'flaggedShareIsHigh',
      'byDayIsStartDated',
      'autoCompactionNeedsRecentTranscripts',
      'reworkIsNotAJudgement',
      'offHoursIsLocalClock',
      'cleanCohort',
      'baselineUnmeasured',
    ]) {
      assert.match(html, new RegExp(`${key}:`), `${key} has a reading-note title`);
    }
  });

  it('is self-contained: nothing is fetched from another host', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link/);
  });
});
