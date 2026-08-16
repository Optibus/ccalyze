/**
 * Published list price, USD per million tokens.
 *
 * These are raw per-token API rates — NOT what a Claude subscription charges.
 * Treat the resulting figures as relative weight / quota burn.
 *
 * Cache rates follow the published multipliers rather than being typed by hand:
 * a cache read is 0.1x the input rate, a 5-minute cache write is 1.25x. A test
 * pins that relationship, so a new model can't be added with invented cache
 * numbers.
 *
 * Keep this table current. Any model that isn't listed falls back to Opus
 * rates, which silently overstated Sonnet by 5x until 2026-07-27 — the
 * `unknown_model_pricing` anomaly now surfaces that fallback instead of hiding it.
 */
function rates(input, output) {
    return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
}
export const MODEL_PRICING = {
    // Fable / Mythos tier
    'claude-fable-5': rates(10, 50),
    'claude-mythos-5': rates(10, 50),
    // Opus tier
    'claude-opus-5': rates(5, 25),
    'claude-opus-4-8': rates(5, 25),
    'claude-opus-4-7': rates(5, 25),
    'claude-opus-4-6': rates(5, 25),
    'claude-opus-4-5': rates(5, 25),
    // Sonnet tier.
    // Sonnet 5 carries introductory pricing of $2/$10 through 2026-08-31; this
    // table uses the standard rate, so Sonnet 5 usage inside that window reads
    // high. Deliberate — date-windowed pricing isn't worth the complexity for a
    // relative-weight signal.
    'claude-sonnet-5': rates(3, 15),
    'claude-sonnet-4-6': rates(3, 15),
    'claude-sonnet-4-5': rates(3, 15),
    // Haiku tier
    'claude-haiku-4-5': rates(1, 5),
};
const DEFAULT_PRICING = MODEL_PRICING['claude-opus-5'];
/** The table entry for a model id, or undefined when nothing matches. */
function lookupPricing(modelId) {
    // Direct match
    if (MODEL_PRICING[modelId])
        return MODEL_PRICING[modelId];
    // Try stripping date suffix: "claude-opus-4-5-20251101" -> "claude-opus-4-5"
    const withoutDate = modelId.replace(/-\d{8}$/, '');
    if (MODEL_PRICING[withoutDate])
        return MODEL_PRICING[withoutDate];
    // Try matching family: "claude-haiku-4-5-20251001" -> look for "claude-haiku-4-5"
    for (const key of Object.keys(MODEL_PRICING)) {
        if (modelId.startsWith(key))
            return MODEL_PRICING[key];
    }
    return undefined;
}
/**
 * True when this model has published pricing (directly, or via a dated/family
 * prefix). False means `computeCost` is estimating at Opus rates — surfaced as
 * the `unknown_model_pricing` anomaly so the estimate is never mistaken for exact.
 */
export function isPricingKnown(modelId) {
    return lookupPricing(modelId) !== undefined;
}
export function resolveModelPricing(modelId) {
    return lookupPricing(modelId) ?? DEFAULT_PRICING;
}
export function computeCost(modelId, usage) {
    const pricing = resolveModelPricing(modelId);
    const cost = (usage.input_tokens * pricing.input +
        usage.output_tokens * pricing.output +
        usage.cache_read_input_tokens * pricing.cacheRead +
        usage.cache_creation_input_tokens * pricing.cacheWrite) / 1_000_000;
    return Math.round(cost * 1_000_000) / 1_000_000; // avoid floating point drift
}
//# sourceMappingURL=cost.js.map