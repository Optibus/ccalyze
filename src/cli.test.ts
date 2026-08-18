import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HABITS_DEFAULT_LENGTH, parseArgs, resolveDateRange } from './cli.ts';

describe('parseArgs', () => {
  it('defaults to 7d', () => {
    const args = parseArgs([]);
    assert.equal(args.rangeArg, '7d');
    assert.equal(args.json, false);
    assert.equal(args.deep, false);
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
    const args = parseArgs(['today', '--json', '--deep']);
    assert.equal(args.rangeArg, 'today');
    assert.equal(args.json, true);
    assert.equal(args.deep, true);
  });

  // --viz was accepted since v0.4.0 and never read by anything: it promised a
  // visualisation that has never existed, and reported success for it. --json is
  // the opposite kind of no-op and stays — the output really is always JSON.
  it('refuses --viz, which never did anything', () => {
    assert.throws(() => parseArgs(['today', '--viz']), /unknown option --viz/);
  });

  it('still accepts --json, whose promise the output actually keeps', () => {
    assert.equal(parseArgs(['today', '--json']).json, true);
  });

  // The --  case was already refused; the single-dash half fell through to the
  // positional list and was then read as the range, so `ccalyze -x` silently
  // analysed a range named "-x" instead of saying it did not understand it.
  it('refuses an unknown single-dash option instead of reading it as a range', () => {
    assert.throws(() => parseArgs(['-x']), /unknown option -x/);
    assert.throws(() => parseArgs(['-']), /unknown option -/);
  });

  it('still accepts the -v alias', () => {
    assert.equal(parseArgs(['-v']).version, true);
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

describe('parseArgs — habits', () => {
  it('defaults to a 7-day window length', () => {
    const args = parseArgs(['--habits']);
    assert.equal(args.habits, true);
    assert.equal(args.habitsLength, HABITS_DEFAULT_LENGTH);
    assert.equal(args.singleWindow, false);
  });

  it('reads the length off the positional, with or without the d', () => {
    assert.equal(parseArgs(['30d', '--habits']).habitsLength, 30);
    assert.equal(parseArgs(['--habits', '15']).habitsLength, 15);
  });

  it('refuses a date range — the length is settable, the dates are not', () => {
    assert.throws(
      () => parseArgs(['2026-03-01', '2026-03-15', '--habits']),
      /takes a window LENGTH, not a date range/,
    );
  });

  it('refuses a range word it cannot read as a length', () => {
    assert.throws(() => parseArgs(['today', '--habits']), /Pass a length/);
  });

  it('refuses a window no comparison could use', () => {
    assert.throws(() => parseArgs(['1d', '--habits']), /2 days or more/);
  });

  it('leaves the length alone when --habits is absent', () => {
    const args = parseArgs(['today']);
    assert.equal(args.habits, false);
    assert.equal(args.habitsLength, HABITS_DEFAULT_LENGTH);
  });

  it('parses --single-window', () => {
    assert.equal(parseArgs(['--habits', '--single-window']).singleWindow, true);
  });
});

describe('parseArgs — habits report options', () => {
  it('reads a value as either --flag value or --flag=value', () => {
    assert.equal(parseArgs(['--habits', '--unit', 'quota units']).unit, 'quota units');
    assert.equal(parseArgs(['--habits', '--unit=quota']).unit, 'quota');
    assert.equal(parseArgs(['--habits', '--top', '3']).topProjects, 3);
    assert.equal(parseArgs(['--habits', '--top=3']).topProjects, 3);
  });

  it('collects repeated aliases', () => {
    const args = parseArgs(['--habits', '--alias', 'a=one', '--alias=b=two']);
    assert.deepEqual(args.aliases, { a: 'one', b: 'two' });
  });

  it('parses --weekend into day indices, both spellings', () => {
    assert.deepEqual(parseArgs(['--habits', '--weekend', 'fri,sat']).weekendDays, [5, 6]);
    assert.deepEqual(parseArgs(['--habits', '--weekend=fri,sat']).weekendDays, [5, 6]);
    assert.deepEqual(parseArgs(['--habits', '--weekend', 'none']).weekendDays, []);
  });

  it('leaves weekendDays unset when --weekend is not passed, so the default applies', () => {
    assert.equal(parseArgs(['--habits']).weekendDays, undefined);
  });

  it('refuses a --weekend day it does not recognise', () => {
    assert.throws(() => parseArgs(['--habits', '--weekend', 'funday']), /funday/);
  });

  it('parses --redact-projects', () => {
    assert.equal(parseArgs(['--habits', '--redact-projects']).redactProjects, true);
  });

  it('rejects a malformed alias rather than silently dropping it', () => {
    assert.throws(() => parseArgs(['--habits', '--alias', 'nope']), /needs OLD=NEW/);
    assert.throws(() => parseArgs(['--habits', '--alias', '=new']), /needs OLD=NEW/);
  });

  it('rejects a --top that is not a positive whole number', () => {
    assert.throws(() => parseArgs(['--habits', '--top', '0']), /positive whole number/);
    assert.throws(() => parseArgs(['--habits', '--top', 'eight']), /positive whole number/);
  });

  it('rejects a value-taking flag left without a value', () => {
    assert.throws(() => parseArgs(['--habits', '--unit']), /--unit needs a value/);
  });

  it('refuses an unknown flag instead of dropping it', () => {
    // A dropped flag is silent in the direction that matters: the person believes
    // they redacted their project labels and ships directory names.
    assert.throws(
      () => parseArgs(['--habits', '--redact-project']),
      /unknown option --redact-project/,
    );
  });

  it('refuses a mistyped value-flag rather than reading its value as the length', () => {
    assert.throws(() => parseArgs(['--habits', '--topp', '2']), /unknown option --topp/);
  });

  it('does not read a flag value as the window length', () => {
    const args = parseArgs(['--habits', '--unit', '30d']);
    assert.equal(args.unit, '30d');
    assert.equal(args.habitsLength, HABITS_DEFAULT_LENGTH);
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
