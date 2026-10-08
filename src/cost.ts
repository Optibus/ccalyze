import type { ModelPricing, RawUsage } from './types.ts';

/**
 * Published list price, USD per million tokens.
 *
 * These are raw per-token API rates — NOT what a Claude subscription charges.
 * Treat the resulting figures as relative weight / quota burn.
 *
 * Cache rates follow the published multipliers rather than being typed by hand:
 * a cache read is 0.1x the input rate (except the published overrides in
 * CACHE_READ_MULTIPLIER), a 5-minute cache write is 1.25x. A test
 * pins that relationship, so a new model can't be added with invented cache
 * numbers.
 *
 * Keep this table current. Any model that isn't listed falls back to Opus
 * rates, which silently overstated Sonnet by 5x until 2026-07-27 — the
 * `unknown_model_pricing` anomaly now surfaces that fallback instead of hiding it.
 */
function rates(input: number, output: number, cacheReadMultiplier = 0.1): ModelPricing {
  return { input, output, cacheRead: input * cacheReadMultiplier, cacheWrite: input * 1.25 };
}

/**
 * Published cache-read multipliers that differ from the standard 0.1x
 * (platform.claude.com/docs/en/about-claude/pricing, footnotes 1-2).
 */
export const CACHE_READ_MULTIPLIER: Record<string, number> = {
  'claude-fable-5-1': 0.025,
  'claude-mythos-5-1': 0.025,
  'claude-opus-5-5': 0.05,
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Fable / Mythos tier
  'claude-fable-5-1': rates(10, 50, CACHE_READ_MULTIPLIER['claude-fable-5-1']),
  'claude-mythos-5-1': rates(10, 50, CACHE_READ_MULTIPLIER['claude-mythos-5-1']),
  'claude-fable-5': rates(10, 50),
  'claude-mythos-5': rates(10, 50),
  // Opus tier
  'claude-opus-5-5': rates(4, 20, CACHE_READ_MULTIPLIER['claude-opus-5-5']),
  'claude-opus-5': rates(5, 25),
  'claude-opus-4-8': rates(5, 25),
  'claude-opus-4-7': rates(5, 25),
  'claude-opus-4-6': rates(5, 25),
  'claude-opus-4-5': rates(5, 25),
  // Sonnet tier.
  'claude-sonnet-5-5': rates(2, 10),
  // Sonnet 5 launched at an introductory $2/$10; Anthropic later made that the
  // standard price and cancelled the planned rise to $3/$15.
  'claude-sonnet-5': rates(2, 10),
  'claude-sonnet-4-6': rates(3, 15),
  'claude-sonnet-4-5': rates(3, 15),
  // Haiku tier
  'claude-haiku-4-5': rates(1, 5),
};

const DEFAULT_PRICING = MODEL_PRICING['claude-opus-5'];

/** The table entry for a model id, or undefined when nothing matches. */
function lookupPricing(modelId: string): ModelPricing | undefined {
  // Direct match
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId];

  // Strip only a date suffix and/or the 1M-context marker:
  // "claude-haiku-4-5-20251001" -> "claude-haiku-4-5", "claude-opus-5[1m]" -> "claude-opus-5".
  // No bare prefix match: "claude-opus-5-5" startsWith "claude-opus-5", so a
  // prefix loop silently priced each new generation as the previous one and
  // kept the unknown_model_pricing anomaly from ever firing.
  const base = modelId.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  if (MODEL_PRICING[base]) return MODEL_PRICING[base];

  return undefined;
}

/**
 * True when this model has published pricing (directly, or after stripping a date
 * suffix or `[1m]` marker). False means `computeCost` is estimating at Opus rates — surfaced as
 * the `unknown_model_pricing` anomaly so the estimate is never mistaken for exact.
 */
export function isPricingKnown(modelId: string): boolean {
  return lookupPricing(modelId) !== undefined;
}

export function resolveModelPricing(modelId: string): ModelPricing {
  return lookupPricing(modelId) ?? DEFAULT_PRICING;
}

export function computeCost(modelId: string, usage: RawUsage): number {
  const pricing = resolveModelPricing(modelId);
  const cost = (usage.input_tokens * pricing.input +
    usage.output_tokens * pricing.output +
    usage.cache_read_input_tokens * pricing.cacheRead +
    usage.cache_creation_input_tokens * pricing.cacheWrite) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // avoid floating point drift
}
