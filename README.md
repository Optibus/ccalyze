# ccalyze

Claude Code usage analyzer. Parses your local `~/.claude/` data to show costs, cache efficiency, anomalies, and optimization tips — and, with `--deep`, cost-aware behavioral insights about how you actually work.

Zero runtime dependencies. Reads local files only, never modifies them, never phones home.

## Install as a Claude Code plugin (recommended)

This repo is its own plugin marketplace. In Claude Code:

```
/plugin marketplace add Optibus/ccalyze
/plugin install ccalyze@ccalyze
```

That's it — the plugin ships a pre-built, dependency-free JS bundle, so there is no
clone/npm/build step. You get:

- **The `ccalyze` skill** — ask Claude "analyze my usage", "why did I hit my limit?",
  "how's my cache hit rate?", or say "insights" for the deep behavioral report.
- **`/ccalyze:install-cli`** — optional: puts the bundled `ccalyze` command on your PATH
  (a symlink into the plugin, no npm needed) so you can run it outside Claude Code too.

## Install from source (alternative)

```bash
git clone https://github.com/Optibus/ccalyze.git
cd ccalyze
npm install
npm run build
npm link
```

To also register the skill (so Claude Code answers "analyze my usage" without the plugin):

```bash
mkdir -p ~/.claude/skills
ln -sf "$(pwd)" ~/.claude/skills/ccalyze
```

## CLI Usage

```bash
ccalyze                              # last 7 days
ccalyze today                        # today only
ccalyze 30d                          # last 30 days
ccalyze 2026-03-01 2026-03-15       # custom date range
ccalyze today --json                 # raw JSON output
ccalyze --deep                       # add the per-session behavioral index (see below)
```

## What It Shows

- **Cost breakdown** by model, project, and day — at model *list price*. On a subscription
  plan read the dollars as relative weight / quota burn, not money out of pocket.
- **Session details** with a name derived from your opening prompt, plus duration, prompt count, and transcript size
- **Cache efficiency** — `cacheReadRatio`, the share of input-side tokens served from cache.
  The API is stateless, so every turn resends the whole conversation; a cache read costs a tenth
  of fresh input and, on a subscription, burns quota at that same discount. Two people doing
  identical work can burn very different amounts of plan on this one number. Healthy usage runs
  90-99%.
- **Cold-start detection** — times a session sat idle past the cache TTL and then rebuilt its whole
  context at the write rate, priced as the premium over what a warm cache would have cost. This is
  the turn that looks like a small question and is often the most expensive one of the day.
- **Anomaly detection**: sessions without `/compact`, long-running sessions, concurrent Opus usage,
  cost spikes, poorly-cached expensive sessions, repeated cold rebuilds, and (with `--deep`)
  main-thread model churn in expensive sessions
- **Optimization tips** based on detected patterns

## `--deep`: insights fusion

`--deep` adds a top-level `deep` object to the JSON: a per-session, cost-sorted behavioral
index — transcript paths, the prompts you actually typed, a model-switch timeline, and both
all-inclusive and main-thread-only switch counts (main-thread switches discard the prompt
cache and pay to rebuild it, so they carry a real cost story).

That index is what powers the skill's **insights-fusion report**: Claude Code's native
`/insights` command produces a rich behavioral narrative but has zero cost precision;
ccalyze has exact costs but no behavioral read. With `--deep`, the skill fuses them into an
`/insights`-style report — *what you work on · how you use Claude Code · friction · patterns ·
suggestions* — where every claim is tied to a session and its real cost:

- "Your highest-friction sessions (lots of corrections) are also your priciest Opus burn — $X"
- "Your cache ratio is fine at 96%, but $Z of the week went on cold rebuilds — the cost isn't
  how you work, it's coming back to stale sessions"

Just ask Claude for "usage insights" (or run `ccalyze --deep --json` yourself). See
`SKILL.md` → "Deep analysis & insights fusion" for the full contract.

## Optional: Terminal Visualizer

Install [terminal-visualizer](https://github.com/gocodeweb/terminal-visualizer) for graphical charts in your terminal. ccalyze works without it (falls back to markdown tables).

## How It Works

ccalyze reads these files from `~/.claude/` (never modifies them):

- `history.jsonl` — prompt history with timestamps and session IDs
- `projects/*/*.jsonl` — session transcripts with per-message token usage
- `projects/*/subagents/*.jsonl` — subagent transcripts

It stream-parses the JSONL files (handling 100MB+ transcripts), deduplicates streaming updates by `requestId`, computes costs using published model pricing, and outputs a compact JSON summary.

## Development

```bash
npm run verify        # typecheck (src + tests) + tests — the full gate
npm run bundle-skill  # rebuild the committed skill bundle in skills/ccalyze/
```

The plugin ships the compiled bundle in `skills/ccalyze/` (plugin installs are plain git
clones with no build step), so re-run `bundle-skill` and commit the result after changing
`src/` or `SKILL.md`.

## License

[MIT](LICENSE)
