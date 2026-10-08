import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODEL_PRICING } from './cost.ts';
import type { ModelPricing } from './types.ts';
import {
  MIN_PRICING_ROWS,
  REQUIRED_MODELS,
  modelIdFromDisplayName,
  parsePricingPage,
} from './pricing-page.ts';

const FIXTURE = readFileSync(new URL('./fixtures/pricing-page.md', import.meta.url), 'utf8');

const HEADER =
  '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |\n' +
  '| :--- | :--- | :--- | :--- | :--- | :--- |\n';

function row(name: string, input = '$1 / MTok', cacheRead = '$0.10 / MTok', output = '$5 / MTok'): string {
  return `| ${name} | ${input} | $1.25 / MTok | $2 / MTok | ${cacheRead} | ${output} |\n`;
}

/** A page with a valid table: the three REQUIRED_MODELS plus enough filler to clear MIN_PRICING_ROWS. */
function page(extraRows = '', header = HEADER): string {
  const filler = Array.from({ length: MIN_PRICING_ROWS }, (_, i) => row(`Claude Opus 3.${i}`)).join('');
  return (
    '# Pricing\n\n## Model pricing\n\n' +
    header +
    row('Claude Opus 5.5') +
    row('Claude Sonnet 5.5') +
    row('Claude Haiku 4.5') +
    filler +
    extraRows +
    '\n## Batch pricing\n\n'
  );
}

describe('modelIdFromDisplayName', () => {
  it('maps display names to ids', () => {
    assert.equal(modelIdFromDisplayName('Claude Opus 5.5'), 'claude-opus-5-5');
    assert.equal(modelIdFromDisplayName('Claude Fable 5.1'), 'claude-fable-5-1');
    assert.equal(modelIdFromDisplayName('Claude Haiku 4.5'), 'claude-haiku-4-5');
    assert.equal(modelIdFromDisplayName('Claude Sonnet 5'), 'claude-sonnet-5');
  });

  it('strips links and parenthetical notes', () => {
    assert.equal(
      modelIdFromDisplayName('Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842))'),
      'claude-mythos-5-1',
    );
    assert.equal(
      modelIdFromDisplayName('Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://x.test/a))'),
      'claude-opus-4-1',
    );
  });

  it('returns undefined for names that are not a Claude model', () => {
    assert.equal(modelIdFromDisplayName('Claude Haiku'), undefined);
    assert.equal(modelIdFromDisplayName('GPT-5'), undefined);
    assert.equal(modelIdFromDisplayName(''), undefined);
  });
});

/**
 * cost.ts derives cache rates by multiplication (3 * 0.1 = 0.30000000000000004)
 * while the page states decimals (0.3), so exact equality would fail on
 * representation noise alone. 1e-9 USD/MTok is far below any real price step.
 */
function assertPricingClose(actual: ModelPricing, expected: ModelPricing, id: string): void {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `${id}.${k}: page ${actual[k]} vs table ${expected[k]}`);
  }
}

describe('parsePricingPage on the saved page', () => {
  const { prices: parsed, tiered, retired } = parsePricingPage(FIXTURE);

  it('reads the headline models', () => {
    assert.deepEqual(parsed['claude-opus-5-5'], { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    assert.equal(parsed['claude-fable-5-1'].cacheRead, 0.25);
    assert.deepEqual([parsed['claude-sonnet-5'].input, parsed['claude-sonnet-5'].output], [2, 10]);
    assert.deepEqual([parsed['claude-haiku-4-5'].input, parsed['claude-haiku-4-5'].output], [1, 5]);
    assert.ok(Object.keys(parsed).length >= MIN_PRICING_ROWS);
  });

  it('agrees with the static MODEL_PRICING table on every model it lists', () => {
    // If this fails the page moved (update cost.ts) or the parser drifted. Exact
    // equality holds today; both sides derive from the same published decimals.
    for (const [id, expected] of Object.entries(MODEL_PRICING)) {
      assertPricingClose(parsed[id], expected, id);
    }
  });

  it('ignores later tables such as batch pricing', () => {
    assert.equal(parsed['claude-opus-5-5'].input, 4); // batch table says 2
  });

  it('reports tiered models and gives them no price in either tier', () => {
    assert.deepEqual(tiered, ['claude-haiku-5-5']);
    assert.ok(!('claude-haiku-5-5' in parsed));
  });

  it('reports retired models and excludes them from prices', () => {
    for (const id of ['claude-opus-4-1', 'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-3-5']) {
      assert.ok(retired.includes(id), id);
      assert.ok(!(id in parsed), id);
    }
    assert.equal(retired.length, 4);
  });

  it('prices every model it lists in the built-in table', () => {
    const missing = Object.keys(parsed).filter((id) => !(id in MODEL_PRICING));
    assert.deepEqual(missing, []);
  });
});

describe('parsePricingPage guards', () => {
  it('accepts the synthetic baseline', () => {
    assert.ok(parsePricingPage(page()).prices['claude-opus-5-5']);
  });

  it('throws when the Model pricing section is missing', () => {
    assert.throws(() => parsePricingPage('# Pricing\n\nnothing here\n'), /Model pricing/);
  });

  it('throws when a required column header is missing', () => {
    const header = HEADER.replace('Cache hits and refreshes', 'Cache stuff');
    assert.throws(() => parsePricingPage(page('', header)), /Cache hits and refreshes/);
  });

  it('throws when a price cell is not a positive number', () => {
    assert.throws(() => parsePricingPage(page(row('Claude Opus 4.9', '$abc / MTok'))), /Claude Opus 4\.9.*\$abc/);
    assert.throws(() => parsePricingPage(page(row('Claude Opus 4.9', '$0 / MTok'))), /Claude Opus 4\.9/);
  });

  it('throws when too few rows parse', () => {
    const md = '## Model pricing\n\n' + HEADER + row('Claude Opus 5.5') + row('Claude Sonnet 5.5') + row('Claude Haiku 4.5');
    assert.throws(() => parsePricingPage(md), /only 3 .*at least 10/);
  });

  it('throws when a required model is absent', () => {
    const filler = Array.from({ length: MIN_PRICING_ROWS }, (_, i) => row(`Claude Opus 3.${i}`)).join('');
    const md = '## Model pricing\n\n' + HEADER + row('Claude Opus 5.5') + row('Claude Haiku 4.5') + filler;
    assert.throws(() => parsePricingPage(md), /claude-sonnet-5-5/);
    assert.ok(REQUIRED_MODELS.includes('claude-sonnet-5-5'));
  });

  it('throws on a model name it does not recognise', () => {
    assert.throws(() => parsePricingPage(page(row('Claude Opus Max'))), /Claude Opus Max/);
  });

  it('reports a tier pair as tiered and prices neither tier', () => {
    const md = page(row('Claude Haiku 5.5 (for prompts up to 100,000 tokens)') + row('Claude Haiku 5.5 (for prompts over 100,000 tokens)', '$0.50 / MTok'));
    const r = parsePricingPage(md);
    assert.deepEqual(r.tiered, ['claude-haiku-5-5']);
    assert.ok(!('claude-haiku-5-5' in r.prices));
  });

  it('throws on a lone row with an unknown parenthetical', () => {
    assert.throws(() => parsePricingPage(page(row('Claude Opus 4.9 (beta)'))), /Claude Opus 4\.9/);
  });

  it('throws on a duplicate id that is not a tier pair', () => {
    assert.throws(() => parsePricingPage(page(row('Claude Opus 4.9') + row('Claude Opus 4.9'))), /twice/);
  });

  it('skips retired rows, recording the derived id', () => {
    const r = parsePricingPage(page(row('Claude Opus 4.1 ([retired, x](https://x.test))') + row('Claude Haiku 3.5 ([retired](https://x.test))')));
    assert.ok(r.retired.includes('claude-opus-4-1'));
    assert.ok(!('claude-opus-4-1' in r.prices));
  });
});
