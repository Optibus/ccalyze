#!/usr/bin/env node
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { statSync, existsSync } from 'node:fs';
import { parseSessionFile, parseHistoryFile } from "./parser.js";
import { discoverSessionFiles, mergeSessions } from "./discovery.js";
import { aggregate } from "./aggregator.js";
import { detectAnomalies } from "./anomalies.js";
import { generateTips } from "./tips.js";
import { VERSION } from "./version.js";
export function parseArgs(argv) {
    const flags = { json: false, deep: false, viz: false, version: false };
    const positional = [];
    for (const arg of argv) {
        if (arg === '--json')
            flags.json = true;
        else if (arg === '--deep')
            flags.deep = true;
        else if (arg === '--viz')
            flags.viz = true;
        else if (arg === '--version' || arg === '-v')
            flags.version = true;
        else if (!arg.startsWith('--'))
            positional.push(arg);
    }
    if (positional.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(positional[0]) && /^\d{4}-\d{2}-\d{2}$/.test(positional[1])) {
        return { rangeArg: 'custom', customFrom: positional[0], customTo: positional[1], ...flags };
    }
    const rangeArg = positional[0] ?? '7d';
    return { rangeArg, ...flags };
}
export function resolveDateRange(rangeArg, customFrom, customTo) {
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
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.version) {
        console.log(VERSION);
        return;
    }
    const range = resolveDateRange(args.rangeArg, args.customFrom, args.customTo);
    const claudeDir = resolve(homedir(), '.claude');
    const from = new Date(range.from);
    const to = new Date(range.to);
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 1);
    // Parse history
    const historyPath = resolve(claudeDir, 'history.jsonl');
    const history = existsSync(historyPath)
        ? await parseHistoryFile(historyPath, from, toEnd)
        : [];
    // Discover and parse session files
    const sessionFiles = discoverSessionFiles(claudeDir, from, toEnd);
    const sessions = [];
    for (const { filePath, project } of sessionFiles) {
        const parsed = await parseSessionFile(filePath);
        if (parsed.messages.length === 0)
            continue;
        // Filter messages to only those within the date range
        const fromStr = from.toISOString();
        const toEndStr = toEnd.toISOString();
        const filteredMessages = parsed.messages.filter(m => m.timestamp >= fromStr && m.timestamp < toEndStr);
        if (filteredMessages.length === 0)
            continue;
        // Recalculate start/end from filtered messages
        const timestamps = filteredMessages.map(m => m.timestamp).sort();
        const startTime = timestamps[0];
        const endTime = timestamps[timestamps.length - 1];
        let fstat;
        try {
            fstat = statSync(filePath);
        }
        catch {
            continue;
        }
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
    let output = aggregate(mergedSessions, history, range, args.deep);
    // Detect anomalies
    output.anomalies = detectAnomalies(output);
    // Generate tips
    output.tips = generateTips(output);
    // Output
    console.log(JSON.stringify(output, null, 2));
}
main().catch(err => {
    console.error('ccalyze error:', err.message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map