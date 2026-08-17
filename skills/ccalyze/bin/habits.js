/**
 * Habit tracking: compare a window of usage against the window before it.
 *
 * Totals cannot tell "more work" apart from "a worse habit" — the two produce the
 * same bigger number and call for opposite responses. Two comparisons can: *this
 * period versus the last one*, and *this person's cheap sessions versus their
 * expensive ones*. Both live here, and neither compares anyone to anybody else.
 *
 * Everything in this file is a pure function over `CcalyzeOutput`, so the whole
 * analysis is testable without touching a transcript.
 */
/**
 * Flags describing *behaviour*.
 *
 * `high-cost` is deliberately excluded: it is a cost threshold, so counting it
 * makes the flagged-share metric circular — expensive sessions are flagged by
 * definition, and the share trends to 100% for any heavy user regardless of
 * hygiene.
 */
export const BEHAVIOURAL_FLAGS = new Set([
    'no-compaction',
    'long-running',
    'large-transcript',
    'subagent-heavy',
]);
/** A cohort below this share of prompts is too small to use as a baseline. */
export const COHORT_FLOOR = 0.1;
/**
 * ccalyze reads transcripts off disk, so a window can be requested for dates
 * that predate the person's history entirely and still come back "valid": the
 * range is the right length, it is simply almost empty. Comparing a well
 * populated window against a nearly empty one produces a confident, wrong
 * headline — a 30-day pair run against 41 days of history once reported a
 * +11,661% cost delta and called it an efficiency regression.
 *
 * Both floors are needed. ASYMMETRY catches the usual case: one window inside the
 * history, the other reaching past its start. SPARSITY catches what asymmetry
 * cannot see, where BOTH windows are equally empty. Weekends are why neither is
 * strict — a window worked Monday-to-Friday populates ~0.71 of its days,
 * symmetrically, and must keep passing.
 */
export const COVERAGE_ASYMMETRY_FLOOR = 0.6;
export const COVERAGE_SPARSITY_FLOOR = 0.35;
/** Relative move below which a scorecard row reads `flat` rather than a direction. */
export const NOISE_FLOOR = 0.05;
/** Relative move at or above which a row reads `much better` rather than `better`. */
export const STRONG_MOVE = 0.25;
const DURATION_BANDS = [
    ['under 1 h', 0, 60],
    ['1-3 h', 60, 180],
    ['3-8 h', 180, 480],
    ['8-24 h', 480, 1440],
    ['over 24 h', 1440, Infinity],
];
const OVER_24H_BAND = 'over 24 h';
/**
 * A pair of windows that cannot support a habit comparison.
 *
 * Thrown rather than returned: every caller that would ignore it goes on to print
 * deltas that measure transcript retention, and those read as a dramatic finding
 * instead of a broken comparison. `advice` names the shorter length to retry with.
 */
export class HabitsRefusal extends Error {
    advice;
    constructor(message, advice) {
        super(advice ? `${message}\n${advice}` : message);
        this.name = 'HabitsRefusal';
        this.advice = advice;
    }
}
function round(value, places) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}
/** Percent of a whole, 0-100, one decimal. Zero whole reads 0 rather than NaN. */
export function pct(part, whole) {
    return whole ? round((100 * part) / whole, 1) : 0;
}
/** Percent change, or null when there is no prior figure to compare against. */
export function ratioDelta(next, prev) {
    if (next === null || prev === null || !prev)
        return null;
    return round((100 * (next - prev)) / prev, 1);
}
function behavioural(session) {
    return session.flags.some((flag) => BEHAVIOURAL_FLAGS.has(flag));
}
/** Days as a whole number between two `YYYY-MM-DD` dates. Both UTC, so exact. */
function daysBetween(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
function shiftDate(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
/** Inclusive span of a range in days: `2026-08-10..2026-08-16` is 7, not 6. */
export function spanDays(range) {
    return daysBetween(range.from, range.to) + 1;
}
/**
 * The two windows, computed here rather than asked for.
 *
 * The length is the only settable knob; the dates are not. Letting someone pick
 * endpoints after seeing the numbers is the single biggest way a comparison turns
 * into an argument, and it cannot be detected downstream. A *length* is safe to
 * accept because both windows still move together.
 *
 * The current window ends **yesterday**, never today. Both endpoints are
 * inclusive, so either way the span is N calendar days — but a window ending
 * today pairs N-1 complete days plus however much of today has happened against a
 * prior window of N complete ones. Run it at 09:00 and the current window is
 * short by most of a working day; run it at 23:00 and it is nearly whole. That
 * makes the comparison depend on the clock rather than on the habits, and it
 * biases every current-window total — and therefore the direction of every delta
 * — downward by an amount nobody can see in the output.
 *
 * @param length window length in days (7, 15 or 30)
 * @param today  UTC date to count back from, `YYYY-MM-DD`
 */
export function resolveHabitWindows(length, today) {
    if (!Number.isInteger(length) || length < 2) {
        throw new Error(`habit window length must be a whole number of 2 days or more, got ${length}`);
    }
    const currentTo = shiftDate(today, -1); // yesterday: the last complete day
    const currentFrom = shiftDate(currentTo, -(length - 1));
    const priorTo = shiftDate(currentFrom, -1);
    const priorFrom = shiftDate(priorTo, -(length - 1));
    return {
        current: { from: currentFrom, to: currentTo },
        prior: { from: priorFrom, to: priorTo },
    };
}
function countAnomalies(anomalies) {
    const counts = {};
    for (const anomaly of anomalies)
        counts[anomaly.type] = (counts[anomaly.type] ?? 0) + 1;
    return counts;
}
/** Reduce one ccalyze run to the figures a habit comparison reads. */
export function summarizeWindow(output, options = {}) {
    const unit = options.unit ?? 'units';
    const topProjects = options.topProjects ?? 8;
    const sessions = output.sessions;
    const cost = output.summary.totalCostUSD;
    const prompts = output.summary.totalPrompts;
    const cohort = (rows) => {
        const c = rows.reduce((sum, row) => sum + row.costUSD, 0);
        const p = rows.reduce((sum, row) => sum + row.prompts, 0);
        return {
            sessions: rows.length,
            cost: round(c, 2),
            costShare: pct(c, cost),
            prompts: p,
            promptShare: pct(p, prompts),
            perPrompt: p ? round(c / p, 4) : null,
        };
    };
    const flagged = sessions.filter(behavioural);
    const clean = sessions.filter((session) => !behavioural(session));
    const modelTotals = new Map();
    for (const session of sessions) {
        const model = (session.primaryModel || 'unknown').replace('claude-', '');
        const entry = modelTotals.get(model) ?? { cost: 0, prompts: 0, sessions: 0 };
        entry.cost += session.costUSD;
        entry.prompts += session.prompts;
        entry.sessions += 1;
        modelTotals.set(model, entry);
    }
    const byModel = [...modelTotals]
        .map(([model, totals]) => ({
        model,
        cost: round(totals.cost, 2),
        costShare: pct(totals.cost, cost),
        prompts: totals.prompts,
        sessions: totals.sessions,
        perPrompt: totals.prompts ? round(totals.cost / totals.prompts, 4) : null,
    }))
        .sort((a, b) => b.cost - a.cost);
    const modelCostShare = Object.entries(output.byModel)
        .map(([model, summary]) => ({
        model: model.replace('claude-', ''),
        cost: round(summary.costUSD, 2),
        costShare: pct(summary.costUSD, cost),
    }))
        .sort((a, b) => b.cost - a.cost);
    const byDuration = DURATION_BANDS.map(([band, lo, hi]) => {
        const rows = sessions.filter((s) => s.durationMinutes >= lo && s.durationMinutes < hi);
        const c = rows.reduce((sum, row) => sum + row.costUSD, 0);
        return {
            band,
            sessions: rows.length,
            cost: round(c, 2),
            costShare: pct(c, cost),
            prompts: rows.reduce((sum, row) => sum + row.prompts, 0),
        };
    });
    const byProject = output.byProject
        .map((project) => ({
        project: project.project,
        cost: round(project.costUSD, 2),
        prompts: project.prompts,
        perPrompt: project.prompts ? round(project.costUSD / project.prompts, 4) : null,
    }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, topProjects);
    const top3 = [...sessions]
        .sort((a, b) => b.costUSD - a.costUSD)
        .slice(0, 3)
        .reduce((sum, row) => sum + row.costUSD, 0);
    const coldExtra = sessions.reduce((sum, row) => sum + (row.coldStartExtraUSD || 0), 0);
    const anomalyCounts = countAnomalies(output.anomalies);
    const cleanPrompts = clean.reduce((sum, row) => sum + row.prompts, 0);
    return {
        range: output.range,
        unit,
        daysCovered: output.byDay.length,
        cost: round(cost, 2),
        prompts,
        sessions: output.summary.totalSessions,
        perPrompt: prompts ? round(cost / prompts, 4) : null,
        cacheReadShare: round(100 * output.summary.cacheReadRatio, 1),
        coldStart: {
            extra: round(coldExtra, 2),
            share: pct(coldExtra, cost),
            sessions: anomalyCounts['cache_cold_start'] ?? 0,
        },
        noCompactionShare: pct(sessions.filter((s) => s.flags.includes('no-compaction')).length, sessions.length),
        longRunningSessions: sessions.filter((s) => s.flags.includes('long-running')).length,
        top3Share: pct(top3, cost),
        flagged: cohort(flagged),
        clean: cohort(clean),
        cleanCohortUsable: prompts ? cleanPrompts / prompts >= COHORT_FLOOR : false,
        byModel,
        modelCostShare,
        byDuration,
        byProject,
        anomalyCounts,
        tips: output.tips,
    };
}
/** Rename or redact project labels in place. They are directory names. */
function relabelProjects(window, options) {
    window.byProject.forEach((project, index) => {
        if (options.redactProjects) {
            project.project = `project-${index + 1}`;
        }
        else if (options.aliases && project.project in options.aliases) {
            project.project = options.aliases[project.project];
        }
    });
}
/**
 * Size the remaining savings. Two independent estimates, in the same units — so
 * neither rests on the other's assumption.
 */
export function levers(current) {
    const out = [];
    const expensive = current.byModel.find((m) => m.model.startsWith('opus'));
    const cheap = current.byModel.find((m) => m.model.startsWith('sonnet'));
    if (expensive?.perPrompt && cheap?.perPrompt) {
        const gap = (expensive.perPrompt - cheap.perPrompt) * expensive.prompts;
        out.push({
            lever: 'model-mix',
            basis: `${expensive.prompts.toLocaleString('en-US')} ${expensive.model} prompts at ` +
                `${expensive.perPrompt} vs ${cheap.perPrompt}`,
            ceiling: round(gap, 2),
            ceilingShare: pct(gap, current.cost),
            realistic: round(gap / 3, 2),
            realisticShare: pct(gap / 3, current.cost),
            ratio: round(expensive.perPrompt / cheap.perPrompt, 2),
            note: 'Ceiling assumes every expensive-model prompt was avoidable, which it is not. ' +
                'The third is the band worth aiming at.',
        });
    }
    // Two large cohorts of the same person's own work, so the cheaper one's rate is
    // an achieved rate rather than a hypothesis. 200 prompts is the floor at which a
    // project's per-prompt rate stops being an accident of a handful of sessions.
    const priced = current.byProject.filter((p) => p.perPrompt && p.prompts >= 200);
    if (priced.length >= 2) {
        const best = priced.reduce((lowest, p) => (p.perPrompt < lowest.perPrompt ? p : lowest));
        const gap = current.cost - best.perPrompt * current.prompts;
        if (gap > 0) {
            out.push({
                lever: 'project-floor',
                basis: `whole window at ${best.project}'s rate (${best.perPrompt})`,
                ceiling: round(gap, 2),
                ceilingShare: pct(gap, current.cost),
                note: 'Independent of any model assumption — two large cohorts.',
            });
        }
    }
    return out;
}
function over24hShare(window) {
    return window.byDuration.find((band) => band.band === OVER_24H_BAND)?.costShare ?? null;
}
/** Mechanical verdicts. `better`/`worse` about a number, never about a person. */
export function scorecard(current, prior) {
    const row = (measure, get, lowerIsBetter = true) => {
        const a = prior ? get(prior) : null;
        const b = get(current);
        let verdict = 'no-baseline';
        if (a !== null && b !== null) {
            const move = a ? Math.abs(b - a) / Math.abs(a) : b === a ? 0 : 1;
            if (move < NOISE_FLOOR) {
                verdict = 'flat';
            }
            else {
                const improved = lowerIsBetter ? b < a : b > a;
                verdict = improved ? (move >= STRONG_MOVE ? 'much better' : 'better') : 'worse';
            }
        }
        return { measure, prior: a, current: b, verdict };
    };
    return [
        row('Consumption per prompt', (w) => w.perPrompt),
        row('Cold-start premium, share of total', (w) => w.coldStart.share),
        row('Sessions resumed cold after an idle gap', (w) => w.coldStart.sessions),
        row('Share carried by sessions over 24 h', over24hShare),
        row('Top-three session concentration', (w) => w.top3Share),
        row('Cache-read share of input tokens', (w) => w.cacheReadShare, false),
        row('Sessions with no /compact (share)', (w) => w.noCompactionShare),
        row('Share in sessions carrying a behavioural flag', (w) => w.flagged.costShare),
        row('Most-expensive-model share of consumption', (w) => w.modelCostShare[0]?.costShare ?? null),
    ];
}
/**
 * Which of the three explanations the data supports. The order is the point:
 * volume is checked first because it is the most common answer and the one people
 * are least braced for — if a habit had degraded, consumption would have grown
 * *faster* than volume rather than in step with it.
 */
export function headline(current, prior) {
    if (!prior) {
        return {
            finding: 'single-window',
            why: 'No prior window — habits cannot be tracked, only described.',
        };
    }
    const dc = ratioDelta(current.cost, prior.cost);
    const dp = ratioDelta(current.prompts, prior.prompts);
    const dpp = ratioDelta(current.perPrompt, prior.perPrompt);
    if (dc !== null && dp !== null && dp > 10 && dpp !== null && dpp <= 2) {
        return {
            finding: 'volume',
            why: `Consumption rose ${dc}% on ${dp}% more prompts; per-prompt moved ${dpp}%. ` +
                'Cost tracked volume, so the rise is workload.',
        };
    }
    if (dpp !== null && dpp > 5) {
        return {
            finding: 'efficiency-regression',
            why: `Per-prompt consumption rose ${dpp}% — cost grew faster than volume, ` +
                'which points at a habit rather than workload.',
        };
    }
    return {
        finding: 'mixed',
        why: `Consumption ${dc}%, prompts ${dp}%, per-prompt ${dpp}% — no single ` +
            'explanation dominates; read the scorecard.',
    };
}
/**
 * Refuse a pair that cannot support a habit comparison, and warn about a gap.
 *
 * `resolveHabitWindows` cannot produce an unequal or overlapping pair, but the
 * checks stay: this module is also called with hand-built ranges, and an unequal
 * pair makes every delta a measurement of the window rather than of the habit,
 * which nothing downstream can detect. Overlap is the same failure with the
 * opposite sign — a session counted in both windows is compared against itself.
 * Both are fatal. A gap only weakens adjacency, so it warns.
 *
 * @returns non-fatal warnings, for the caller to print
 * @throws  HabitsRefusal when the pair is unusable
 */
export function validateWindowPair(current, prior) {
    const warnings = [];
    const currentSpan = spanDays(current.range);
    const priorSpan = spanDays(prior.range);
    if (currentSpan !== priorSpan) {
        throw new HabitsRefusal(`unequal windows: current spans ${currentSpan} days ` +
            `(${current.range.from}..${current.range.to}), prior spans ${priorSpan} ` +
            `(${prior.range.from}..${prior.range.to}).`, 'Equal length, adjacent, no overlap — otherwise the deltas measure the window, ' +
            'not the habit. Re-run with a single --habits length.');
    }
    if (prior.range.to >= current.range.from) {
        throw new HabitsRefusal(`overlapping windows: prior ends ${prior.range.to}, current starts ${current.range.from}.`, 'A session counted in both windows is compared against itself.');
    }
    const gap = daysBetween(prior.range.to, current.range.from) - 1;
    if (gap) {
        warnings.push(`warning: ${gap} day(s) unmeasured between the windows ` +
            `(${prior.range.to} .. ${current.range.from}). They should sit back to back.`);
    }
    checkCoverage(current, prior, currentSpan);
    return warnings;
}
/**
 * Refuse a pair where one window has far less data on disk than the other.
 *
 * An equal-length, adjacent, non-overlapping pair can still be meaningless: a
 * window reaching back before the person's history comes back almost empty rather
 * than failing, and the resulting deltas describe transcript retention, not
 * habits.
 */
export function checkCoverage(current, prior, span) {
    const [thin, thick] = [current.daysCovered, prior.daysCovered].sort((a, b) => a - b);
    const advice = `Only ${thick} day(s) of transcript history are populated in the better-covered ` +
        `window, so a ${span}-day pair cannot be supported. Re-run with a shorter length ` +
        `(try ${Math.max(7, Math.floor(thick / 2))}d).`;
    if (thick && thin / thick < COVERAGE_ASYMMETRY_FLOOR) {
        throw new HabitsRefusal(`lopsided coverage: current window has ${current.daysCovered} populated day(s), ` +
            `prior has ${prior.daysCovered}, over ${span}-day windows.\n` +
            'The deltas would measure how far back transcripts survive on disk, not a ' +
            'change in habit.', advice);
    }
    for (const [label, days] of [
        ['current', current.daysCovered],
        ['prior', prior.daysCovered],
    ]) {
        if (days / span < COVERAGE_SPARSITY_FLOOR) {
            throw new HabitsRefusal(`window too sparse: ${label} window has ${days} populated day(s) out of ${span}.\n` +
                'There is not enough data in it to compare.', advice);
        }
    }
}
/**
 * The whole habit report: two windows, their deltas, the headline, the scorecard,
 * the levers and the caveats that keep them honest.
 *
 * @param priorOutput the earlier window, or null for a single-window read (a
 *   first-ever run with less history than a pair needs — say plainly that habits
 *   are being described, not tracked)
 * @returns the report plus any non-fatal warnings
 * @throws  HabitsRefusal when the pair cannot support a comparison
 */
export function buildHabitsReport(currentOutput, priorOutput, options = {}) {
    const unit = options.unit ?? 'units';
    const current = summarizeWindow(currentOutput, options);
    const prior = priorOutput ? summarizeWindow(priorOutput, options) : null;
    const warnings = prior ? validateWindowPair(current, prior) : [];
    for (const window of [current, prior]) {
        if (window)
            relabelProjects(window, options);
    }
    const delta = prior
        ? {
            cost: ratioDelta(current.cost, prior.cost),
            prompts: ratioDelta(current.prompts, prior.prompts),
            perPrompt: ratioDelta(current.perPrompt, prior.perPrompt),
            sessions: ratioDelta(current.sessions, prior.sessions),
        }
        : null;
    const report = {
        generatedFrom: 'ccalyze',
        unit,
        current,
        prior,
        delta,
        headline: headline(current, prior),
        scorecard: scorecard(current, prior),
        levers: levers(current),
        caveats: {
            costIsNotional: 'ccalyze prices tokens at published per-token API list rates, which is ' +
                'explicitly not what a subscription charges. Treat the figure as a quota ' +
                'proxy, never as spend.',
            durationIsWallClock: 'Session duration runs from first to last message, so idle and overnight ' +
                'time counts. It is not a working-hours measure.',
            flaggedShareIsHigh: 'no-compaction fires at 30 prompts and long-running at three hours, so ' +
                'sustained agentic work trips one by default. Read the direction, not the level.',
            byDayIsStartDated: "A session's whole consumption is stamped on the date it started, so " +
                'per-day figures are not daily effort.',
            cleanCohort: `Unflagged sessions hold ${current.clean.promptShare}% of prompts` +
                (current.cleanCohortUsable
                    ? ' — usable as a baseline.'
                    : ` — below the ${Math.round(COHORT_FLOOR * 100)}% floor, so the ` +
                        'flagged/unflagged split is not a usable baseline. Use the model split ' +
                        'and the project split instead.'),
            baselineUnmeasured: 'Per-request baseline (MCP tool definitions plus instruction files) is not ' +
                'in this data. Only /context converts it into a share of the window.',
        },
    };
    return { report, warnings };
}
//# sourceMappingURL=habits.js.map