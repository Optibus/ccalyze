/**
 * Deterministic prose for the HTML habit report.
 *
 * The report used to be rendered by an agent filling `[[SLOT]]`s in a template by
 * hand, under one strict rule: never write a figure that is not in the findings
 * JSON. That rule is what makes the prose codeable — every sentence here is a
 * recipe over `HabitsReport` (pick the top lever, pick the scorecard rows that
 * read `much better`, find the max/min in `byDuration`/`byModel`/`byProject`), so
 * two runs on the same JSON produce the same words, and no paragraph can ever
 * contradict the table beside it.
 *
 * Pure functions over `HabitsReport`, like `habits.ts` — no filesystem, no
 * clock beyond an injectable `today`, so every branch is testable.
 */
import { spanDays } from "./habits.js";
/** Flagged-session cost share the re-measure aims below. */
export const FLAGGED_SHARE_TARGET = 40;
/**
 * Sessions per window below which one scorecard row is anecdote, not a direction.
 *
 * `2 × N`, the floor `references/habits.md` states: a `7d` window can land on a
 * quiet week, and a row that swings on four sessions reads exactly like a habit
 * change that never happened.
 */
export function thinSampleFloor(lengthDays) {
    return 2 * lengthDays;
}
function n(value) {
    return value.toLocaleString('en-US');
}
/** A window value and its prior, as the scorecard shows them: raw, no unit. */
function move(row) {
    return `${row.prior === null ? '—' : n(row.prior)} → ${row.current === null ? '—' : n(row.current)}`;
}
function shiftDate(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function rowsWith(report, ...verdicts) {
    return report.scorecard.filter((row) => verdicts.includes(row.verdict));
}
/** The largest lever, or null when nothing in the data sizes above zero. */
export function topLever(report) {
    if (!report.levers.length)
        return null;
    return [...report.levers].sort((a, b) => b.ceiling - a.ceiling)[0];
}
/** The share a lever is worth aiming at: `realistic` where it exists, else the ceiling. */
function leverAim(lever) {
    return lever.realisticShare !== undefined && lever.realistic !== undefined
        ? { share: lever.realisticShare, amount: lever.realistic, hedged: true }
        : { share: lever.ceilingShare, amount: lever.ceiling, hedged: false };
}
/** The duration band carrying the most of the window. */
function heaviestBand(window) {
    return window.byDuration.reduce((top, band) => (band.costShare > top.costShare ? band : top), window.byDuration[0]);
}
/**
 * Prompts a cohort needs before its per-prompt rate is a rate rather than an
 * accident of a handful of sessions — the floor `habits.ts` already applies when
 * it sizes the project-floor lever.
 */
export const COHORT_PROMPT_FLOOR = 200;
/**
 * The dearest and cheapest cohort by per-prompt rate.
 *
 * Cohorts under the prompt floor are set aside first, because an unfiltered
 * max/min reaches straight for the thinnest row in the window: a real run
 * compared a 4-prompt model against a 120-prompt one and called it a 7× gap,
 * while the lever beside it priced 10,718 prompts. Where fewer than two cohorts
 * clear the floor the thin rows come back anyway, flagged, so the caption can say
 * the sample is thin instead of quoting the ratio as if it meant something.
 */
function spread(rows) {
    const priced = rows.filter((row) => row.perPrompt !== null);
    const solid = priced.filter((row) => row.prompts >= COHORT_PROMPT_FLOOR);
    const pool = solid.length >= 2 ? solid : priced;
    if (pool.length < 2)
        return null;
    const sorted = [...pool].sort((a, b) => b.perPrompt - a.perPrompt);
    return { dear: sorted[0], cheap: sorted[sorted.length - 1], thin: solid.length < 2 };
}
const HEADLINES = {
    volume: 'The extra usage is workload, not a habit',
    'efficiency-regression': 'A habit is driving this, not more work',
    mixed: 'No single explanation dominates — read the scorecard',
    'single-window': 'One window: habits described, not tracked',
};
/**
 * Windows whose session count is too thin to read a direction into.
 *
 * Named rather than quietly dropped: the honest move is to say the sample was
 * thin and offer the longer re-run, not to defend the figure.
 */
function thinWindows(report, lengthDays) {
    const floor = thinSampleFloor(lengthDays);
    const thin = [];
    if (report.current.sessions < floor)
        thin.push(`the current window (${n(report.current.sessions)} sessions)`);
    if (report.prior && report.prior.sessions < floor) {
        thin.push(`the prior window (${n(report.prior.sessions)} sessions)`);
    }
    return thin;
}
function conclusionText(report, unit) {
    const { current, prior, headline } = report;
    // headline.why already carries the establishing figures, computed once in
    // habits.ts — quoting it is what keeps the paragraph and the tiles in step.
    const parts = [headline.why];
    if (headline.finding === 'single-window' || !prior) {
        parts.push(`The window covers ${n(current.prompts)} prompts across ${n(current.sessions)} sessions ` +
            `on ${n(current.daysCovered)} days with data, at ${current.perPrompt === null ? '—' : current.perPrompt} ` +
            `${unit} per prompt. Every figure below describes that window; none of it is a trend yet.`);
        return parts.join(' ');
    }
    parts.push(`Sessions carrying a behavioural flag hold ${current.flagged.costShare}% of the window ` +
        `against ${prior.flagged.costShare}% before, and the three dearest sessions hold ` +
        `${current.top3Share}% against ${prior.top3Share}%.`);
    if (headline.finding === 'volume') {
        parts.push('Cost tracking volume is the result that means there is no habit to fix here — ' +
            'a degraded habit would have grown consumption faster than prompts, not with them.');
    }
    else if (headline.finding === 'efficiency-regression') {
        const worse = rowsWith(report, 'worse');
        if (worse.length) {
            parts.push(`The rows moving the wrong way are ${worse
                .slice(0, 2)
                .map((row) => `${row.measure.toLowerCase()} (${move(row)})`)
                .join(' and ')}.`);
        }
    }
    else {
        const improved = rowsWith(report, 'much better', 'better').length;
        const worse = rowsWith(report, 'worse').length;
        parts.push(`${improved} of ${report.scorecard.length} measures improved and ${worse} moved the wrong ` +
            'way, so the scorecard is where the reading is, not the totals.');
    }
    return parts.join(' ');
}
function outlookText(report, unit, lengthDays) {
    const { current, prior } = report;
    const parts = [];
    const worse = rowsWith(report, 'worse');
    if (!prior) {
        parts.push('There is no prior window, so nothing here has a direction — only a level.');
    }
    else if (worse.length) {
        parts.push(`What did not improve: ${worse
            .map((row) => `${row.measure.toLowerCase()} (${move(row)})`)
            .join('; ')}.`);
    }
    else {
        parts.push('No measure in the scorecard moved the wrong way.');
    }
    const lever = topLever(report);
    if (lever) {
        const aim = leverAim(lever);
        parts.push(`The remaining savings sit in ${lever.basis} — ${n(lever.ceiling)} ${unit} at the ceiling ` +
            `(${lever.ceilingShare}% of the window)` +
            (aim.hedged ? `, of which ${n(aim.amount)} (${aim.share}%) is the band worth aiming at.` : '.'));
    }
    else {
        parts.push('No lever in this data sizes above zero: on the measures ccalyze can see, the sessions ' +
            'are already clean. If the limit still binds, that is the finding — the ceiling is the ' +
            'constraint, and the follow-up is headroom rather than more tuning.');
    }
    if (!current.cleanCohortUsable) {
        parts.push(`Unflagged sessions hold only ${current.clean.promptShare}% of prompts, too small a cohort ` +
            'to use as a baseline, so the model and project splits below stand in for it.');
    }
    const thin = thinWindows(report, lengthDays);
    if (thin.length) {
        parts.push(`Read single rows as anecdote rather than direction: ${thin.join(' and ')} sits under the ` +
            `${n(thinSampleFloor(lengthDays))}-session floor for a ${lengthDays}-day window. ` +
            'A longer re-run at 15d or 30d is the fix, not a re-reading of these figures.');
    }
    return parts.join(' ');
}
/** The first recommendation: the largest lever, or the honest absence of one. */
function leverRecommendation(report, unit) {
    const lever = topLever(report);
    const { current } = report;
    if (!lever) {
        const worse = rowsWith(report, 'worse');
        if (worse.length) {
            const row = worse[0];
            return {
                rank: 1,
                title: `Pull ${row.measure.toLowerCase()} back to where it was`,
                body: 'No sized lever came out of this window, so the largest available move is the row ' +
                    'that regressed. Nothing else in the data prices higher than returning it.',
                evidence: worse.slice(0, 3).map((r) => `${r.measure}: ${move(r)} · ${r.verdict}`),
                size: `${row.current === null ? '—' : n(row.current)}`,
                sizeLabel: 'the row to return',
            };
        }
        return {
            rank: 1,
            title: 'Ask for headroom, not for more optimisation',
            body: 'The sessions are clean on every measure here and no lever sizes above zero. There are ' +
                'no savings in this data to find, so the honest ask is a higher ceiling — with an ' +
                'explicit end date, so it gets re-measured rather than becoming the new normal.',
            evidence: [
                `flagged share of ${unit}: ${current.flagged.costShare}%`,
                `cache-read share: ${current.cacheReadShare}%`,
                `per prompt: ${current.perPrompt === null ? '—' : current.perPrompt} ${unit}`,
            ],
            size: 'None',
            sizeLabel: 'savings in the data',
        };
    }
    const aim = leverAim(lever);
    if (lever.lever === 'model-mix') {
        return {
            rank: 1,
            title: 'Move the prompts that do not need the expensive model off it',
            body: `The gap is measured on this window's own work, not a benchmark: ${lever.basis}` +
                (lever.ratio ? `, a ${lever.ratio}× rate difference. ` : '. ') +
                'Start with the prompts that already have cheaper precedent — mechanical edits, ' +
                'reruns, and anything a previous session solved the same way.',
            evidence: [
                `basis: ${lever.basis}`,
                `ceiling: ${n(lever.ceiling)} ${unit} (${lever.ceilingShare}% of the window)`,
                aim.hedged ? `realistic: ${n(aim.amount)} ${unit} (${aim.share}%)` : `no hedge — ceiling is the estimate`,
            ],
            size: `${aim.share}%`,
            sizeLabel: 'of the window',
        };
    }
    return {
        rank: 1,
        title: 'Close the gap to the cheapest project doing comparable work',
        body: `Two large cohorts of the same person's own work, so the cheaper rate is achieved rather ` +
            `than hypothetical: ${lever.basis}. The cheap end is the target because it already happened.`,
        evidence: [
            `basis: ${lever.basis}`,
            `ceiling: ${n(lever.ceiling)} ${unit} (${lever.ceilingShare}% of the window)`,
            lever.note,
        ],
        size: `${aim.share}%`,
        sizeLabel: 'of the window',
    };
}
/**
 * The baseline recommendation, which is always second and always unsized.
 *
 * MCP tool definitions and instruction files ride on every request and this data
 * cannot see them, so the CLI can state the question but never the figure. It is
 * the one finding that can overturn everything above it.
 */
function baselineRecommendation(report) {
    return {
        rank: 2,
        title: 'Measure the per-request baseline',
        body: 'Run /context in the heaviest repo. MCP tool definitions and instruction files are ' +
            're-sent ahead of every prompt, and this data cannot see them. Only /context converts ' +
            'that into a share of the window, and it cannot be automated.',
        evidence: [
            report.caveats.baselineUnmeasured ?? 'Per-request baseline is not in this data.',
            `prompts it would multiply against: ${n(report.current.prompts)}`,
        ],
        size: 'Unknown',
        sizeLabel: 'the open question',
    };
}
/** The third recommendation: bank whatever held, or say plainly that nothing did. */
function heldRecommendation(report) {
    const strong = rowsWith(report, 'much better');
    const held = strong.length ? strong : rowsWith(report, 'better');
    if (!held.length) {
        const flat = rowsWith(report, 'flat');
        return {
            rank: 3,
            title: report.prior ? 'Nothing is banked yet — set the baseline and re-run' : 'Set the baseline, then re-run',
            body: report.prior
                ? 'No measure improved enough to keep. That makes this run the baseline: the next one at ' +
                    'the same length is the first that can show a habit change holding.'
                : 'A single window cannot show anything holding. This run is the baseline; the next one ' +
                    'at the same length is the first comparison.',
            evidence: flat.length
                ? flat.slice(0, 3).map((row) => `${row.measure}: ${move(row)} · flat`)
                : ['no scorecard row moved beyond the 5% noise floor'],
            size: 'Baseline',
            sizeLabel: 'this run',
        };
    }
    return {
        rank: 3,
        title: 'Keep doing what already worked',
        body: `${held.length === 1 ? 'One measure' : `${held.length} measures`} moved ` +
            `${strong.length ? 'strongly ' : ''}in the right direction. Whatever produced that is the ` +
            'cheapest change available, because it is already in the habit — losing it costs more than ' +
            'any lever above gains.',
        evidence: held.slice(0, 3).map((row) => `${row.measure}: ${move(row)} · ${row.verdict}`),
        size: 'Held',
        sizeLabel: 'already banked',
    };
}
function durationCaptionText(report, unit) {
    const { current, prior } = report;
    const top = heaviestBand(current);
    if (!top || !top.sessions) {
        return 'No session in this window carries a duration band with consumption in it.';
    }
    const priorBand = prior?.byDuration.find((band) => band.band === top.band);
    return (`Sessions of ${top.band} carry ${top.costShare}% of the window's ${unit} across ` +
        `${n(top.sessions)} sessions and ${n(top.prompts)} prompts` +
        (priorBand ? `, against ${priorBand.costShare}% in the earlier window` : '') +
        '. Duration is wall clock, so idle and overnight time counts — read the share, not the hours.');
}
/** `— on a thin sample` where a cohort is under the prompt floor, else nothing. */
function thinNote(thin) {
    return thin
        ? ` Both cohorts are under the ${COHORT_PROMPT_FLOOR}-prompt floor, so read this as an ` +
            'anecdote rather than a rate.'
        : '';
}
function modelCaptionText(report, unit) {
    const pair = spread(report.current.byModel);
    if (!pair) {
        const only = report.current.byModel.find((m) => m.perPrompt !== null);
        return only
            ? `Only ${only.model} is priced in this window, at ${only.perPrompt} ${unit} per prompt ` +
                `across ${n(only.prompts)} prompts — there is no second model here to compare it against.`
            : 'No model in this window carries a per-prompt rate.';
    }
    const { dear, cheap, thin } = pair;
    const ratio = cheap.perPrompt ? Math.round((dear.perPrompt / cheap.perPrompt) * 100) / 100 : null;
    return (`On this window's own work, ${dear.model} runs ${dear.perPrompt} ${unit} per prompt across ` +
        `${n(dear.prompts)} prompts and ${cheap.model} runs ${cheap.perPrompt} across ` +
        `${n(cheap.prompts)}` +
        (ratio ? ` — a ${ratio}× difference` : '') +
        '. A session runs more than one model, so these are per-session primary-model rates, ' +
        `not a token-level split.${thinNote(thin)}`);
}
function projectCaptionText(report, unit) {
    const pair = spread(report.current.byProject);
    const stands = report.current.cleanCohortUsable
        ? ''
        : ' The clean-cohort split was unusable in this window, so this spread stands in for it.';
    if (!pair) {
        return `Fewer than two projects in this window carry a per-prompt rate, so there is no spread to read.${stands}`;
    }
    const { dear, cheap, thin } = pair;
    return (`${dear.project} runs ${dear.perPrompt} ${unit} per prompt over ${n(dear.prompts)} prompts and ` +
        `${cheap.project} runs ${cheap.perPrompt} over ${n(cheap.prompts)}. The cheap end is the ` +
        `achievable target because it is the same person's own achieved rate, not a benchmark.` +
        `${thinNote(thin)}${stands}`);
}
function remeasureProse(report, lengthDays, today) {
    const { current, prior } = report;
    const targets = [];
    if (current.perPrompt !== null) {
        targets.push(`consumption per prompt below ${current.perPrompt}`);
    }
    if (current.flagged.costShare > FLAGGED_SHARE_TARGET) {
        targets.push(`flagged-session share under ${FLAGGED_SHARE_TARGET}% (it is ${current.flagged.costShare}%)`);
    }
    else {
        targets.push(`flagged-session share holding at or under ${current.flagged.costShare}%`);
    }
    const lever = topLever(report);
    if (lever) {
        const aim = leverAim(lever);
        targets.push(`${aim.share}% of the window recovered from ${lever.lever}`);
    }
    const sentence = `Targets: ${targets.join('; ')}. Re-run at the same length — a ${lengthDays}d run followed ` +
        `by a 30d one measures a different thing and cannot tell you whether the change held. ` +
        (prior
            ? 'If every target holds and the limit still binds, that settles it: the usage is ' +
                'efficient and the ceiling is the constraint, which is a request for headroom rather ' +
                'than more tuning.'
            : 'The next run is the first that can compare anything, because this one has no prior window.');
    return {
        date: shiftDate(today, lengthDays),
        command: `ccalyze --habits ${lengthDays}d --html`,
        targets: sentence,
    };
}
/**
 * Every sentence in the HTML report, derived from the findings JSON.
 *
 * @param today `YYYY-MM-DD` the re-measure date counts from; defaults to the clock
 */
export function buildProse(report, options = {}) {
    const unit = report.unit || 'units';
    const lengthDays = spanDays(report.current.range);
    const today = options.today ?? new Date().toISOString().slice(0, 10);
    return {
        title: `Claude Code usage — ${report.current.range.from} → ${report.current.range.to}`,
        headline: HEADLINES[report.headline.finding],
        conclusion: conclusionText(report, unit),
        outlook: outlookText(report, unit, lengthDays),
        recommendations: [
            leverRecommendation(report, unit),
            baselineRecommendation(report),
            heldRecommendation(report),
        ],
        durationCaption: durationCaptionText(report, unit),
        modelCaption: modelCaptionText(report, unit),
        projectCaption: projectCaptionText(report, unit),
        remeasure: remeasureProse(report, lengthDays, today),
    };
}
//# sourceMappingURL=prose.js.map