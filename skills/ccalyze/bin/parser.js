import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
/** Tool names whose `input.file_path` counts as an edit, for rework tracking. */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit']);
/** File paths edited by `Edit`/`Write`/`MultiEdit` tool_use blocks in a message's content. */
function extractEditedFiles(content) {
    if (!Array.isArray(content))
        return [];
    const files = [];
    for (const block of content) {
        if (block?.type === 'tool_use' &&
            EDIT_TOOL_NAMES.has(block.name) &&
            typeof block.input?.file_path === 'string') {
            files.push(block.input.file_path);
        }
    }
    return files;
}
export async function parseSessionFile(filePath) {
    const byRequest = new Map();
    let sessionId = '';
    let startTime = '';
    let endTime = '';
    let promptCount = 0;
    let autoCompactions = 0;
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
        // Count user prompts — except the synthetic continuation message an
        // auto-compact injects, which is not something the person typed.
        if (obj.type === 'user') {
            if (obj.isCompactSummary === true) {
                autoCompactions++;
            }
            else {
                promptCount++;
            }
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
        const editedFiles = extractEditedFiles(message.content);
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
            // A streaming update's content is cumulative — only overwrite once it is
            // non-empty, so an earlier, fuller update is never clobbered by a later
            // partial one that has not caught up yet.
            if (editedFiles.length)
                existing.editedFiles = editedFiles;
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