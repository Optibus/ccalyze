import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ParsedMessage, HistoryEntry, RawUsage, Interaction } from './types.ts';

/** Tool names whose `input.file_path` counts as an edit, for rework tracking. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit']);

/** File paths edited by `Edit`/`Write`/`MultiEdit` tool_use blocks in a message's content. */
function extractEditedFiles(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const block of content) {
    if (
      block?.type === 'tool_use' &&
      EDIT_TOOL_NAMES.has(block.name) &&
      typeof block.input?.file_path === 'string'
    ) {
      files.push(block.input.file_path);
    }
  }
  return files;
}

/**
 * Opening words that push back on the previous turn.
 *
 * Anchored to the start of the instruction on purpose: "no" or "wrong" in the
 * middle of a sentence is usually content ("there is no cache here"), while the
 * same word leading the reply is usually a verdict on what Claude just did. It is
 * a heuristic and it ships as one — it misses a polite correction and catches the
 * odd "no rush, but…" — so the report only ever reads its direction across two
 * windows, never its level.
 */
export const CORRECTION_RE = new RegExp(
  '^(?:' +
    [
      'no\\b',
      'nope\\b',
      'wrong\\b',
      'undo\\b',
      'revert\\b',
      'stop\\b',
      'wait\\b',
      'actually\\b',
      'try again\\b',
      "that'?s (?:not|wrong|incorrect)\\b",
      "this is (?:not|wrong|incorrect)\\b",
      "(?:it|that|this) (?:still )?(?:doesn'?t|didn'?t|isn'?t|is not|does not|did not) work",
      'still (?:not|wrong|broken|failing|the same)\\b',
      "you (?:didn'?t|did not|forgot|missed|broke|misunderstood)\\b",
      'why did you\\b',
      "not (?:what|quite|that)\\b",
    ].join('|') +
    ')',
  'i',
);

/** Interrupt marker Claude Code writes as user text when the person presses Esc. */
const INTERRUPT_PREFIX = '[Request interrupted by user';

/**
 * Classify one `type:"user"` transcript line into interaction events.
 *
 * A line carries either tool results (one event per block — parallel tool calls
 * land in one line) or text. Text is an interrupt marker, a wrapper Claude Code
 * injected (`<command-name>`, `<local-command-stdout>`, `<task-notification>`,
 * …), or something the person typed. Only the last is an instruction.
 *
 * Subagent lines are dropped except for their tool results: the "user" text of a
 * sidechain is the parent's Task prompt, written by Claude, not by the person.
 */
export function classifyUserLine(obj: any): Interaction['kind'][] {
  if (obj.isMeta === true || obj.isCompactSummary === true) return [];
  const content = obj.message?.content;

  if (Array.isArray(content)) {
    const results = content.filter((b: any) => b?.type === 'tool_result');
    if (results.length) {
      return results.map((b: any) => (b.is_error === true ? 'tool-error' : 'tool-ok'));
    }
  }
  if (obj.isSidechain === true) return [];

  const text = (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n')
        : ''
  ).trim();
  if (!text) return [];
  if (text.startsWith(INTERRUPT_PREFIX)) return ['interrupt'];
  if (text.startsWith('<')) return [];
  return [CORRECTION_RE.test(text) ? 'correction' : 'instruction'];
}

export interface SessionParseResult {
  sessionId: string;
  startTime: string;
  endTime: string;
  messages: ParsedMessage[];
  promptCount: number;
  /**
   * Times Claude Code auto-compacted this session (a synthetic `type:"user"`
   * message carrying `isCompactSummary:true`, injected when context filled up
   * — distinct from a person typing `/compact`, which lives in history.jsonl
   * instead). Optional because it is absent on transcripts old enough to
   * predate the field, which reads as zero.
   */
  autoCompactions?: number;
  /**
   * Classified user-side events (typed instructions, corrections, interrupts,
   * tool results). Kept per event with its timestamp so the date filter in
   * `analyzeRange` applies to them exactly as it does to messages. Optional so
   * a hand-built result without it reads as a session with no user events.
   */
  interactions?: Interaction[];
}

export async function parseSessionFile(filePath: string): Promise<SessionParseResult> {
  const byRequest = new Map<string, ParsedMessage>();
  let sessionId = '';
  let startTime = '';
  let endTime = '';
  let promptCount = 0;
  let autoCompactions = 0;
  const interactions: Interaction[] = [];

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && obj.sessionId) {
      sessionId = obj.sessionId;
    }

    // Track timestamps for duration
    const ts = obj.timestamp;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    // Count user prompts — except the synthetic continuation message an
    // auto-compact injects, which is not something the person typed.
    if (obj.type === 'user') {
      if (obj.isCompactSummary === true) {
        autoCompactions++;
      } else {
        promptCount++;
      }
      for (const kind of classifyUserLine(obj)) {
        interactions.push({ kind, timestamp: ts ?? '' });
      }
    }

    // Extract usage from assistant messages
    if (obj.type !== 'assistant') continue;
    const message = obj.message;
    if (!message?.usage) continue;
    const requestId = obj.requestId;
    if (!requestId) continue;

    const usage: RawUsage = {
      input_tokens: message.usage.input_tokens ?? 0,
      output_tokens: message.usage.output_tokens ?? 0,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
    };

    const editedFiles = extractEditedFiles(message.content);

    const existing = byRequest.get(requestId);
    if (existing) {
      // Take max of each field (streaming sends incremental updates)
      existing.usage.input_tokens = Math.max(existing.usage.input_tokens, usage.input_tokens);
      existing.usage.output_tokens = Math.max(existing.usage.output_tokens, usage.output_tokens);
      existing.usage.cache_creation_input_tokens = Math.max(existing.usage.cache_creation_input_tokens, usage.cache_creation_input_tokens);
      existing.usage.cache_read_input_tokens = Math.max(existing.usage.cache_read_input_tokens, usage.cache_read_input_tokens);
      // Keep later timestamp
      if (ts && ts > existing.timestamp) existing.timestamp = ts;
      // A streaming update's content is cumulative — only overwrite once it is
      // non-empty, so an earlier, fuller update is never clobbered by a later
      // partial one that has not caught up yet.
      if (editedFiles.length) existing.editedFiles = editedFiles;
    } else {
      byRequest.set(requestId, {
        requestId,
        sessionId,
        model: message.model ?? 'unknown',
        timestamp: ts ?? '',
        usage,
        // Subagent transcripts live in their own files and mark every entry;
        // older transcripts omit the field entirely, which reads as main-thread.
        isSidechain: obj.isSidechain === true,
        editedFiles,
      });
    }
  }

  return {
    sessionId,
    startTime,
    endTime,
    messages: Array.from(byRequest.values()),
    promptCount,
    autoCompactions,
    interactions,
  };
}

export async function parseHistoryFile(
  filePath: string,
  from: Date,
  to: Date,
): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.timestamp;
    if (typeof ts !== 'number') continue;
    if (ts < fromMs || ts >= toMs) continue;

    entries.push({
      display: obj.display ?? '',
      timestamp: ts,
      project: obj.project ?? '',
      sessionId: obj.sessionId ?? '',
    });
  }

  return entries;
}
