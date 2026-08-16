import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, isPricingKnown, MODEL_PRICING } from './cost.ts';

/** One million of every token kind — makes the arithmetic readable. */
const ONE_M = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
};

const INPUT_ONLY = {
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe('cost', () => {
  it('prices the Opus family at $5/$25', () => {
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6']) {
      const p = MODEL_PRICING[model];
      assert.ok(p, `${model} must be in the pricing table`);
      assert.equal(p.input, 5, `${model} input`);
      assert.equal(p.output, 25, `${model} output`);
    }
  });

  it('prices Fable 5 at $10/$50', () => {
    assert.equal(MODEL_PRICING['claude-fable-5'].input, 10);
    assert.equal(MODEL_PRICING['claude-fable-5'].output, 50);
  });

  it('prices Sonnet at $3/$15', () => {
    for (const model of ['claude-sonnet-5', 'claude-sonnet-4-6']) {
      assert.equal(MODEL_PRICING[model].input, 3, `${model} input`);
      assert.equal(MODEL_PRICING[model].output, 15, `${model} output`);
    }
  });

  it('prices Haiku 4.5 at $1/$5', () => {
    assert.equal(MODEL_PRICING['claude-haiku-4-5'].input, 1);
    assert.equal(MODEL_PRICING['claude-haiku-4-5'].output, 5);
  });

  it('derives cache rates from input: read 0.1x, write 1.25x', () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      assert.equal(p.cacheRead, p.input * 0.1, `${model} cache read`);
      assert.equal(p.cacheWrite, p.input * 1.25, `${model} cache write`);
    }
  });

  it('computes a full Opus 5 cost', () => {
    // $5 input + $25 output + $6.25 cache write + $0.50 cache read = $36.75
    assert.equal(computeCost('claude-opus-5', ONE_M), 36.75);
  });

  it('computes a full Sonnet 5 cost', () => {
    // $3 input + $15 output + $3.75 cache write + $0.30 cache read = $22.05
    assert.equal(computeCost('claude-sonnet-5', ONE_M), 22.05);
  });

  it('does not price Sonnet as Opus — the bug this table had', () => {
    const sonnet = computeCost('claude-sonnet-5', INPUT_ONLY);
    const opus = computeCost('claude-opus-5', INPUT_ONLY);
    assert.equal(sonnet, 3);
    assert.ok(sonnet < opus, 'Sonnet must be cheaper than Opus');
  });

  it('resolves a dated model id by prefix', () => {
    assert.equal(computeCost('claude-haiku-4-5-20251001', INPUT_ONLY), 1);
    assert.equal(computeCost('claude-sonnet-4-5-20250929', INPUT_ONLY), 3);
  });

  it('handles zero tokens', () => {
    assert.equal(
      computeCost('claude-opus-5', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      0,
    );
  });

  describe('unknown models', () => {
    it('reports known models as known', () => {
      assert.equal(isPricingKnown('claude-opus-5'), true);
      assert.equal(isPricingKnown('claude-haiku-4-5-20251001'), true, 'dated variant');
    });

    it('reports an unpriced model as unknown', () => {
      // The failure this guards: a model ships, silently prices as Opus, and
      // every number is wrong until someone notices.
      assert.equal(isPricingKnown('claude-opus-9'), false);
      assert.equal(isPricingKnown('some-other-vendor-model'), false);
    });

    it('still returns a usable cost for an unknown model', () => {
      // Falling back is fine; falling back *silently* is not — the fallback is
      // surfaced as an anomaly so the estimate is never mistaken for exact.
      assert.ok(computeCost('claude-opus-9', INPUT_ONLY) > 0);
    });
  });
});
