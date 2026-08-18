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
- `src/habits.ts` — two-window habit comparison (`--habits`): window summary, scorecard, headline,
  savings levers, and the refusals that stop an uncomparable pair from being reported
- `src/prose.ts` — deterministic prose for the `--html` report: every sentence is a rule over the
  findings JSON, so no paragraph can quote a figure the tables do not have
- `src/report.ts` — renders the habits report as one self-contained HTML page (`--habits --html`)
- `src/cli.ts` — entry point, arg parsing, `analyzeRange()` (one window, shared by both modes)

## Two Modes, One Aggregation Path

A normal run measures one window. `--habits` measures two adjacent windows of complete days and
compares them, because totals cannot separate "more work" from "a worse habit". Both go through
`analyzeRange()` — a habit comparison is only as trustworthy as the two figures being identical in
derivation, so there must never be a second aggregation path.

The window arithmetic lives in `habits.ts` (`resolveHabitWindows`), not in `resolveDateRange`: a
habit window ends **yesterday** (the last complete day), while a normal range ends today. Those are
different contracts on purpose, and merging them would silently bias every delta.

`--html` renders that same report object and nothing else: the page embeds the JSON the run
printed and computes every tile, row and bar from it in the browser, and `prose.ts` only ever
quotes figures out of the same object. There is no second set of numbers to keep in step.

Nothing in `habits.ts` touches the filesystem — it is pure functions over `CcalyzeOutput`, so the
refusals and verdicts are testable without a transcript.

## Key Parsing Detail

Session JSONL files have multiple entries per API request (streaming). Deduplicate by `requestId`, take max of each token field.

This dedup must hold at **two** scopes — within a file (`parser.ts`) and across the files merged
into one session (`discovery.ts`). Applying it only per-file overstated every number: `~/.claude/projects`
holds several slugs pointing at the same directory (worktree slugs symlinked to the git-root slug), so
one transcript is reachable through many paths. Discovery therefore dedupes by **device+inode, not by
path**. Measured before the fix: 14x on one session, 7.26x on a real 7-day total.
