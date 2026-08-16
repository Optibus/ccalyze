import { resolve } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';
import type { EnrichedSession } from './aggregator.ts';
import type { ParsedMessage } from './types.ts';

/**
 * Find the session transcripts touched within [from, to].
 *
 * Deduplicates by physical file (device + inode), not by path. `~/.claude/projects`
 * routinely contains several slugs pointing at the same directory — the git-aware
 * history setup symlinks each worktree slug to the git-root slug — so one transcript
 * is reachable through many paths. Counting it once per path inflated every number
 * ccalyze reports by the number of aliases (measured: 14x on a real session, 7.26x
 * on a real 7-day total). Deduping here also avoids re-parsing the same 70MB file
 * once per alias.
 */
export function discoverSessionFiles(
  claudeDir: string,
  from: Date,
  to: Date,
): { filePath: string; project: string }[] {
  const projectsDir = resolve(claudeDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  const results: { filePath: string; project: string }[] = [];
  /** Physical files already collected, keyed `device:inode`. */
  const seenFiles = new Set<string>();
  const toEnd = new Date(to);
  toEnd.setDate(toEnd.getDate() + 1);

  /** Collect a transcript if it is in range and not already seen via another path. */
  const collect = (filePath: string, project: string): void => {
    let fstat;
    try {
      fstat = statSync(filePath);
    } catch {
      return;
    }
    if (fstat.mtime < from || fstat.mtime > toEnd) return;

    const physicalKey = `${fstat.dev}:${fstat.ino}`;
    if (seenFiles.has(physicalKey)) return;
    seenFiles.add(physicalKey);
    results.push({ filePath, project });
  };

  for (const projDir of readdirSync(projectsDir)) {
    const projPath = resolve(projectsDir, projDir);
    let stat;
    try {
      stat = statSync(projPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Extract readable project name: "-Users-jane-dev-my-project" -> "my-project"
    // Take everything after the last "dev-" or fall back to last segment
    const devIdx = projDir.lastIndexOf('-dev-');
    const project = devIdx >= 0 ? projDir.slice(devIdx + 5) : projDir.split('-').pop() || projDir;

    for (const entry of readdirSync(projPath)) {
      const entryPath = resolve(projPath, entry);

      if (entry.endsWith('.jsonl')) {
        collect(entryPath, project);
        continue;
      }

      let entryStat;
      try {
        entryStat = statSync(entryPath);
      } catch {
        continue;
      }
      if (!entryStat.isDirectory()) continue;

      const subagentsDir = resolve(entryPath, 'subagents');
      if (!existsSync(subagentsDir)) continue;

      for (const subFile of readdirSync(subagentsDir)) {
        if (!subFile.endsWith('.jsonl')) continue;
        collect(resolve(subagentsDir, subFile), project);
      }
    }
  }

  return results;
}

/** Fold `incoming` into `existing`, keeping the max of each token field. */
function mergeUsage(existing: ParsedMessage, incoming: ParsedMessage): void {
  const a = existing.usage;
  const b = incoming.usage;
  a.input_tokens = Math.max(a.input_tokens, b.input_tokens);
  a.output_tokens = Math.max(a.output_tokens, b.output_tokens);
  a.cache_creation_input_tokens = Math.max(
    a.cache_creation_input_tokens,
    b.cache_creation_input_tokens,
  );
  a.cache_read_input_tokens = Math.max(a.cache_read_input_tokens, b.cache_read_input_tokens);
  if (incoming.timestamp > existing.timestamp) existing.timestamp = incoming.timestamp;
}

/**
 * Merge the per-file parse results belonging to one session (its main transcript
 * plus any subagent transcripts) into a single session.
 *
 * Deduplicates messages by `requestId` — the same rule `parseSessionFile` applies
 * within a file, applied again across files. `discoverSessionFiles` already drops
 * aliased paths, so this is a safety net: any other way the same message arrives
 * twice (hardlinks, a future change to discovery) still cannot double the cost.
 * `promptCount`/`transcriptSizeMB` are not per-message, so they are guarded by
 * skipping a `filePath` that has already contributed.
 */
export function mergeSessions(sessions: EnrichedSession[]): EnrichedSession[] {
  const merged = new Map<
    string,
    { session: EnrichedSession; byRequest: Map<string, ParsedMessage>; paths: Set<string> }
  >();

  for (const session of sessions) {
    const entry = merged.get(session.sessionId);

    if (!entry) {
      const byRequest = new Map<string, ParsedMessage>();
      for (const msg of session.messages) {
        const seen = byRequest.get(msg.requestId);
        if (seen) mergeUsage(seen, msg);
        else byRequest.set(msg.requestId, msg);
      }
      merged.set(session.sessionId, {
        session: { ...session, messages: [], filePaths: [...(session.filePaths ?? [])] },
        byRequest,
        paths: new Set(session.filePaths ?? []),
      });
      continue;
    }

    const { session: target, byRequest, paths } = entry;

    for (const msg of session.messages) {
      const seen = byRequest.get(msg.requestId);
      if (seen) mergeUsage(seen, msg);
      else byRequest.set(msg.requestId, msg);
    }

    // Per-file totals: only count a transcript that has not contributed already.
    const newPaths = (session.filePaths ?? []).filter((p) => !paths.has(p));
    const isNewFile = newPaths.length > 0 || (session.filePaths ?? []).length === 0;
    if (isNewFile) {
      target.promptCount += session.promptCount;
      target.transcriptSizeMB += session.transcriptSizeMB;
    }
    for (const p of newPaths) {
      paths.add(p);
      target.filePaths = [...(target.filePaths ?? []), p];
    }

    if (session.startTime < target.startTime) target.startTime = session.startTime;
    if (session.endTime > target.endTime) target.endTime = session.endTime;
  }

  return [...merged.values()].map(({ session, byRequest }) => ({
    ...session,
    messages: [...byRequest.values()],
  }));
}
