export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUSD: number;
}

export interface Summary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalSessions: number;
  totalPrompts: number;
  /**
   * Share of input-side tokens served from cache: cacheRead / (input + cacheRead
   * + cacheWrite), 0-1.
   *
   * Output tokens are excluded on purpose — they are never cacheable, so folding
   * them in only dilutes the signal with a term you cannot act on.
   *
   * This is the single best predictor of quota burn. The API is stateless, so
   * every turn resends the whole conversation; a cache read costs 0.1x the input
   * rate and, on a subscription, consumes quota at that same discounted rate.
   * Two people doing identical work burn very different amounts of plan
   * depending on this one number.
   */
  cacheReadRatio: number;
  /**
   * Share of input-side tokens spent inside subagents (`isSidechain`), 0-1.
   *
   * Subagent tokens are read once in a clean context and thrown away; they never
   * join the main window, so they are not re-read on every later turn. A high
   * share means noisy work is being kept out of the conversation that gets
   * resent — which is why it reads as a *good* signal, not a cost warning.
   */
  sidechainTokenShare: number;
}

export interface DaySummary {
  date: string;
  costUSD: number;
  sessions: number;
  prompts: number;
  tokensByModel: Record<string, TokenUsage>;
}

export interface ModelSummary {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessions: number;
}

export interface ProjectSummary {
  project: string;
  costUSD: number;
  sessions: number;
  prompts: number;
  transcriptSizeMB: number;
}

export type AnomalyType =
  | 'session_no_compaction'
  | 'long_running_session'
  | 'concurrent_opus'
  | 'cost_spike'
  | 'large_transcript'
  | 'subagent_heavy'
  /** Heavy model churn in an expensive session. Only emitted for --deep runs. */
  | 'high_model_churn'
  /** An expensive session served an unusually low share of its tokens from cache. */
  | 'low_cache_efficiency'
  /** A session repeatedly rebuilt its cache from cold after the TTL expired. */
  | 'cache_cold_start'
  /** A model in this range has no published pricing — its cost is an estimate. */
  | 'unknown_model_pricing';

export type Severity = 'high' | 'medium' | 'low';

export interface Anomaly {
  type: AnomalyType;
  severity: Severity;
  sessionId?: string;
  detail: string;
}

export type SessionFlag =
  | 'no-compaction'
  | 'long-running'
  | 'high-cost'
  | 'large-transcript'
  | 'subagent-heavy';

export interface SessionSummary {
  id: string;
  /**
   * Human-readable label for the session, derived from the first prompt the user
   * typed. Claude Code stores no session title anywhere in the transcripts, so
   * there is nothing to read — this is the closest honest stand-in. Empty when
   * the session has no matching history entry.
   */
  name: string;
  project: string;
  primaryModel: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  prompts: number;
  costUSD: number;
  transcriptSizeMB: number;
  flags: SessionFlag[];
  /** Share of this session's input-side tokens served from cache, 0-1. */
  cacheReadRatio: number;
  /**
   * Times this session rebuilt its prompt cache from cold — a long idle gap
   * (past the cache TTL) followed by a large cache write.
   */
  coldStarts: number;
  /**
   * List-price premium paid for those rebuilds: the rebuilt tokens cost the
   * cache-write rate (1.25x input) where a live cache would have charged the
   * cache-read rate (0.1x input). This is the avoidable part, not the whole
   * rebuild.
   */
  coldStartExtraUSD: number;
}

export interface CcalyzeOutput {
  range: DateRange;
  summary: Summary;
  byDay: DaySummary[];
  byModel: Record<string, ModelSummary>;
  byProject: ProjectSummary[];
  sessions: SessionSummary[];
  anomalies: Anomaly[];
  tips: string[];
  /** Populated only with --deep: per-session behavioral hooks for insights fusion. */
  deep?: DeepData;
}

// --- Deep / insights-fusion data (emitted only with --deep) ---
// ccalyze stays the cheap deterministic cost+session INDEX; --deep hands the
// agent layer the hooks it needs to produce an /insights-style behavioral
// narrative (which transcripts to read, what the user actually typed, where the
// model switched) fused with ccalyze's exact cost/anomaly numbers.

export interface ModelSwitch {
  model: string;
  timestamp: string;
}

/**
 * A session's transcript files in one directory.
 *
 * A session that used subagents heavily merges hundreds of paths that differ
 * only in their filename; repeating the full directory on each one dominated the
 * --deep payload (~55% of it on real data). Grouping by directory states each
 * directory once. Rebuild any full path as `${dir}/${file}` — lossless, and with
 * no empty-prefix edge cases to reason about.
 *
 * A single shared-prefix `baseDir` was tried first and rejected: sessions merge
 * transcripts across several project directories, so the common prefix collapsed
 * to `~/.claude/projects` and saved only 14% where grouping saves 49%.
 */
export interface TranscriptDirGroup {
  /** Absolute directory path, no trailing slash. */
  dir: string;
  /** Transcript filenames within `dir`. */
  files: string[];
}

export interface DeepSession {
  id: string;
  /** Same derived label as `SessionSummary.name`. */
  name: string;
  project: string;
  primaryModel: string;
  costUSD: number;
  durationMinutes: number;
  prompts: number;
  flags: SessionFlag[];
  /**
   * Transcript file(s) for the agent to read for behavioral analysis, grouped by
   * directory. Full path = `${dir}/${file}`.
   */
  transcripts: TranscriptDirGroup[];
  /** The user-typed prompts/slash-commands for this session (from history.jsonl). */
  promptDisplays: string[];
  /** True if promptDisplays was capped (see DEEP_MAX_PROMPT_DISPLAYS). */
  promptDisplaysTruncated: boolean;
  /** Model-switch timeline within the session (consecutive duplicates collapsed). */
  modelTimeline: ModelSwitch[];
  /**
   * Number of model changes in the session's message stream
   * (`modelTimeline.length - 1`). A cheap deterministic churn signal, so consumers
   * can rank sessions without reading a transcript. Counts every model change —
   * including subagent and background calls, not just user `/model` switches — so
   * it indicates where to look, not friction on its own.
   */
  modelSwitchCount: number;
  /**
   * Model changes counted over the **main thread only** (`isSidechain` messages
   * excluded).
   *
   * `modelSwitchCount` above counts every model change in the session, which in
   * practice is dominated by subagents alternating models — legitimate, and the
   * reason that signal had to carry a "probably just delegation" caveat. A change
   * on the main thread is a different thing: the prompt cache is keyed to the
   * model, so switching mid-session discards the cached prefix and pays to
   * rebuild it. This is the number to act on.
   */
  mainModelSwitchCount: number;
}

export interface DeepData {
  /** Guidance for the agent/skill layer consuming this data. */
  note: string;
  sessions: DeepSession[];
}

// Internal types used during parsing (not part of output)

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ParsedMessage {
  requestId: string;
  sessionId: string;
  model: string;
  timestamp: string;
  usage: RawUsage;
  /**
   * True when this message ran inside a subagent rather than the main thread.
   * Absent in older transcripts, in which case it reads as false.
   */
  isSidechain: boolean;
}

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface ModelPricing {
  input: number;   // per million tokens
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
