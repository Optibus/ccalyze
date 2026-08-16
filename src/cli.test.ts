import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolveDateRange } from './cli.ts';

describe('parseArgs', () => {
  it('defaults to 7d', () => {
    const args = parseArgs([]);
    assert.equal(args.rangeArg, '7d');
    assert.equal(args.json, false);
    assert.equal(args.deep, false);
    assert.equal(args.viz, false);
  });

  it('parses "today"', () => {
    const args = parseArgs(['today']);
    assert.equal(args.rangeArg, 'today');
  });

  it('parses "30d"', () => {
    const args = parseArgs(['30d']);
    assert.equal(args.rangeArg, '30d');
  });

  it('parses custom date range', () => {
    const args = parseArgs(['2026-03-01', '2026-03-15']);
    assert.equal(args.rangeArg, 'custom');
    assert.equal(args.customFrom, '2026-03-01');
    assert.equal(args.customTo, '2026-03-15');
  });

  it('parses flags', () => {
    const args = parseArgs(['today', '--json', '--deep', '--viz']);
    assert.equal(args.rangeArg, 'today');
    assert.equal(args.json, true);
    assert.equal(args.deep, true);
    assert.equal(args.viz, true);
  });
});

describe('resolveDateRange', () => {
  it('resolves "today"', () => {
    const range = resolveDateRange('today', undefined, undefined);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(range.from, today);
    assert.equal(range.to, today);
  });

  it('resolves "7d"', () => {
    const range = resolveDateRange('7d', undefined, undefined);
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    assert.equal(range.from, from.toISOString().slice(0, 10));
    assert.equal(range.to, to.toISOString().slice(0, 10));
  });

  it('resolves custom range', () => {
    const range = resolveDateRange('custom', '2026-03-01', '2026-03-15');
    assert.equal(range.from, '2026-03-01');
    assert.equal(range.to, '2026-03-15');
  });
});

describe('parseArgs — version flag', () => {
  it('parses --version', () => {
    assert.equal(parseArgs(['--version']).version, true);
  });

  it('defaults version to false', () => {
    assert.equal(parseArgs(['7d']).version, false);
  });

  it('does not treat --version as a range', () => {
    assert.equal(parseArgs(['--version']).rangeArg, '7d');
  });
});
