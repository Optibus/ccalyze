#!/usr/bin/env node

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { statSync, existsSync } from 'node:fs';
import { parseSessionFile, parseHistoryFile } from './parser.ts';
import { discoverSessionFiles, mergeSessions } from './discovery.ts';
import { aggregate, type EnrichedSession } from './aggregator.ts';
import { detectAnomalies } from './anomalies.ts';
import { generateTips } from './tips.ts';
import { buildHabitsReport, HabitsRefusal, resolveHabitWindows } from './habits.ts';
import type { CcalyzeOutput, DateRange } from './types.ts';
import { VERSION } from './version.ts';

/** Default window length for --habits, in days. */
export const HABITS_DEFAULT_LENGTH = 7;

export interface ParsedArgs {
  rangeArg: string;
  customFrom?: string;
  customTo?: string;
  json: boolean;
  deep: boolean;
  viz: boolean;
  version: boolean;
  /** Compare the last N complete days against the N before them. */
  habits: boolean;
  /** Window LENGTH in days for --habits. The dates are never settable. */
  habitsLength: number;
  /** --habits without a prior window: describes habits, cannot track them. */
  singleWindow: boolean;
  /** What to call the cost figure in the habits report. */
  unit?: string;
  /** Projects in the habits project table. */
  topProjects?: number;
  /** `OLD=NEW` project-label renames for the habits report. */
  aliases: Record<string, string>;
  redactProjects: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read `--flag value` or `--flag=value`.
 *
 * @returns the value and how many argv entries it consumed
 */
function readValue(argv: string[], index: number, name: string): { value: string; used: number } {
  const arg = argv[index];
  const eq = arg.indexOf('=');
  if (eq !== -1) return { value: arg.slice(eq + 1), used: 0 };
  const next = argv[index + 1];
  if (next === undefined) throw new Error(`${name} needs a value`);
  return { value: next, used: 1 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = {
    json: false,
    deep: false,
    viz: false,
    version: false,
    habits: false,
    singleWindow: false,
    redactProjects: false,
  };
  const aliases: Record<string, string> = {};
  const positional: string[] = [];
  let unit: string | undefined;
  let topProjects: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split('=')[0];
    if (name === '--json') flags.json = true;
    else if (name === '--deep') flags.deep = true;
    else if (name === '--viz') flags.viz = true;
    else if (name === '--version' || name === '-v') flags.version = true;
    else if (name === '--habits') flags.habits = true;
    else if (name === '--single-window') flags.singleWindow = true;
    else if (name === '--redact-projects') flags.redactProjects = true;
    else if (name === '--unit') {
      const read = readValue(argv, i, '--unit');
      i += read.used;
      unit = read.value;
    } else if (name === '--top') {
      const read = readValue(argv, i, '--top');
      i += read.used;
      const parsed = Number(read.value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--top needs a positive whole number, got ${read.value}`);
      topProjects = parsed;
    } else if (name === '--alias') {
      const read = readValue(argv, i, '--alias');
      i += read.used;
      const eq = read.value.indexOf('=');
      if (eq < 1) throw new Error(`--alias needs OLD=NEW, got ${read.value}`);
      aliases[read.value.slice(0, eq)] = read.value.slice(eq + 1);
    } else if (arg.startsWith('--')) {
      // Refused, never ignored. A dropped flag is silent in both directions: the
      // person believes `--redact-project` (singular typo) redacted their project
      // labels and shares directory names, and the flag's *value* survives as a
      // positional, so `--topp 2` reads as a 2-day window instead of the default 7.
      throw new Error(`unknown option ${name}`);
    } else positional.push(arg);
  }

  const habitsLength = resolveHabitsLength(positional, flags.habits);

  if (positional.length === 2 && DATE_RE.test(positional[0]) && DATE_RE.test(positional[1])) {
    return {
      rangeArg: 'custom',
      customFrom: positional[0],
      customTo: positional[1],
      ...flags,
      habitsLength,
      unit,
      topProjects,
      aliases,
    };
  }

  const rangeArg = positional[0] ?? '7d';
  return { rangeArg, ...flags, habitsLength, unit, topProjects, aliases };
}

/**
 * The one knob --habits exposes: the window LENGTH.
 *
 * Endpoints are refused, not defaulted. Picking a date range after seeing the
 * numbers is the way a habit comparison turns into an argument, and it is exactly
 * what a length cannot do — both windows move together whatever N is.
 */
export function resolveHabitsLength(positional: string[], habits: boolean): number {
  if (!habits) return HABITS_DEFAULT_LENGTH;

  if (positional.length === 2 && DATE_RE.test(positional[0]) && DATE_RE.test(positional[1])) {
    throw new Error(
      '--habits takes a window LENGTH, not a date range.\n' +
        'It picks the dates itself: the last N complete days against the N before them. ' +
        'Pass 7d, 15d or 30d.',
    );
  }

  const arg = positional[0];
  if (arg === undefined) return HABITS_DEFAULT_LENGTH;

  const match = arg.match(/^(\d+)d?$/);
  if (!match) {
    throw new Error(
      `--habits does not understand the range "${arg}". Pass a length: 7d, 15d or 30d.`,
    );
  }
  const length = parseInt(match[1], 10);
  if (length < 2) {
    throw new Error(`--habits needs a window of 2 days or more, got ${arg}.`);
  }
  return length;
}

export function resolveDateRange(rangeArg: string, customFrom?: string, customTo?: string): DateRange {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  if (rangeArg === 'today') {
    return { from: todayStr, to: todayStr };
  }

  if (rangeArg === 'custom' && customFrom && customTo) {
    return { from: customFrom, to: customTo };
  }

  const match = rangeArg.match(/^(\d+)d$/);
  if (match) {
    const days = parseInt(match[1], 10);
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { from: from.toISOString().slice(0, 10), to: todayStr };
  }

  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  return { from: from.toISOString().slice(0, 10), to: todayStr };
}

/**
 * Parse, aggregate and analyze one date range — the whole single-window run.
 *
 * Extracted so --habits can produce two windows through exactly the same path the
 * normal run takes: a habit comparison is only as trustworthy as the two figures
 * being identical in derivation, so there must be no second aggregation code path.
 */
export async function analyzeRange(
  claudeDir: string,
  range: DateRange,
  deep: boolean,
): Promise<CcalyzeOutput> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  // A UTC step, because `new Date('2026-08-10')` parses as UTC midnight. Stepping
  // the *local* day across a DST transition makes the last day 23h or 25h long —
  // harmless in a single-window run, but it would make one --habits window
  // physically shorter than the other while both still span N dates, which is
  // exactly the error validateWindowPair exists to refuse and cannot see.
  const toEnd = new Date(to);
  toEnd.setUTCDate(toEnd.getUTCDate() + 1);

  // Parse history
  const historyPath = resolve(claudeDir, 'history.jsonl');
  const history = existsSync(historyPath)
    ? await parseHistoryFile(historyPath, from, toEnd)
    : [];

  // Discover and parse session files
  const sessionFiles = discoverSessionFiles(claudeDir, from, toEnd);
  const sessions: EnrichedSession[] = [];

  for (const { filePath, project } of sessionFiles) {
    const parsed = await parseSessionFile(filePath);
    if (parsed.messages.length === 0) continue;

    // Filter messages to only those within the date range
    const fromStr = from.toISOString();
    const toEndStr = toEnd.toISOString();
    const filteredMessages = parsed.messages.filter(m =>
      m.timestamp >= fromStr && m.timestamp < toEndStr
    );
    if (filteredMessages.length === 0) continue;

    // Recalculate start/end from filtered messages
    const timestamps = filteredMessages.map(m => m.timestamp).sort();
    const startTime = timestamps[0];
    const endTime = timestamps[timestamps.length - 1];

    let fstat;
    try { fstat = statSync(filePath); } catch { continue; }
    const transcriptSizeMB = Math.round(fstat.size / 1024 / 1024 * 10) / 10;

    sessions.push({
      ...parsed,
      messages: filteredMessages,
      startTime,
      endTime,
      project,
      transcriptSizeMB,
      filePaths: [filePath],
    });
  }

  // Merge each session's transcripts (main + subagent files) into one session.
  const mergedSessions = mergeSessions(sessions);

  // Aggregate
  const output = aggregate(mergedSessions, history, range, deep);

  // Detect anomalies
  output.anomalies = detectAnomalies(output);

  // Generate tips
  output.tips = generateTips(output);

  return output;
}

/**
 * Run the two-window habit comparison.
 *
 * Both windows are parsed independently rather than sliced out of one wider run:
 * message-level date filtering is what keeps a session that straddles midnight
 * from being counted in both, and it happens inside `analyzeRange`.
 */
async function runHabits(claudeDir: string, args: ParsedArgs): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const windows = resolveHabitWindows(args.habitsLength, today);

  const current = await analyzeRange(claudeDir, windows.current, args.deep);
  const prior = args.singleWindow ? null : await analyzeRange(claudeDir, windows.prior, args.deep);

  const { report, warnings } = buildHabitsReport(current, prior, {
    unit: args.unit,
    topProjects: args.topProjects,
    aliases: args.aliases,
    redactProjects: args.redactProjects,
  });

  for (const warning of warnings) console.error(warning);
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    return;
  }

  const claudeDir = resolve(homedir(), '.claude');

  if (args.habits) {
    await runHabits(claudeDir, args);
    return;
  }

  const range = resolveDateRange(args.rangeArg, args.customFrom, args.customTo);
  const output = await analyzeRange(claudeDir, range, args.deep);

  // Output
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  if (err instanceof HabitsRefusal) {
    console.error(`ccalyze --habits refused this pair of windows:\n${err.message}`);
    process.exit(1);
  }
  console.error('ccalyze error:', err.message);
  process.exit(1);
});
