import type { Anomaly, CcalyzeOutput } from './types.ts';
import { isPricingKnown } from './cost.ts';

/**
 * Main-thread model changes in one session before churn is worth mentioning.
 *
 * This counts only `mainModelSwitchCount` — subagent churn is excluded, because
 * subagents alternate models constantly and break no cache doing it. What is
 * left is the thing that actually costs: the prompt cache is keyed to the model,
 * so every main-thread switch discards the cached prefix and pays to rebuild it.
 *
 * Measured across real sessions, main-thread switches sit at p50=0, p90=4,
 * max=5 — so 5 is the top of the observed range, not a round number.
 */
export const MAIN_CHURN_SWITCH_THRESHOLD = 5;

/**
 * Cache-read share below which a session is leaving real money on the table.
 *
 * Calibrated against measured sessions, which cluster between 84% and 99% with a
 * median near 94%. 90% is roughly the bottom quartile. The earlier instinct — to
 * treat 80% as the line — was measured and rejected: nothing real ever falls
 * that low, so the rule would never have fired.
 */
export const LOW_CACHE_RATIO_THRESHOLD = 0.9;

/**
 * Cost floor for the cache-efficiency rule. A poorly-cached session that cost
 * cents is noise; the ratio only matters where it multiplies into something.
 */
export const LOW_CACHE_MIN_COST_USD = 5;

/**
 * Cold rebuilds in one session before it reads as a habit rather than a lunch
 * break. Returning to a session once after a long gap is normal.
 */
export const COLD_START_MIN_EVENTS = 3;

export function detectAnomalies(output: CcalyzeOutput): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const session of output.sessions) {
    if (session.flags.includes('no-compaction')) {
      anomalies.push({
        type: 'session_no_compaction',
        severity: 'high',
        sessionId: session.id,
        detail: `${session.prompts} prompts over ${formatDuration(session.durationMinutes)} without /compact — transcript is ${session.transcriptSizeMB}MB`,
      });
    }

    if (session.flags.includes('long-running')) {
      anomalies.push({
        type: 'long_running_session',
        severity: 'medium',
        sessionId: session.id,
        detail: `Session ran for ${formatDuration(session.durationMinutes)} — consider starting fresh sessions`,
      });
    }

    if (session.flags.includes('large-transcript')) {
      anomalies.push({
        type: 'large_transcript',
        severity: 'high',
        sessionId: session.id,
        detail: `Session transcript is ${session.transcriptSizeMB}MB — context grew very large`,
      });
    }
  }

  // Cache efficiency — the single best predictor of quota burn. Every turn
  // resends the whole conversation; what varies between two people doing the
  // same work is how much of that resend is served from cache. Gated on cost so
  // the rule only speaks where the ratio multiplies into something.
  const poorlyCached = output.sessions
    .filter(
      (s) => s.costUSD >= LOW_CACHE_MIN_COST_USD && s.cacheReadRatio < LOW_CACHE_RATIO_THRESHOLD,
    )
    .sort((a, b) => a.cacheReadRatio - b.cacheReadRatio);

  for (const session of poorlyCached) {
    anomalies.push({
      type: 'low_cache_efficiency',
      severity: 'medium',
      sessionId: session.id,
      detail:
        `Only ${(session.cacheReadRatio * 100).toFixed(1)}% of this $${session.costUSD.toFixed(2)} ` +
        `session's input came from cache (healthy sessions run 90-99%) — ` +
        `something kept invalidating the cached prefix`,
    });
  }

  // Cold starts — the cache expires after an hour, so returning to a big session
  // later re-sends the whole conversation at the write rate. It looks like a
  // small question and is often the priciest turn of the day.
  const rebuilders = output.sessions
    .filter((s) => s.coldStarts >= COLD_START_MIN_EVENTS)
    .sort((a, b) => b.coldStartExtraUSD - a.coldStartExtraUSD);

  for (const session of rebuilders) {
    anomalies.push({
      type: 'cache_cold_start',
      severity: 'medium',
      sessionId: session.id,
      detail:
        `Rebuilt its context cache from cold ${session.coldStarts} times after long idle gaps, ` +
        `a $${session.coldStartExtraUSD.toFixed(2)} premium over what a warm cache would have cost`,
    });
  }

  // Concurrent opus sessions
  const opusSessions = output.sessions.filter(s =>
    s.primaryModel.includes('opus') && s.startTime && s.endTime
  );
  if (opusSessions.length >= 3) {
    const events: { time: number; type: 'start' | 'end' }[] = [];
    for (const s of opusSessions) {
      events.push({ time: new Date(s.startTime).getTime(), type: 'start' });
      events.push({ time: new Date(s.endTime).getTime(), type: 'end' });
    }
    events.sort((a, b) => a.time - b.time || (a.type === 'end' ? -1 : 1));

    let concurrent = 0;
    let maxConcurrent = 0;
    for (const event of events) {
      concurrent += event.type === 'start' ? 1 : -1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }

    if (maxConcurrent >= 3) {
      anomalies.push({
        type: 'concurrent_opus',
        severity: 'medium',
        detail: `${maxConcurrent} Opus sessions running concurrently — consider using cheaper models for parallel work`,
      });
    }
  }

  // Model churn — only available on --deep runs, which carry the churn counts.
  // Counted on the MAIN THREAD only: subagent churn is normal and breaks no
  // cache, and counting it was why this signal used to need a "probably fine"
  // caveat. A main-thread switch genuinely discards the cached prefix. Still
  // gated on cost, since the rebuild only hurts where the context is expensive.
  // Churniest first.
  if (output.deep) {
    const churny = output.deep.sessions
      .filter(
        (s) => s.mainModelSwitchCount >= MAIN_CHURN_SWITCH_THRESHOLD && s.flags.includes('high-cost'),
      )
      .sort((a, b) => b.mainModelSwitchCount - a.mainModelSwitchCount);

    for (const session of churny) {
      anomalies.push({
        type: 'high_model_churn',
        severity: 'medium',
        sessionId: session.id,
        detail:
          `${session.mainModelSwitchCount} main-thread model switches in a ` +
          `$${session.costUSD.toFixed(2)} session — the prompt cache is keyed to the model, ` +
          `so each switch threw away the cached context and paid to rebuild it`,
      });
    }
  }

  // Unknown model pricing — an unlisted model is costed at Opus rates, which is
  // a guess. Surface it: silent fallback is how Sonnet was billed as Opus for
  // months. This makes the tool report its own staleness when a model ships.
  const unpriced = Object.keys(output.byModel).filter((m) => !isPricingKnown(m)).sort();
  if (unpriced.length > 0) {
    anomalies.push({
      type: 'unknown_model_pricing',
      severity: 'medium',
      detail:
        `No published pricing for ${unpriced.join(', ')} — cost estimated at Opus rates. ` +
        `Update MODEL_PRICING in src/cost.ts; until then these figures are a guess.`,
    });
  }

  // Cost spike detection
  if (output.byDay.length >= 2) {
    const days = output.byDay.slice().sort((a, b) => a.date.localeCompare(b.date));
    const lastDay = days[days.length - 1];
    const priorDays = days.slice(0, -1);

    if (priorDays.length > 0) {
      const avgCost = priorDays.reduce((sum, d) => sum + d.costUSD, 0) / priorDays.length;
      if (avgCost > 0 && lastDay.costUSD > avgCost * 2) {
        const multiplier = Math.round(lastDay.costUSD / avgCost * 10) / 10;
        anomalies.push({
          type: 'cost_spike',
          severity: 'high',
          detail: `${lastDay.date} cost ($${lastDay.costUSD.toFixed(2)}) is ${multiplier}x your ${priorDays.length}-day average ($${avgCost.toFixed(2)})`,
        });
      }
    }
  }

  return anomalies;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
