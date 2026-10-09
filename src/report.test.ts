import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

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
    longSessionPremium: 2.4,
    rereadPerOutput: 150,
    effectiveness: {
      instructions: 50,
      turnsPerInstruction: 12.5,
      perInstruction: 1.6,
      correctionShare: 8,
      interruptRate: 4,
      toolErrorShare: 6.5, usageLimitStops: 0,
    },
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
    scorecard: [
      { measure: 'Consumption per prompt', group: 'consumption', prior: 0.2, current: 0.2, verdict: 'flat', unit: 'units', lowerIsBetter: true, target: 'No fixed target.' },
      { measure: 'Interrupts per 100 instructions', group: 'effectiveness', prior: 2, current: 4, verdict: 'worse', unit: 'per 100', lowerIsBetter: true, target: '0 is ideal.' },
    ],
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
    assert.match(html, /<div class="cmdbox">ccalyze --habits 7d<\/div>/);
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
      'instructionsAreTyped',
      'correctionIsHeuristic',
      'toolErrorsIncludeDenials',
      'cleanCohort',
      'baselineUnmeasured',
    ]) {
      assert.match(html, new RegExp(`${key}:`), `${key} has a reading-note title`);
    }
  });

  it('renders effectiveness rows in their own table, apart from the scorecard', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.match(html, /<tbody id="effectiveness"><\/tbody>/);
    assert.match(html, /How well the work flowed/);
    assert.match(html, /r\.group === "effectiveness"/);
    assert.match(html, /r\.group !== "effectiveness"/, 'an ungrouped row stays in the scorecard');
  });

  it('prints the effectiveness paragraph the findings imply', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.match(html, /Across 50 typed instructions, each typed instruction set off 12\.5 agent turns/);
  });

  it('is self-contained: nothing is fetched from another host', () => {
    const html = renderHabitsHtml(report_(), { today: TODAY });
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<link/);
  });

  describe('rendered scorecard rows', () => {
    // Runs the page's own script against a stub DOM, so the assertions are about the
    // HTML the page really builds, not about strings inside its source.
    const renderRows = (scorecard: HabitsReport['scorecard']) => {
      const html = renderHabitsHtml(report_({ scorecard }), { today: TODAY });
      const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
      const findings = html.match(/type="application\/json">\n([\s\S]*?)\n<\/script>/)![1];
      const els = new Map<string, { innerHTML: string; textContent: string; append: () => void }>();
      const el = (id: string) => {
        if (!els.has(id)) els.set(id, { innerHTML: '', textContent: id === 'findings' ? findings : '', append() {} });
        return els.get(id)!;
      };
      const document = { getElementById: el, querySelectorAll: () => [], createElement: () => ({ className: '', style: {}, append() {}, addEventListener() {}, setAttribute() {} }) };
      runInNewContext(scripts[scripts.length - 1], { document, innerWidth: 1000, innerHeight: 800 });
      return { scorecard: els.get('scorecard')!.innerHTML, effectiveness: els.get('effectiveness')!.innerHTML };
    };
    const base = {
      group: 'consumption' as const,
      prior: 5,
      current: 0,
      verdict: 'much better' as const,
      goalMet: null,
      unit: '%',
      lowerIsBetter: true,
      target: '0%',
    };

    it('shows GOOD, in the good colour, for a row that reaches its target', () => {
      const out = renderRows([{ ...base, measure: 'Reaches', goalMet: true }]);
      assert.match(out.scorecard, /<span class="chip good"[^>]*>good<\/span>/);
      assert.doesNotMatch(out.scorecard, />much better</, 'the chip text is GOOD, not the trend');
    });

    it('keeps the trend verdict for a row that misses its target or has none', () => {
      const out = renderRows([
        { ...base, measure: 'Misses', current: 3, verdict: 'worse', goalMet: false },
        { ...base, measure: 'Untargeted', goalMet: null },
      ]);
      assert.match(out.scorecard, /<span class="chip no"[^>]*>worse<\/span>/);
      assert.match(out.scorecard, /<span class="chip ok"[^>]*>much better<\/span>/);
      assert.doesNotMatch(out.scorecard, /chip good/);
    });

    it('puts a collapsible explanation under the measure, one paragraph per block, escaped', () => {
      const out = renderRows([
        { ...base, measure: 'Explained', about: 'First <b>paragraph</b>.\n\nSecond one.' },
        { ...base, measure: 'Plain' },
      ]);
      assert.match(
        out.scorecard,
        /Explained\s*<details class="about"><summary>What this means<\/summary><div class="body"><p>First &lt;b&gt;paragraph&lt;\/b&gt;\.<\/p><p>Second one\.<\/p><\/div><\/details>/,
      );
      assert.equal(out.scorecard.match(/<details/g)?.length, 1, 'a row with no explanation gets none');
    });

    it('applies the same rendering to the effectiveness table', () => {
      const out = renderRows([{ ...base, group: 'effectiveness', measure: 'Flow', goalMet: true, about: 'Why.' }]);
      assert.match(out.effectiveness, /chip good/);
      assert.match(out.effectiveness, /<details class="about">/);
      assert.equal(out.scorecard, '');
    });
  });
});
