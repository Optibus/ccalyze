/**
 * Parser for Anthropic's published pricing page (the markdown rendering of
 * platform.claude.com/docs/en/about-claude/pricing). Pure: the caller fetches.
 *
 * The page is prose-adjacent markup, not an API, so every guard here exists to
 * make a layout change fail LOUDLY. Returning a plausible partial table would
 * silently mis-price every session; a thrown error is just a stale-prices day.
 */
/** A table with fewer parsed rows than this means the page changed shape, not that Anthropic dropped models. */
export const MIN_PRICING_ROWS = 10;
/** Models the table must contain — a parse that loses these is wrong, however many other rows it found. */
export const REQUIRED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const MODEL_NAME = /^Claude (Fable|Mythos|Opus|Sonnet|Haiku) \d+(\.\d+)?$/;
/**
 * "Claude Opus 5.5" -> "claude-opus-5-5". Links and parenthetical notes
 * ("([limited availability](...))", "([retired, ...](...))") are dropped first.
 */
export function modelIdFromDisplayName(name) {
    const clean = name.replace(/\s*\(.*\)\s*$/, '').trim();
    if (!MODEL_NAME.test(clean))
        return undefined;
    return clean.toLowerCase().replace(/\./g, '-').replace(/ /g, '-');
}
const HEADERS = {
    model: 'Model',
    input: 'Base input tokens',
    cacheWrite: '5m cache writes',
    cacheRead: 'Cache hits and refreshes',
    output: 'Output tokens',
};
function cells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}
/** "$0.25 / MTok<sup>1</sup>" -> 0.25. Throws rather than guessing at a cell it cannot read. */
function parseDollars(cell, model, column) {
    const text = cell.replace(/<sup>.*?<\/sup>/g, '').trim();
    const m = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok$/.exec(text);
    const value = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Pricing page: "${model}" ${column} cell "${cell}" is not a positive $ / MTok price`);
    }
    return value;
}
const TIER_QUALIFIER = /\(for prompts (?:up to|over) [\d,]+ tokens\)/i;
const KNOWN_NOTE = /\(\[(?:limited availability|retired)\b/i;
export function parsePricingPage(markdown) {
    const lines = markdown.split('\n');
    const start = lines.findIndex((l) => /^##\s+Model pricing\s*$/.test(l));
    if (start === -1)
        throw new Error('Pricing page: no "## Model pricing" section found');
    // Only the first table of that section: the page's later tables (batch, tool
    // tokens, cloud platforms) reuse model names at different prices.
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    const section = end === -1 ? rest : rest.slice(0, end);
    const tableStart = section.findIndex((l) => l.trim().startsWith('|'));
    if (tableStart === -1)
        throw new Error('Pricing page: no table under "## Model pricing"');
    const table = [];
    for (const l of section.slice(tableStart)) {
        if (!l.trim().startsWith('|'))
            break;
        table.push(l);
    }
    // Columns by header text, not position, so a reordered or inserted column
    // cannot shift prices onto the wrong field.
    const header = cells(table[0]);
    const col = {};
    for (const [key, text] of Object.entries(HEADERS)) {
        col[key] = header.indexOf(text);
        if (col[key] === -1)
            throw new Error(`Pricing page: required column "${text}" not found in the Model pricing table`);
    }
    const result = {};
    const tieredIds = new Set();
    const retired = [];
    for (const line of table.slice(1)) {
        const row = cells(line);
        if (row.every((c) => /^:?-+:?$/.test(c)))
            continue; // the |---|---| separator
        const name = row[col.model];
        const id = modelIdFromDisplayName(name);
        if (!id)
            throw new Error(`Pricing page: unrecognised model name "${name}"`);
        if (/\(\s*\[?retired/i.test(name)) {
            // Not worth a mapping table: Claude 3.x API ids use the old
            // `claude-3-5-haiku` naming, which the display-name rule cannot produce.
            retired.push(id);
            continue;
        }
        if (TIER_QUALIFIER.test(name)) {
            // Priced by prompt length, which ccalyze has no per-request way to pick
            // (it has one flat rate per model). Returning either tier would silently
            // misprice: Claude Code prompts routinely exceed 100k tokens.
            tieredIds.add(id);
            continue;
        }
        if (/\(/.test(name) && !KNOWN_NOTE.test(name)) {
            throw new Error(`Pricing page: unrecognised qualifier in model name "${name}"`);
        }
        if (result[id] || tieredIds.has(id))
            throw new Error(`Pricing page: model "${id}" appears twice ("${name}")`);
        result[id] = {
            input: parseDollars(row[col.input], name, HEADERS.input),
            output: parseDollars(row[col.output], name, HEADERS.output),
            cacheRead: parseDollars(row[col.cacheRead], name, HEADERS.cacheRead),
            cacheWrite: parseDollars(row[col.cacheWrite], name, HEADERS.cacheWrite),
        };
    }
    const tiered = [...tieredIds];
    const count = Object.keys(result).length;
    if (count < MIN_PRICING_ROWS) {
        throw new Error(`Pricing page: only ${count} model rows parsed, expected at least ${MIN_PRICING_ROWS}`);
    }
    const missing = REQUIRED_MODELS.filter((id) => !result[id]);
    if (missing.length)
        throw new Error(`Pricing page: required model(s) missing: ${missing.join(', ')}`);
    return { prices: result, tiered, retired };
}
//# sourceMappingURL=pricing-page.js.map