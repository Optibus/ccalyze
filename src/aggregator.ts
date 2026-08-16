import type {
  CcalyzeOutput,
  DateRange,
  Summary,
  DaySummary,
  ModelSummary,
  ProjectSummary,
  SessionSummary,
  SessionFlag,
  TokenUsage,
  HistoryEntry,
  DeepData,
  DeepSession,
  ModelSwitch,
  TranscriptDirGroup,
} from './types.ts';
import type { ParsedMessage } from './types.ts';
import type { SessionParseResult } from './parser.ts';
import { computeCost, resolveModelPricing } from './cost.ts';

export interface EnrichedSession extends SessionParseResult {
  project: string;
  transcriptSizeMB: number;
  /** Transcript file(s) backing this session (main + merged subagent files). */
  filePaths?: string[];
}

/** Cap on prompt-display strings emitted per session in --deep mode. */
export const DEEP_MAX_PROMPT_DISPLAYS = 150;

/**
 * Cap on the length of a single prompt-display string. The count cap above
 * rarely fires in practice (real sessions sit well under 150 prompts), but an
 * individual pasted prompt can run thousands of characters — that is the axis
 * that actually bloats the payload. The head is what identifies the task, so
 * keep it and mark the cut.
 */
export const DEEP_MAX_PROMPT_DISPLAY_CHARS = 1500;

const TRUNCATION_MARKER = '…[truncated]';

/**
 * Idle gap after which the prompt cache is assumed to have expired.
 *
 * The subscription cache lives an hour. Come back to a large session after
 * longer than that and the next message — however short — re-sends the entire
 * conversation at the write rate.
 */
export const COLD_START_GAP_MINUTES = 60;

/**
 * Cache-write size that marks a rebuild rather than routine incremental caching.
 * Claude Code writes small amounts of cache constantly; a real context rebuild
 * moves tens of thousands of tokens at once.
 */
export const COLD_START_MIN_CACHE_WRITE_TOKENS = 20_000;

/** Cap on a derived session name. Long enough to identify, short enough to tabulate. */
export const SESSION_NAME_MAX_CHARS = 60;

/** Ratios are rounded so the JSON stays stable and diffable. */
function asRatio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/**
 * Turn the user's first prompt into a one-line session label.
 *
 * Claude Code stores no session title in the transcripts, so the opening prompt
 * is the closest honest stand-in for "what was this session about".
 */
export function deriveSessionName(display: string): string {
  const oneLine = display.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SESSION_NAME_MAX_CHARS) return oneLine;
  return oneLine.slice(0, SESSION_NAME_MAX_CHARS).trimEnd() + '…';
}

/**
 * Count the times a session rebuilt its cache from cold, and price the premium.
 *
 * A rebuild is a long idle gap followed by a large cache write. Only the
 * *premium* is charged to the habit: those tokens paid the cache-write rate
 * (1.25x input) where a live cache would have charged the cache-read rate
 * (0.1x input). The difference is the avoidable part — the tokens themselves
 * always had to be sent.
 */
export function computeColdStarts(messages: ParsedMessage[]): {
  count: number;
  extraUSD: number;
} {
  const ordered = [...messages].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let count = 0;
  let extraUSD = 0;

  for (let i = 1; i < ordered.length; i++) {
    const msg = ordered[i];
    const rebuiltTokens = msg.usage.cache_creation_input_tokens;
    if (rebuiltTokens < COLD_START_MIN_CACHE_WRITE_TOKENS) continue;

    const gapMinutes =
      (Date.parse(msg.timestamp) - Date.parse(ordered[i - 1].timestamp)) / 60_000;
    if (!(gapMinutes > COLD_START_GAP_MINUTES)) continue;

    const pricing = resolveModelPricing(msg.model);
    count++;
    extraUSD += (rebuiltTokens * (pricing.cacheWrite - pricing.cacheRead)) / 1_000_000;
  }

  return { count, extraUSD: Math.round(extraUSD * 1_000_000) / 1_000_000 };
}

/** First prompt the user typed in each session, chronologically. */
function firstDisplayBySession(history: HistoryEntry[]): Map<string, string> {
  const earliest = new Map<string, { ts: number; display: string }>();
  for (const entry of history) {
    if (!entry.sessionId || !entry.display) continue;
    const seen = earliest.get(entry.sessionId);
    if (!seen || entry.timestamp < seen.ts) {
      earliest.set(entry.sessionId, { ts: entry.timestamp, display: entry.display });
    }
  }
  return new Map([...earliest].map(([id, { display }]) => [id, deriveSessionName(display)]));
}

/** Cap one prompt-display, marking it when the tail is dropped. */
function capPromptDisplay(display: string): string {
  if (display.length <= DEEP_MAX_PROMPT_DISPLAY_CHARS) return display;
  return display.slice(0, DEEP_MAX_PROMPT_DISPLAY_CHARS) + TRUNCATION_MARKER;
}

/**
 * Group transcript paths by their directory, so a directory shared by many
 * transcripts is stated once instead of once per file.
 *
 * Splits on the last '/' only — a path is a directory plus a filename, so there
 * is no prefix-matching to get wrong. Directory order, and file order within a
 * directory, follow first appearance in `paths` (deterministic for tests).
 */
export function groupTranscriptsByDir(paths: string[]): TranscriptDirGroup[] {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const cut = path.lastIndexOf('/');
    const dir = cut === -1 ? '' : path.slice(0, cut);
    const file = cut === -1 ? path : path.slice(cut + 1);
    const files = byDir.get(dir) ?? [];
    files.push(file);
    byDir.set(dir, files);
  }
  return [...byDir].map(([dir, files]) => ({ dir, files }));
}

export function aggregate(
  sessions: EnrichedSession[],
  history: HistoryEntry[],
  range: DateRange,
  deep = false,
): CcalyzeOutput {
  // Build set of sessionIds that have a /compact entry in history
  const compactedSessions = new Set<string>();
  for (const entry of history) {
    if (entry.display.startsWith('/compact')) {
      compactedSessions.add(entry.sessionId);
    }
  }

  const sessionNames = firstDisplayBySession(history);

  const summary: Summary = {
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalSessions: sessions.length,
    totalPrompts: 0,
    cacheReadRatio: 0,
    sidechainTokenShare: 0,
  };

  /** Input-side tokens that ran inside subagents, for `sidechainTokenShare`. */
  let sidechainInputSideTokens = 0;

  const byModelMap = new Map<string, ModelSummary>();
  const byProjectMap = new Map<string, ProjectSummary>();
  const byDayMap = new Map<string, DaySummary>();
  const sessionSummaries: SessionSummary[] = [];

  for (const session of sessions) {
    let sessionCost = 0;
    let sessionInputTokens = 0;
    let sessionOutputTokens = 0;
    let sessionCacheReadTokens = 0;
    let sessionCacheWriteTokens = 0;

    // Track model message counts to find primaryModel
    const modelMessageCount = new Map<string, number>();

    // Per-message cost accumulation; also track per-model token usage for byDay
    const modelTokensInSession = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();

    for (const msg of session.messages) {
      const cost = computeCost(msg.model, msg.usage);
      sessionCost += cost;
      sessionInputTokens += msg.usage.input_tokens;
      sessionOutputTokens += msg.usage.output_tokens;
      sessionCacheReadTokens += msg.usage.cache_read_input_tokens;
      sessionCacheWriteTokens += msg.usage.cache_creation_input_tokens;

      if (msg.isSidechain) {
        sidechainInputSideTokens +=
          msg.usage.input_tokens +
          msg.usage.cache_read_input_tokens +
          msg.usage.cache_creation_input_tokens;
      }

      // Model message count
      modelMessageCount.set(msg.model, (modelMessageCount.get(msg.model) ?? 0) + 1);

      // Accumulate model tokens for session/day
      const existing = modelTokensInSession.get(msg.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      existing.input += msg.usage.input_tokens;
      existing.output += msg.usage.output_tokens;
      existing.cacheRead += msg.usage.cache_read_input_tokens;
      existing.cacheWrite += msg.usage.cache_creation_input_tokens;
      existing.cost += cost;
      modelTokensInSession.set(msg.model, existing);

      // Accumulate into byModel
      const modelEntry = byModelMap.get(msg.model) ?? {
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessions: 0,
      };
      modelEntry.costUSD += cost;
      modelEntry.inputTokens += msg.usage.input_tokens;
      modelEntry.outputTokens += msg.usage.output_tokens;
      modelEntry.cacheReadTokens += msg.usage.cache_read_input_tokens;
      modelEntry.cacheWriteTokens += msg.usage.cache_creation_input_tokens;
      byModelMap.set(msg.model, modelEntry);
    }

    // Determine primaryModel (most messages)
    let primaryModel = 'unknown';
    let maxCount = 0;
    for (const [model, count] of modelMessageCount) {
      if (count > maxCount) {
        maxCount = count;
        primaryModel = model;
      }
    }

    // Increment session count per model (only once per session, for the primary model)
    // Actually: per spec "sessions" in byModel should count sessions that used that model at all
    // We'll track uniquely per session per model
    for (const model of modelTokensInSession.keys()) {
      const modelEntry = byModelMap.get(model)!;
      modelEntry.sessions += 1;
    }

    // Accumulate summary
    summary.totalCostUSD += sessionCost;
    summary.totalInputTokens += sessionInputTokens;
    summary.totalOutputTokens += sessionOutputTokens;
    summary.totalCacheReadTokens += sessionCacheReadTokens;
    summary.totalCacheWriteTokens += sessionCacheWriteTokens;
    summary.totalPrompts += session.promptCount;

    // Accumulate byProject
    const projectEntry = byProjectMap.get(session.project) ?? {
      project: session.project,
      costUSD: 0,
      sessions: 0,
      prompts: 0,
      transcriptSizeMB: 0,
    };
    projectEntry.costUSD += sessionCost;
    projectEntry.sessions += 1;
    projectEntry.prompts += session.promptCount;
    projectEntry.transcriptSizeMB += session.transcriptSizeMB;
    byProjectMap.set(session.project, projectEntry);

    // Accumulate byDay — use the date from startTime
    const date = session.startTime.slice(0, 10); // YYYY-MM-DD
    const dayEntry = byDayMap.get(date) ?? {
      date,
      costUSD: 0,
      sessions: 0,
      prompts: 0,
      tokensByModel: {},
    };
    dayEntry.costUSD += sessionCost;
    dayEntry.sessions += 1;
    dayEntry.prompts += session.promptCount;

    // Accumulate tokensByModel for the day
    for (const [model, tokens] of modelTokensInSession) {
      const existing: TokenUsage = dayEntry.tokensByModel[model] ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUSD: 0,
      };
      existing.input += tokens.input;
      existing.output += tokens.output;
      existing.cacheRead += tokens.cacheRead;
      existing.cacheWrite += tokens.cacheWrite;
      existing.costUSD += tokens.cost;
      dayEntry.tokensByModel[model] = existing;
    }
    byDayMap.set(date, dayEntry);

    // Compute duration
    const startMs = new Date(session.startTime).getTime();
    const endMs = new Date(session.endTime).getTime();
    const durationMinutes = Math.round((endMs - startMs) / 60_000);

    // Assign flags
    const flags: SessionFlag[] = [];

    if (session.promptCount >= 30 && !compactedSessions.has(session.sessionId)) {
      flags.push('no-compaction');
    }
    if (durationMinutes > 180) {
      flags.push('long-running');
    }
    if (session.transcriptSizeMB > 50) {
      flags.push('large-transcript');
    }
    if (sessionCost > 10) {
      flags.push('high-cost');
    }

    const coldStarts = computeColdStarts(session.messages);

    sessionSummaries.push({
      id: session.sessionId,
      name: sessionNames.get(session.sessionId) ?? '',
      project: session.project,
      primaryModel,
      startTime: session.startTime,
      endTime: session.endTime,
      durationMinutes,
      prompts: session.promptCount,
      costUSD: sessionCost,
      transcriptSizeMB: session.transcriptSizeMB,
      flags,
      cacheReadRatio: asRatio(
        sessionCacheReadTokens,
        sessionInputTokens + sessionCacheReadTokens + sessionCacheWriteTokens,
      ),
      coldStarts: coldStarts.count,
      coldStartExtraUSD: coldStarts.extraUSD,
    });
  }

  const totalInputSideTokens =
    summary.totalInputTokens + summary.totalCacheReadTokens + summary.totalCacheWriteTokens;
  summary.cacheReadRatio = asRatio(summary.totalCacheReadTokens, totalInputSideTokens);
  summary.sidechainTokenShare = asRatio(sidechainInputSideTokens, totalInputSideTokens);

  // Sort sessions by cost descending
  sessionSummaries.sort((a, b) => b.costUSD - a.costUSD);

  // Sort projects by cost descending
  const byProject: ProjectSummary[] = Array.from(byProjectMap.values()).sort(
    (a, b) => b.costUSD - a.costUSD,
  );

  // Sort days by date ascending
  const byDay: DaySummary[] = Array.from(byDayMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const byModel: Record<string, ModelSummary> = Object.fromEntries(byModelMap);

  const output: CcalyzeOutput = {
    range,
    summary,
    byDay,
    byModel,
    byProject,
    sessions: sessionSummaries,
    anomalies: [],
    tips: [],
  };

  if (deep) {
    output.deep = buildDeepData(sessions, sessionSummaries, history);
  }

  return output;
}

/**
 * Build the --deep payload: for each session, the hooks the agent/skill layer
 * needs to generate an /insights-style behavioral report — transcript paths to
 * read, the user's actual typed prompts, and the in-session model timeline —
 * carrying the exact cost/flags ccalyze already computed. ccalyze does NOT do
 * the behavioral analysis itself; it hands the agent a cost-aware index.
 */
export function buildDeepData(
  sessions: EnrichedSession[],
  summaries: SessionSummary[],
  history: HistoryEntry[],
): DeepData {
  const summaryById = new Map(summaries.map((s) => [s.id, s]));

  // Group history prompt-displays by session, in chronological order.
  const displaysBySession = new Map<string, { ts: number; display: string }[]>();
  for (const entry of history) {
    if (!entry.sessionId || !entry.display) continue;
    const list = displaysBySession.get(entry.sessionId) ?? [];
    list.push({ ts: entry.timestamp, display: entry.display });
    displaysBySession.set(entry.sessionId, list);
  }

  const deepSessions: DeepSession[] = sessions.map((session) => {
    const summary = summaryById.get(session.sessionId);

    // Model timeline: messages sorted by time, consecutive duplicates collapsed.
    const modelTimeline: ModelSwitch[] = [];
    const sortedMessages = [...session.messages].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    for (const msg of sortedMessages) {
      const last = modelTimeline[modelTimeline.length - 1];
      if (!last || last.model !== msg.model) {
        modelTimeline.push({ model: msg.model, timestamp: msg.timestamp });
      }
    }

    // The same collapse over main-thread messages only. Subagents alternate
    // models constantly without touching the main conversation's cached prefix,
    // so they must not count toward a signal about cache invalidation.
    let mainModelSwitchCount = 0;
    let lastMainModel: string | undefined;
    for (const msg of sortedMessages) {
      if (msg.isSidechain) continue;
      if (lastMainModel !== undefined && lastMainModel !== msg.model) mainModelSwitchCount++;
      lastMainModel = msg.model;
    }

    // Prompt displays from history (chronological), capped on both axes to keep
    // output lean: how many we emit, and how long each one may be.
    const allDisplays = (displaysBySession.get(session.sessionId) ?? [])
      .sort((a, b) => a.ts - b.ts)
      .map((d) => d.display);
    const promptDisplays = allDisplays
      .slice(0, DEEP_MAX_PROMPT_DISPLAYS)
      .map(capPromptDisplay);

    return {
      id: session.sessionId,
      name: summary?.name ?? '',
      project: session.project,
      primaryModel: summary?.primaryModel ?? 'unknown',
      costUSD: summary?.costUSD ?? 0,
      durationMinutes: summary?.durationMinutes ?? 0,
      prompts: summary?.prompts ?? session.promptCount,
      flags: summary?.flags ?? [],
      transcripts: groupTranscriptsByDir(session.filePaths ?? []),
      promptDisplays,
      promptDisplaysTruncated: allDisplays.length > promptDisplays.length,
      modelTimeline,
      modelSwitchCount: Math.max(0, modelTimeline.length - 1),
      mainModelSwitchCount,
    };
  });

  // Sort by cost desc so the priciest (highest-leverage) sessions lead.
  deepSessions.sort((a, b) => b.costUSD - a.costUSD);

  return {
    note:
      'Deep index for insights fusion. For each session below, read its transcript(s) — ' +
      'transcripts is [{dir, files[]}]; join `${dir}/${file}` for each file in each group — to analyze ' +
      'behavior (what was worked on, friction, outcomes), then fuse those findings with the exact ' +
      'costUSD/flags here — surfacing what native /insights cannot: cost-aware behavioral insights ' +
      '(e.g. which friction patterns or session types cost the most). promptDisplays are the ' +
      'user-typed prompts/commands (long ones truncated); modelSwitchCount is a cheap friction ' +
      'proxy — high churn often tracks high cost.',
    sessions: deepSessions,
  };
}
