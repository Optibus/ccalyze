import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
export async function parseSessionFile(filePath) {
    const byRequest = new Map();
    let sessionId = '';
    let startTime = '';
    let endTime = '';
    let promptCount = 0;
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!sessionId && obj.sessionId) {
            sessionId = obj.sessionId;
        }
        // Track timestamps for duration
        const ts = obj.timestamp;
        if (ts) {
            if (!startTime || ts < startTime)
                startTime = ts;
            if (!endTime || ts > endTime)
                endTime = ts;
        }
        // Count user prompts
        if (obj.type === 'user') {
            promptCount++;
        }
        // Extract usage from assistant messages
        if (obj.type !== 'assistant')
            continue;
        const message = obj.message;
        if (!message?.usage)
            continue;
        const requestId = obj.requestId;
        if (!requestId)
            continue;
        const usage = {
            input_tokens: message.usage.input_tokens ?? 0,
            output_tokens: message.usage.output_tokens ?? 0,
            cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        };
        const existing = byRequest.get(requestId);
        if (existing) {
            // Take max of each field (streaming sends incremental updates)
            existing.usage.input_tokens = Math.max(existing.usage.input_tokens, usage.input_tokens);
            existing.usage.output_tokens = Math.max(existing.usage.output_tokens, usage.output_tokens);
            existing.usage.cache_creation_input_tokens = Math.max(existing.usage.cache_creation_input_tokens, usage.cache_creation_input_tokens);
            existing.usage.cache_read_input_tokens = Math.max(existing.usage.cache_read_input_tokens, usage.cache_read_input_tokens);
            // Keep later timestamp
            if (ts && ts > existing.timestamp)
                existing.timestamp = ts;
        }
        else {
            byRequest.set(requestId, {
                requestId,
                sessionId,
                model: message.model ?? 'unknown',
                timestamp: ts ?? '',
                usage,
                // Subagent transcripts live in their own files and mark every entry;
                // older transcripts omit the field entirely, which reads as main-thread.
                isSidechain: obj.isSidechain === true,
            });
        }
    }
    return {
        sessionId,
        startTime,
        endTime,
        messages: Array.from(byRequest.values()),
        promptCount,
    };
}
export async function parseHistoryFile(filePath, from, to) {
    const entries = [];
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        const ts = obj.timestamp;
        if (typeof ts !== 'number')
            continue;
        if (ts < fromMs || ts >= toMs)
            continue;
        entries.push({
            display: obj.display ?? '',
            timestamp: ts,
            project: obj.project ?? '',
            sessionId: obj.sessionId ?? '',
        });
    }
    return entries;
}
//# sourceMappingURL=parser.js.map