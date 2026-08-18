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
  /**
   * Which kind of context compaction this session saw, if any: `manual` (a
   * `/compact` entry in history.jsonl) beats `auto` (Claude Code compacted on
   * its own after context filled up) beats `none`. A session could in theory
   * see both; manual wins because it was a choice.
   */
  compaction: 'manual' | 'auto' | 'none';
  /**
   * Times this session auto-compacted. Zero on transcripts old enough to
   * predate the field Claude Code stamps on the synthetic continuation
   * message — reads as `none` above, same as a session that never filled up.
   */
  autoCompactions: number;
  /**
   * Extra edits to a file this session already edited — `Edit`/`Write`/
   * `MultiEdit` tool calls beyond the first per file. Not a judgement on its
   * own: plenty of iteration is normal. A session with a lot is worth reading
   * for whether it was iterating or thrashing.
   */
  reworkEdits: number;
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

// --- Habit tracking (emitted only with --habits) ---
// Everything above describes ONE window. --habits compares two adjacent,
// equal-length windows of complete days against each other, because that is the
// only comparison that can separate "more work" from "a worse habit": totals
// cannot, and neither can a benchmark taken from someone else's usage.

/** A cohort of sessions (flagged vs. unflagged) sized against the whole window. */
export interface HabitsCohort {
  sessions: number;
  cost: number;
  /** Percent of the window's cost, 0-100. */
  costShare: number;
  prompts: number;
  /** Percent of the window's prompts, 0-100. */
  promptShare: number;
  /** Cost per prompt, or null when the cohort ran no prompts. */
  perPrompt: number | null;
}

/**
 * Per-model row built from the per-session table, so it carries prompt counts.
 *
 * `byModel` in `CcalyzeOutput` is token-level and authoritative for cost share,
 * but has no prompt count — a prompt is a session-level thing. Per-prompt rates
 * must therefore come from here, and the two disagree because a session runs more
 * than one model. Both ship, each labelled by what it measures.
 */
export interface HabitsModelRow {
  model: string;
  cost: number;
  costShare: number;
  prompts: number;
  sessions: number;
  perPrompt: number | null;
}

/** Token-level model cost share — authoritative for "what did Opus cost me". */
export interface HabitsModelCostShare {
  model: string;
  cost: number;
  costShare: number;
}

export interface HabitsDurationBand {
  band: string;
  sessions: number;
  cost: number;
  costShare: number;
  prompts: number;
}

export interface HabitsProjectRow {
  project: string;
  cost: number;
  prompts: number;
  perPrompt: number | null;
}

/** One window, reduced to the figures a habit comparison reads. */
export interface HabitsWindow {
  range: DateRange;
  unit: string;
  /** Days in the window that actually carry data — the coverage floor reads this. */
  daysCovered: number;
  cost: number;
  prompts: number;
  sessions: number;
  perPrompt: number | null;
  /** `summary.cacheReadRatio` as a percentage, 0-100. */
  cacheReadShare: number;
  /**
   * `summary.sidechainTokenShare` as a percentage, 0-100 — share of input-side
   * tokens spent inside subagents. Read as delegation, not friction: those
   * tokens are read once in a clean context and never rejoin the window that
   * gets resent on every later turn, so a rising share is the good direction.
   */
  subagentTokenShare: number;
  coldStart: {
    /** Summed `coldStartExtraUSD` — the avoidable premium, not the whole rebuild. */
    extra: number;
    share: number;
    /** Sessions that tripped the `cache_cold_start` anomaly. */
    sessions: number;
  };
  noCompactionShare: number;
  /**
   * Share of sessions that hit the auto-compact wall (`compaction === 'auto'`)
   * rather than choosing to `/compact`. Hitting the wall means context ran out
   * before the person acted on it — a friction signal `/compact`-share cannot
   * see, since both currently read as "compacted".
   */
  autoCompactionShare: number;
  /**
   * Share of sessions with at least one repeated same-file edit
   * (`reworkEdits > 0`). Not a judgement of the level — plenty of legitimate
   * iteration looks the same — but a rising share across two windows is worth
   * reading as friction.
   */
  reworkShare: number;
  longRunningSessions: number;
  /** Share of the window's cost carried by its three priciest sessions. */
  top3Share: number;
  /**
   * Share of the window's cost carried by sessions that *started* at night
   * (local clock, before 08:00 or at/after 20:00) or on a Saturday/Sunday.
   *
   * Read off `SessionSummary.startTime` in the analysis machine's own local
   * time zone — the only "local" a stored UTC timestamp can honestly recover,
   * since Claude Code transcripts carry no time-zone field. That only holds
   * if ccalyze runs on the same device/time zone the work happened in.
   */
  offHoursShare: number;
  flagged: HabitsCohort;
  clean: HabitsCohort;
  /**
   * False when unflagged sessions hold too few prompts to serve as a baseline.
   * A 2x flagged/unflagged ratio drawn from a 3% cohort proves nothing, and
   * uniformly long sessions leave no clean cohort by construction.
   */
  cleanCohortUsable: boolean;
  byModel: HabitsModelRow[];
  modelCostShare: HabitsModelCostShare[];
  byDuration: HabitsDurationBand[];
  byProject: HabitsProjectRow[];
  anomalyCounts: Record<string, number>;
  tips: string[];
}

/**
 * `flat` is not a hedge: a sub-5% relative move is noise, and a scorecard that
 * books noise as a win stops being worth reading. `no-baseline` means there was
 * no prior window to compare against.
 */
export type HabitsVerdict = 'much better' | 'better' | 'flat' | 'worse' | 'no-baseline';

export interface HabitsScorecardRow {
  measure: string;
  prior: number | null;
  current: number | null;
  verdict: HabitsVerdict;
}

/** A sized, independently-derived estimate of what is still on the table. */
export interface HabitsLever {
  lever: 'model-mix' | 'project-floor';
  basis: string;
  ceiling: number;
  ceilingShare: number;
  /** Present only where a ceiling is knowably unreachable in full. */
  realistic?: number;
  realisticShare?: number;
  ratio?: number;
  note: string;
}

/**
 * Which of the three explanations the data supports. Checked in order, because
 * they call for opposite responses: `volume` means the ceiling is the problem and
 * there is no habit to fix, `efficiency-regression` means there is.
 */
export interface HabitsHeadline {
  finding: 'volume' | 'efficiency-regression' | 'mixed' | 'single-window';
  why: string;
}

export interface HabitsDelta {
  cost: number | null;
  prompts: number | null;
  perPrompt: number | null;
  sessions: number | null;
}

export interface HabitsReport {
  generatedFrom: 'ccalyze';
  unit: string;
  current: HabitsWindow;
  /** Null only in single-window mode: habits are being described, not tracked. */
  prior: HabitsWindow | null;
  delta: HabitsDelta | null;
  headline: HabitsHeadline;
  scorecard: HabitsScorecardRow[];
  levers: HabitsLever[];
  /** Reading notes that keep the numbers honest; ship them with the figures. */
  caveats: Record<string, string>;
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
  /**
   * File paths this message's `Edit`/`Write`/`MultiEdit` tool_use blocks
   * touched, for rework tracking. Empty when it made no such calls.
   */
  editedFiles: string[];
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
