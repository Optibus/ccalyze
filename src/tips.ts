import type { CcalyzeOutput } from './types.ts';

export function generateTips(output: CcalyzeOutput): string[] {
  const tips: string[] = [];
  const anomalies = output.anomalies;

  const noCompactCount = anomalies.filter(a => a.type === 'session_no_compaction').length;
  if (noCompactCount > 0) {
    tips.push(
      `${noCompactCount} session${noCompactCount > 1 ? 's' : ''} ran without /compact. Use /compact every 15-20 prompts to keep context small and reduce token burn.`
    );
  }

  if (anomalies.some(a => a.type === 'concurrent_opus')) {
    tips.push(
      'Multiple Opus sessions ran concurrently. Consider using Haiku or Sonnet for exploration, code review, and planning tasks — they are 15-30x cheaper.'
    );
  }

  const longCount = anomalies.filter(a => a.type === 'long_running_session').length;
  if (longCount > 0) {
    tips.push(
      `${longCount} session${longCount > 1 ? 's' : ''} ran for 3+ hours. Start a fresh session periodically — each message in a long session resends the full context, making later messages exponentially more expensive.`
    );
  }

  const largeCount = anomalies.filter(a => a.type === 'large_transcript').length;
  if (largeCount > 0) {
    tips.push(
      `${largeCount} session${largeCount > 1 ? 's' : ''} grew to 50MB+. Use /compact or /clear to prevent context bloat.`
    );
  }

  const churnCount = anomalies.filter(a => a.type === 'high_model_churn').length;
  if (churnCount > 0) {
    tips.push(
      `${churnCount} expensive session${churnCount > 1 ? 's' : ''} switched models on the main thread repeatedly. The prompt cache is keyed to the model, so each switch throws away the cached conversation and pays to rebuild it — pick a model at the start of a session and stay on it.`
    );
  }

  const lowCacheCount = anomalies.filter(a => a.type === 'low_cache_efficiency').length;
  if (lowCacheCount > 0) {
    tips.push(
      `${lowCacheCount} expensive session${lowCacheCount > 1 ? 's' : ''} served an unusually low share of input from cache. Cache reads cost a tenth of fresh input and burn quota at that same discount, so this ratio — not how much you work — is what decides when you hit your limit.`
    );
  }

  const coldStartCount = anomalies.filter(a => a.type === 'cache_cold_start').length;
  if (coldStartCount > 0) {
    tips.push(
      `${coldStartCount} session${coldStartCount > 1 ? 's' : ''} repeatedly rebuilt context after long idle gaps. The cache expires after about an hour, so the first message back into a big session re-sends the whole conversation at full rate — it looks like a small question and is often the priciest turn of the day. Finish a thread while it is warm, or start fresh rather than reviving a large stale session.`
    );
  }

  // Range-wide ratio. Catches the case the per-session rule misses: usage that
  // is mediocre everywhere rather than bad in one expensive place. Tips stay
  // actionable-only, so a healthy ratio says nothing — the number itself is on
  // `summary.cacheReadRatio` for the renderer to show.
  if (output.summary.cacheReadRatio > 0 && output.summary.cacheReadRatio < 0.9) {
    tips.push(
      `Only ${(output.summary.cacheReadRatio * 100).toFixed(1)}% of your input tokens were served from cache across this whole range. Healthy usage runs 90-99%; closing that gap is worth more than any other single change, because cache reads bill — and burn quota — at a tenth of the fresh-input rate.`
    );
  }

  if (anomalies.some(a => a.type === 'cost_spike')) {
    tips.push(
      'Unusual spending detected. Check the session breakdown above to identify the most expensive sessions and their flags.'
    );
  }

  return tips;
}
