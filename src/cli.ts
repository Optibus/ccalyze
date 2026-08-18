#!/usr/bin/env node

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { statSync, existsSync, writeFileSync } from 'node:fs';
import { parseSessionFile, parseHistoryFile } from './parser.ts';
import { discoverSessionFiles, mergeSessions } from './discovery.ts';
import { aggregate, type EnrichedSession } from './aggregator.ts';
import { detectAnomalies } from './anomalies.ts';
import { generateTips } from './tips.ts';
import {
  buildHabitsReport,
  HabitsRefusal,
  parseWeekendDays,
  resolveHabitWindows,
} from './habits.ts';
import { renderHabitsHtml } from './report.ts';
import type { CcalyzeOutput, DateRange } from './types.ts';
import { VERSION } from './version.ts';

/** Default window length for --habits, in days. */
export const HABITS_DEFAULT_LENGTH = 7;

/** Where `--habits --html` writes when no path is given. */
export const HABITS_HTML_DEFAULT_PATH = 'ccalyze-habits.html';

export interface ParsedArgs {
  rangeArg: string;
  customFrom?: string;
  customTo?: string;
  /**
   * Accepted and intentionally not read: every mode already prints JSON, so the
   * flag's promise is kept whether or not anything branches on it. It stays
   * because it is the documented invocation throughout SKILL.md and the README.
   * (`--viz` was the other kind of unread flag — it promised a visualisation that
   * never existed — and is refused now rather than silently accepted.)
   */
  json: boolean;
  deep: boolean;
  version: boolean;
  /** Print usage and exit 0. */
  help: boolean;
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
  /** Days counting as the weekend for the off-hours row, `0` = Sunday. */
  weekendDays?: number[];
  /**
   * Also write the habits report as a self-contained HTML page.
   *
   * `--habits` only: a single-window run has no comparison to render, and the
   * page is a habit report end to end. Set to the resolved output path.
   */
  htmlPath?: string;
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

/**
 * Read the optional path after `--html`.
 *
 * The value is optional, which is exactly the shape that swallows a positional:
 * `--habits --html 7d` would otherwise write the report to a file called `7d`
 * and silently analyse the default 7-day pair instead of a 7-day one — the same
 * class of mistake the dash guard exists to refuse, and invisible in the output.
 * So a value is only accepted when it looks like a path: `.html`, or a `/` in it.
 * Anything else is refused by name rather than guessed at.
 */
export function readHtmlPath(argv: string[], index: number): { value: string; used: number } {
  const arg = argv[index];
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    const value = arg.slice(eq + 1);
    if (!value) throw new Error('--html= needs a path, or pass --html on its own');
    return { value, used: 0 };
  }

  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    return { value: HABITS_HTML_DEFAULT_PATH, used: 0 };
  }
  if (!next.endsWith('.html') && !next.includes('/')) {
    throw new Error(
      `--html does not understand "${next}" as a path (it needs a / or a .html suffix).\n` +
        'Pass the window length before the flag: ccalyze --habits 7d --html report.html',
    );
  }
  return { value: next, used: 1 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = {
    json: false,
    deep: false,
    version: false,
    help: false,
    habits: false,
    singleWindow: false,
    redactProjects: false,
  };
  const aliases: Record<string, string> = {};
  const positional: string[] = [];
  let unit: string | undefined;
  let topProjects: number | undefined;
  let weekendDays: number[] | undefined;
  let htmlPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.split('=')[0];
    if (name === '--json') flags.json = true;
    else if (name === '--deep') flags.deep = true;
    else if (name === '--version' || name === '-v') flags.version = true;
    else if (name === '--help' || name === '-h') flags.help = true;
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
    } else if (name === '--weekend') {
      const read = readValue(argv, i, '--weekend');
      i += read.used;
      weekendDays = parseWeekendDays(read.value);
    } else if (name === '--html') {
      const read = readHtmlPath(argv, i);
      i += read.used;
      htmlPath = read.value;
    } else if (name === '--alias') {
      const read = readValue(argv, i, '--alias');
      i += read.used;
      const eq = read.value.indexOf('=');
      if (eq < 1) throw new Error(`--alias needs OLD=NEW, got ${read.value}`);
      aliases[read.value.slice(0, eq)] = read.value.slice(eq + 1);
    } else if (arg.startsWith('-')) {
      // Refused, never ignored. A dropped flag is silent in both directions: the
      // person believes `--redact-project` (singular typo) redacted their project
      // labels and shares directory names, and the flag's *value* survives as a
      // positional, so `--topp 2` reads as a 2-day window instead of the default 7.
      //
      // Single-dash too, not just `--`: no positional this CLI accepts begins with
      // a dash (ranges are `7d`/`today`, custom ranges are two ISO dates), so a
      // dashed argument reaching the positional list is always a mistake. It did
      // not fail loudly there — `resolveDateRange` falls back to the default 7-day
      // window for anything it does not recognise, so `ccalyze -x` returned a
      // perfectly plausible report for a window the person never asked for.
      //
      // That fallback is the wider bug and it is still there: `7dd`, `tody` and
      // `banana` all still resolve to a silent default 7d. This guard only closes
      // the dash-shaped subset of it.
      throw new Error(`unknown option ${name}`);
    } else positional.push(arg);
  }

  const habitsLength = resolveHabitsLength(positional, flags.habits);

  // Refused rather than ignored: a normal run has no second window, no scorecard
  // and no levers, so there is no page to render — and a flag that appears to
  // have worked while writing nothing is worse than one that says no.
  if (htmlPath !== undefined && !flags.habits) {
    throw new Error('--html renders the --habits report; add --habits (a normal run prints JSON only)');
  }

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
      weekendDays,
      htmlPath,
    };
  }

  const rangeArg = positional[0] ?? '7d';
  return { rangeArg, ...flags, habitsLength, unit, topProjects, aliases, weekendDays, htmlPath };
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

  if (rangeArg === 'custom') {
    if (!customFrom || !customTo) {
      throw new Error('a custom range needs both a start and an end date');
    }
    return { from: customFrom, to: customTo };
  }

  const match = rangeArg.match(/^(\d+)d$/);
  if (match) {
    const days = parseInt(match[1], 10);
    if (days < 1) throw new Error(`range must cover at least one day, got "${rangeArg}"`);
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { from: from.toISOString().slice(0, 10), to: todayStr };
  }

  // Refused, never defaulted. This used to fall through to a 7-day window, so
  // `ccalyze tody` exited 0 with a report indistinguishable from a deliberate
  // `ccalyze 7d` — the mistake is invisible in the output, which is the one place
  // someone might have caught it. Same principle the flag parser already applies.
  throw new Error(
    `unknown range "${rangeArg}". Use today, Nd (e.g. 7d, 30d), ` +
      'or two YYYY-MM-DD dates.',
  );
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
    weekendDays: args.weekendDays,
  });

  for (const warning of warnings) console.error(warning);

  // stdout stays JSON whether or not a page was asked for: it is the documented
  // contract every caller already pipes, and the page is an addition to it, not a
  // replacement. The path goes to stderr so `--html … > findings.json` still works.
  if (args.htmlPath) {
    const path = resolve(process.cwd(), args.htmlPath);
    writeFileSync(path, renderHabitsHtml(report), 'utf8');
    console.error(`wrote ${path}`);
  }

  console.log(JSON.stringify(report, null, 2));
}

/**
 * Usage text.
 *
 * Added with the widened dash guard: `-h` is the most common way someone asks a
 * CLI what it does, and refusing it with a bare `unknown option -h` and nothing
 * else makes the stricter parsing feel broken rather than careful.
 */
const USAGE = `ccalyze ${VERSION} — Claude Code usage analyzer

Usage:
  ccalyze [RANGE] [options]
  ccalyze --habits [LENGTH] [options]

Range (default 7d):
  today                     today only
  Nd                        last N days, e.g. 7d, 30d
  YYYY-MM-DD YYYY-MM-DD     explicit start and end

Options:
  --deep                    include the per-prompt index
  --json                    emit JSON (the default, and the only, output)
  --version, -v             print version
  --help, -h                this text

Habits — compares the last N complete days against the N before them:
  --habits [Nd]             window LENGTH, not a date range (default 7d)
  --html [PATH]             also write the report as one self-contained HTML
                            page (default ${HABITS_HTML_DEFAULT_PATH}); stdout stays JSON
  --single-window           describe one window; no comparison
  --unit NAME               what to call the cost figure (default "units")
  --top N                   projects in the table (default 8)
  --alias OLD=NEW           rename a project label (repeatable)
  --redact-projects         replace every label with project-1, project-2, …
  --weekend DAYS            weekend for the off-hours row, e.g. fri,sat
                            (default sat,sun; "none" for a weekend-free week)

Cost is priced at published per-token API list rates, which is not what a
subscription charges. Treat it as a quota proxy, never as spend.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }

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
