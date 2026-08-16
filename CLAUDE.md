# ccalyze

Claude Code usage analyzer. Parses ~/.claude/ data, outputs JSON summaries.

## Build & Test

- `npm run build` — compile TypeScript to build/
- `npm test` — run tests with Node test runner
- `npm run dev` — watch mode
- `npm run typecheck` — type-check src (excludes tests)
- `npm run typecheck:tests` — type-check the test files
- `npm run verify` — the full gate: typecheck + typecheck:tests + test
- `npm run bundle-skill` — build the self-contained skill bundle into skills/ccalyze/ (committed:
  plugin installs are plain git clones, so re-run and commit after changing src/ or SKILL.md)

`npm test` alone is a weaker gate than it looks: `tsconfig.json` excludes `*.test.ts`, and
`--experimental-strip-types` erases types without checking them, so a type-invalid test still
passes. Run `npm run verify` before claiming green.

## Architecture

- `src/types.ts` — all interfaces
- `src/cost.ts` — model pricing + cost math
- `src/parser.ts` — streaming JSONL parser (handles 100MB+ files)
- `src/discovery.ts` — finds transcripts (deduped by inode) and merges a session's files
- `src/aggregator.ts` — rolls up parsed data into output schema
- `src/anomalies.ts` — static anomaly rules
- `src/tips.ts` — recommendation generator
- `src/cli.ts` — entry point, arg parsing

## Key Parsing Detail

Session JSONL files have multiple entries per API request (streaming). Deduplicate by `requestId`, take max of each token field.

This dedup must hold at **two** scopes — within a file (`parser.ts`) and across the files merged
into one session (`discovery.ts`). Applying it only per-file overstated every number: `~/.claude/projects`
holds several slugs pointing at the same directory (worktree slugs symlinked to the git-root slug), so
one transcript is reachable through many paths. Discovery therefore dedupes by **device+inode, not by
path**. Measured before the fix: 14x on one session, 7.26x on a real 7-day total.
