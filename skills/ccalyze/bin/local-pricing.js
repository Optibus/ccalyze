import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { effectiveModels, MODEL_PRICING } from "./cost.js";
import { parsePricingPage } from "./pricing-page.js";
/**
 * Per-machine price refresh. Prices drift faster than releases ship (twice in
 * one week), and a fix through commit -> bundle -> plugin update must reach
 * every PC. So a machine can refresh its own table — explicitly, never in the
 * background: an automatic fetch would let a changed web page silently reprice
 * every report.
 *
 * All I/O is injected (`fetchPage`, `out`, `err`, `today`) so the whole flow is
 * testable without a network or a real ~/.claude.
 */
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
export function localPricingPath(claudeDir) {
    return join(claudeDir, 'ccalyze', 'prices.json');
}
/** The real fetch, bounded so a hung connection cannot hang the CLI. */
export async function fetchPricingPage() {
    const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok)
        throw new Error(`fetching ${PRICING_URL} failed: HTTP ${res.status}`);
    return res.text();
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
/**
 * Read the local price file. Missing is normal (undefined); anything wrong
 * throws an Error naming the problem, and the caller falls back to built-in
 * prices with a warning — a bad file must never take a report down, but it must
 * never be silently half-trusted either.
 */
export function loadLocalPricing(path) {
    if (!existsSync(path))
        return undefined;
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (e) {
        throw new Error(`not valid JSON (${e.message})`);
    }
    const file = raw;
    if (!file || typeof file !== 'object')
        throw new Error('top level is not an object');
    if (typeof file.verifiedOn !== 'string' || !DATE_RE.test(file.verifiedOn)) {
        throw new Error('"verifiedOn" is not a YYYY-MM-DD date');
    }
    const models = file.models;
    if (!models || typeof models !== 'object' || Array.isArray(models))
        throw new Error('"models" is not an object');
    for (const [id, price] of Object.entries(models)) {
        for (const field of FIELDS) {
            const v = price?.[field];
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
                throw new Error(`model "${id}" has no finite positive "${field}"`);
            }
        }
    }
    return {
        verifiedOn: file.verifiedOn,
        source: typeof file.source === 'string' ? file.source : '',
        models: models,
    };
}
/** Cache rates are derived by multiplication, so compare with a tolerance, not ===. */
const same = (a, b) => Math.abs(a - b) < 1e-9;
/** What `next` changes about `current`. Models only in `current` are not reported: absence from the page is not a price. */
export function diffPricing(current, next) {
    const diff = { changed: [], added: [] };
    for (const [id, price] of Object.entries(next)) {
        const old = current[id];
        if (!old) {
            diff.added.push(id);
            continue;
        }
        const fields = FIELDS.filter((f) => !same(old[f], price[f])).map((field) => ({
            field,
            from: old[field],
            to: price[field],
        }));
        if (fields.length)
            diff.changed.push({ id, fields });
    }
    return diff;
}
const TIERED_REASON = 'priced by prompt size; ccalyze has one flat rate per model, so left unpriced and flagged as unknown';
const RETIRED_REASON = 'retired; not priced';
function printReport(parsed, diff, out) {
    if (!diff.changed.length && !diff.added.length)
        out('No price changes.');
    for (const c of diff.changed) {
        out(`changed  ${c.id}: ${c.fields.map((f) => `${f.field} ${f.from} -> ${f.to}`).join(', ')}`);
    }
    for (const id of diff.added)
        out(`added    ${id}`);
    for (const id of parsed.tiered)
        out(`tiered   ${id}: ${TIERED_REASON}`);
    for (const id of parsed.retired)
        out(`retired  ${id}: ${RETIRED_REASON}`);
}
/**
 * Fetch, parse, show what changed, then write `prices.json`.
 *
 * Everything that can fail (fetch, parse) happens before the first byte is
 * written, and the write is temp-file + rename, so an existing file is never
 * left truncated or replaced by a half-understood page.
 *
 * @returns the process exit code
 */
export async function updatePrices(deps) {
    const { path, out, err } = deps;
    let parsed;
    try {
        parsed = parsePricingPage(await deps.fetchPage());
    }
    catch (e) {
        err(`ccalyze --update-prices failed: ${e.message}`);
        return 1;
    }
    let existing;
    try {
        existing = loadLocalPricing(path);
    }
    catch (e) {
        // An unreadable old file is about to be replaced by a good one; say so, don't refuse.
        out(`Existing ${path} is unusable (${e.message}); it will be replaced.`);
    }
    printReport(parsed, diffPricing(effectiveModels(existing), parsed.prices), out);
    const file = { verifiedOn: deps.today, source: PRICING_URL, models: parsed.prices };
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
        renameSync(tmp, path);
    }
    catch (e) {
        rmSync(tmp, { force: true });
        err(`ccalyze --update-prices could not write ${path}: ${e.message}`);
        return 1;
    }
    out(`Wrote ${path} (verified ${deps.today}).`);
    return 0;
}
/**
 * The repo-side drift check: the built-in table against the live page, ignoring
 * any local file (a developer's refreshed prices.json must not hide that the
 * shipped table is stale). Tiered and retired models are information only.
 *
 * @returns 1 if a price changed or a priceable model is missing, else 0
 */
export async function checkPrices(deps) {
    const { out, err } = deps;
    let parsed;
    try {
        parsed = parsePricingPage(await deps.fetchPage());
    }
    catch (e) {
        err(`ccalyze --check-prices failed: ${e.message}`);
        return 1;
    }
    const diff = diffPricing(MODEL_PRICING, parsed.prices);
    printReport(parsed, diff, out);
    const drifted = diff.changed.length > 0 || diff.added.length > 0;
    if (drifted)
        out('Built-in prices are out of date: update MODEL_PRICING and PRICES_VERIFIED in src/cost.ts.');
    return drifted ? 1 : 0;
}
//# sourceMappingURL=local-pricing.js.map