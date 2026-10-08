import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCost,
  isPricingKnown,
  MODEL_PRICING,
  PRICES_VERIFIED,
  pricingSource,
  useLocalPricing,
} from './cost.ts';
import { checkPrices, diffPricing, loadLocalPricing, updatePrices } from './local-pricing.ts';
import type { ModelPricing } from './types.ts';

const FIXTURE = readFileSync(new URL('./fixtures/pricing-page.md', import.meta.url), 'utf8');
const URL_ = 'https://platform.claude.com/docs/en/about-claude/pricing.md';

const tmp: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ccalyze-local-pricing-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  useLocalPricing(undefined);
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

const rate = (n: number): ModelPricing => ({ input: n, output: n * 5, cacheRead: n * 0.1, cacheWrite: n * 1.25 });
const later = (): string => {
  const d = new Date(`${PRICES_VERIFIED}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
}

describe('diffPricing', () => {
  it('reports changed fields and added models', () => {
    const current = { a: rate(1), b: rate(2) };
    const next = { a: { ...rate(1), output: 9 }, b: rate(2), c: rate(3) };
    const d = diffPricing(current, next);
    assert.deepEqual(d.changed, [{ id: 'a', fields: [{ field: 'output', from: 5, to: 9 }] }]);
    assert.deepEqual(d.added, ['c']);
  });

  it('is empty for identical tables, ignoring float noise', () => {
    const d = diffPricing({ a: rate(3) }, { a: { ...rate(3), cacheRead: 0.30000000000000004 } });
    assert.deepEqual(d, { changed: [], added: [] });
  });
});

describe('loadLocalPricing', () => {
  const write = (body: string): string => {
    const p = join(tempDir(), 'prices.json');
    writeFileSync(p, body);
    return p;
  };
  const good = (over: object = {}) =>
    JSON.stringify({ verifiedOn: '2026-11-01', source: URL_, models: { 'claude-x': rate(1) }, ...over });

  it('returns undefined when the file is missing', () => {
    assert.equal(loadLocalPricing(join(tempDir(), 'nope.json')), undefined);
  });

  it('loads a valid file', () => {
    const l = loadLocalPricing(write(good()));
    assert.equal(l?.verifiedOn, '2026-11-01');
    assert.deepEqual(l?.models['claude-x'], rate(1));
  });

  it('throws naming the problem for each malformed shape', () => {
    assert.throws(() => loadLocalPricing(write('{nope')), /JSON/);
    assert.throws(() => loadLocalPricing(write(good({ verifiedOn: '11/01/2026' }))), /verifiedOn/);
    assert.throws(() => loadLocalPricing(write(good({ models: [] }))), /models/);
    assert.throws(() => loadLocalPricing(write(good({ models: { x: { ...rate(1), output: 0 } } }))), /claude-x|x.*output/);
    assert.throws(() => loadLocalPricing(write(good({ models: { x: { input: 1 } } }))), /output/);
    assert.throws(() => loadLocalPricing(write(good({ models: { x: { ...rate(1), input: 'NaN' } } }))), /input/);
  });
});

describe('effective pricing selection', () => {
  it('ignores a local file that is not newer than the built-in table', () => {
    useLocalPricing({ verifiedOn: PRICES_VERIFIED, models: { 'claude-opus-5': rate(99) } });
    assert.deepEqual(pricingSource(), { source: 'built-in', verifiedOn: PRICES_VERIFIED });
    assert.equal(computeCost('claude-opus-5', usage), MODEL_PRICING['claude-opus-5'].input);
  });

  it('uses a newer local file, overlaying built-in models', () => {
    useLocalPricing({ verifiedOn: later(), models: { 'claude-opus-5': rate(99), 'claude-new-9': rate(7) } });
    assert.deepEqual(pricingSource(), { source: 'local', verifiedOn: later() });
    assert.equal(computeCost('claude-opus-5', usage), 99);
    assert.equal(computeCost('claude-new-9-20271231', usage), 7); // same date stripping as built-in
    assert.equal(computeCost('claude-haiku-4-5', usage), MODEL_PRICING['claude-haiku-4-5'].input);
    assert.equal(isPricingKnown('claude-new-9'), true);
  });

  it('leaves a model absent from both layers unknown', () => {
    useLocalPricing({ verifiedOn: later(), models: { 'claude-new-9': rate(7) } });
    assert.equal(isPricingKnown('claude-nonexistent-1'), false);
  });

  it('reverts to built-in when reset', () => {
    useLocalPricing({ verifiedOn: later(), models: { 'claude-new-9': rate(7) } });
    useLocalPricing(undefined);
    assert.equal(pricingSource().source, 'built-in');
    assert.equal(isPricingKnown('claude-new-9'), false);
  });
});

describe('updatePrices', () => {
  it('writes a valid prices.json from the page and lists tiered and retired models', async () => {
    const path = join(tempDir(), 'ccalyze', 'prices.json');
    const io = capture();
    const code = await updatePrices({ fetchPage: async () => FIXTURE, path, today: '2026-11-02', ...io });
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.verifiedOn, '2026-11-02');
    assert.equal(written.source, URL_);
    assert.deepEqual(Object.keys(written.models).includes('claude-haiku-5-5'), false);
    assert.deepEqual(written.models['claude-sonnet-5-5'], MODEL_PRICING['claude-sonnet-5-5']);
    assert.ok(loadLocalPricing(path), 'the file it wrote must load');
    const text = io.lines.join('\n');
    assert.match(text, /claude-haiku-5-5.*prompt size/);
    assert.match(text, /claude-opus-4-1.*retired/i);
    assert.deepEqual(readdirSync(join(path, '..')), ['prices.json'], 'no temp file left behind');
  });

  it('exits 1 and writes nothing when the fetch fails', async () => {
    const path = join(tempDir(), 'ccalyze', 'prices.json');
    const io = capture();
    const code = await updatePrices({
      fetchPage: async () => { throw new Error('offline'); }, path, today: '2026-11-02', ...io,
    });
    assert.equal(code, 1);
    assert.match(io.errs.join('\n'), /offline/);
    assert.equal(existsSync(path), false);
  });

  it('exits 1 and leaves an existing file byte-identical when the page does not parse', async () => {
    const dir = tempDir();
    const path = join(dir, 'prices.json');
    const before = JSON.stringify({ verifiedOn: '2026-11-01', source: URL_, models: { 'claude-x': rate(1) } }, null, 2) + '\n';
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, before);
    const truncated = FIXTURE.split('\n').slice(0, 20).join('\n');
    const io = capture();
    const code = await updatePrices({ fetchPage: async () => truncated, path, today: '2026-11-02', ...io });
    assert.equal(code, 1);
    assert.match(io.errs.join('\n'), /Pricing page/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('diffs against the existing local file, not just the built-in table', async () => {
    const dir = tempDir();
    const path = join(dir, 'prices.json');
    writeFileSync(path, JSON.stringify({ verifiedOn: later(), source: URL_, models: { 'claude-opus-5': rate(99) } }));
    const io = capture();
    await updatePrices({ fetchPage: async () => FIXTURE, path, today: '2026-11-02', ...io });
    assert.match(io.lines.join('\n'), /claude-opus-5\b.*input.*99/);
  });
});

describe('checkPrices', () => {
  it('passes (0) on today\'s page: the built-in table matches it', async () => {
    const io = capture();
    assert.equal(await checkPrices({ fetchPage: async () => FIXTURE, ...io }), 0);
  });

  it('fails (1) when one price on the page differs', async () => {
    const altered = FIXTURE.replace(/(Claude Haiku 4\.5\s*\| )\$1 \/ MTok/, (_m, lead: string) => `${lead}$1.50 / MTok`);
    assert.notEqual(altered, FIXTURE);
    const io = capture();
    assert.equal(await checkPrices({ fetchPage: async () => altered, ...io }), 1);
    assert.match(io.lines.join('\n'), /claude-haiku-4-5/);
  });

  it('fails (1) when a priced model on the page is missing from the table', async () => {
    const extra = FIXTURE.replace(/(\| Claude Haiku 4\.5 )/, (m) => `| Claude Opus 9.9 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |\n${m}`);
    const io = capture();
    assert.equal(await checkPrices({ fetchPage: async () => extra, ...io }), 1);
    assert.match(io.lines.join('\n'), /claude-opus-9-9/);
  });

  it('exits 1 when the fetch fails', async () => {
    const io = capture();
    assert.equal(await checkPrices({ fetchPage: async () => { throw new Error('x'); }, ...io }), 1);
  });
});
