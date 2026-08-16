---
name: ccalyze
description: Analyze Claude Code usage patterns, cost, quota burn, and prompt-cache efficiency, and produce cost-aware behavioral insights about how you work. Use when user asks about token usage, costs, quota, spending, burn rate, rate limits, cache behaviour, wants usage insights, or wants to know how to improve how they use Claude Code. Triggers on: usage, cost, quota, spending, burn rate, tokens, ccalyze, insights, deep, insights fusion, how much did I use, why did I hit my limit, why was that so expensive, how do I improve my usage, what am I doing wrong, cache, cache hit rate, cache reads, cache misses, cache efficiency, why does my cache keep missing, cold start, context rebuild, why is my context being resent, does switching models cost me, is it cheaper to start a fresh session.
---

# ccalyze — Claude Code Usage Analyzer

Analyzes `~/.claude/` data to surface usage insights, anomaly detection, and optimization tips.

## How to Use

### Step 0: Locate the CLI

ccalyze runs either from a linked install or from the copy bundled with this skill. Resolve it
once, then use `$CC` everywhere below:

```bash
CC=$(command -v ccalyze 2>/dev/null) || CC=""
if [ -z "$CC" ]; then
  # Candidates in priority order; the cache glob is mtime-sorted (ls -1t) because
  # old plugin versions linger in the cache after an update — newest install wins.
  for c in \
    ${CLAUDE_PLUGIN_ROOT:+"$CLAUDE_PLUGIN_ROOT/skills/ccalyze/bin/cli.js"} \
    $(ls -1t ~/.claude/plugins/cache/*/ccalyze/*/skills/ccalyze/bin/cli.js 2>/dev/null) \
    $(ls -1t ~/.claude/plugins/marketplaces/*/skills/ccalyze/bin/cli.js 2>/dev/null) \
    ~/.claude/skills/*ccalyze*/bin/cli.js \
    ~/.agents/skills/*ccalyze*/bin/cli.js \
    .claude/skills/*ccalyze*/bin/cli.js; do
    [ -f "$c" ] && CC="node $c" && break
  done
fi
echo "${CC:-NOT-FOUND}"
```

The bundled copy is **self-contained**: plain JavaScript, zero dependencies, no install, no clone.
If you have Node, it runs. Only if the resolver prints `NOT-FOUND` tell the user:

> ccalyze not found. Install the plugin (`/plugin marketplace add Optibus/ccalyze`, then
> `/plugin install ccalyze@ccalyze`), or install from source:
> ```bash
> git clone https://github.com/Optibus/ccalyze.git && cd ccalyze && npm install && npm run build && npm link
> ```

A bundled copy updates only when the plugin does. If the user suspects stale results, compare
`$CC --version` against the latest published version (the `version` in
https://github.com/Optibus/ccalyze/blob/main/package.json, or what `/plugin` reports) and
suggest a plugin update if it lags.

### Step 1: Run the CLI

Run ccalyze with the user's requested time range (`$CC` from Step 0):

```bash
$CC --json                          # default: last 7 days
$CC today --json                    # today only
$CC 30d --json                      # last 30 days
$CC 2026-03-01 2026-03-15 --json   # custom range
```

**When to add `--deep`.** Add it whenever the user's request includes any of: `--deep`, "deep",
"insights", "fusion", "behavioral", "what am I doing wrong", "how do I improve", "why was it so
expensive", or asks for recommendations rather than just numbers. Combine freely with any range:

```bash
$CC --json --deep                   # last 7 days + deep index
$CC today --json --deep             # today + deep index
$CC 30d --json --deep               # last 30 days + deep index
```

`--deep` only *adds* a top-level `deep` object; everything in Steps 2-3 renders the same. It is
strictly additive, so when in doubt on an open-ended question ("how's my usage?"), prefer `--deep` —
the cost is one extra object in the JSON, and it unlocks Step 4.

### Step 2: Render the output

Parse the JSON output and render as markdown:

1. **Summary line**: "**$X.XX at model list price** across N sessions (M prompts)" + comparison to
   average if multi-day data available. Say *list price*, not "spent": these are raw per-token model
   rates, NOT what a Claude subscription actually charges. On a subscription plan, read them as
   relative weight / quota burn, not money out of pocket — and say so if the user seems to read them
   as a bill.
2. **Cache efficiency line**: `summary.cacheReadRatio` as a percentage — always show it, healthy or
   not. It is the single best predictor of how far a subscription stretches: the API is stateless,
   so every turn resends the whole conversation, and a cache read costs a tenth of fresh input and
   burns quota at that same discount. Healthy usage runs **90-99%**; below 90% is where the real
   money is. Also worth a mention when relevant: `summary.sidechainTokenShare`, the share of tokens
   that ran inside subagents — those are read in a clean context and thrown away, so they never
   get re-sent on later turns. A high share is a *good* sign, not a cost warning.
3. **Anomaly alerts**: If anomalies exist, show them prominently with severity indicators
4. **Cost by Model table**: Model | Cost | % of total
5. **Top Sessions table**: Name | Project | Cost | Cache % | Duration | Prompts | Flags.
   Prefer `session.name` (derived from the user's opening prompt) over the raw id — fall back to
   the id's first 8 chars when `name` is empty.
6. **Cost by Project table**: Project | Cost | Sessions
7. **Daily breakdown** (if multi-day): Date | Cost | Sessions | Prompts
8. **Tips section**: Actionable recommendations

### Step 3: Terminal Visualizer (optional)

Check if terminal-visualizer is available:

```bash
which terminal-visualizer >/dev/null 2>&1 && echo "available" || echo "not-found"
```

If **not found**, add at the end:
> *Tip: Install [terminal-visualizer](https://github.com/gocodeweb/terminal-visualizer) for graphical charts in your terminal.*

If **available**, render charts based on the time range:

**For "today":** Bar chart of cost by session/project:
```bash
terminal-visualizer <<'EOF'
{
  "type": "bar-chart",
  "title": "Cost by Session (Today)",
  "data": [
    { "label": "<session-id>: <project>", "value": <costUSD>, "color": "coral" }
  ]
}
EOF
```

**For 7+ days:** Stacked bar chart of daily cost by model:
```bash
terminal-visualizer <<'EOF'
{
  "type": "stacked-bar-chart",
  "title": "Daily Cost by Model",
  "categories": ["2026-03-23", "2026-03-24", ...],
  "segments": [
    { "name": "Opus", "values": [12.5, 8.3, ...], "color": "coral" },
    { "name": "Sonnet", "values": [1.2, 0.5, ...], "color": "teal" },
    { "name": "Haiku", "values": [0.1, 0.2, ...], "color": "purple" }
  ]
}
EOF
```

### Step 4: Deep analysis & insights fusion (if --deep)

When `--deep` is used the JSON output gains a top-level `deep` object: a per-session,
cost-sorted index. Each `deep.sessions[]` entry carries the behavioral hooks you need:

- `transcripts` — `[{ dir, files[] }]`, the transcript file(s) to read for behavioral analysis,
  grouped by directory (a session with many subagents repeats one directory, so it is stated once).
  Build a full path with `` `${dir}/${file}` `` for each entry.
- `promptDisplays[]` — what the user actually typed (prompts + slash-commands), chronological
  (max 150 per session — `promptDisplaysTruncated` tells you if there were more; individual
  prompts over 1500 chars end in `…[truncated]`)
- `modelTimeline[]` — model switches within the session
- `modelSwitchCount` — how many times the model changed in the session's message stream; a cheap
  churn signal you can rank on **without** reading a transcript. Note this counts **all** model
  changes, including subagent and background calls — not just the user running `/model`. A high
  count usually means heavy subagent delegation; treat it as "where to look", then confirm the
  cause in `modelTimeline`/the transcript before calling it friction.
- `mainModelSwitchCount` — the same count over the **main thread only** (subagent messages
  excluded). This is the one with a cost story attached: the prompt cache is keyed to the model,
  so a mid-session switch on the main thread discards the cached conversation and pays to rebuild
  it. Real sessions sit at 0-5, so anything higher is worth explaining. Prefer this over
  `modelSwitchCount` when making a claim about wasted spend.
- `name` — the session's derived label (first prompt the user typed). Use it when referring to a
  session in prose; it reads far better than an id.
- `costUSD`, `durationMinutes`, `prompts`, `flags` — the exact numbers ccalyze already computed

**Two modes, depending on what the user asked for:**

With `--deep` the `anomalies`/`tips` also gain a `high_model_churn` entry for expensive sessions that
switched models repeatedly **on the main thread** — each switch threw away the cached conversation
and paid to rebuild it.

Two cache-related anomalies are emitted on every run, `--deep` or not, and both are usually the
highest-value thing in the report:

- `low_cache_efficiency` — an expensive session that served under 90% of its input from cache.
- `cache_cold_start` — a session that repeatedly sat idle past the ~1h cache TTL and then rebuilt
  its whole context at the write rate. `session.coldStartExtraUSD` is the premium over a warm
  cache, so you can state the waste as a number. Summed across sessions this is routinely
  10-15% of a week's total, which usually surprises the user — lead with it when it is large.

**(a) Contextual recommendations** (lightweight — from the index alone, no transcript reads):
- "Your demo-webapp session pattern suggests worktrees + fresh sessions per subtask"
- "You switched to /model haiku mid-session for issue-1234-plan — doing that from the start would've saved ~$X"
- "Peak usage is 11am-3pm — batch exploration tasks to Haiku in that window"

**(b) Insights-fusion report** (when the user wants an `/insights`-style read, or says "insights"):
This is ccalyze's edge over the native `/insights` command. Native `/insights` produces a rich
BEHAVIORAL narrative but has ZERO cost precision; ccalyze has exact costs but no behavioral read.
Fuse them:
1. For the top cost-sorted sessions (and any with friction-ish flags or a high `modelSwitchCount`),
   READ the transcript(s) from `transcripts` (each group's `` `${dir}/${file}` ``) — trace what the
   user worked on, where things went wrong (interruptions, retries, corrections), and the outcome.
2. Produce an `/insights`-style report — *What you work on · How you use Claude Code · Friction ·
   Patterns · Suggestions* — but **fused with the cost data**, surfacing what native `/insights`
   cannot: **cost-aware behavioral insights**, e.g.:
   - "Your highest-friction sessions (lots of corrections) are also your priciest Opus burn — $X"
   - "The workflow you ran most smoothly was also your cheapest — worth templating"
   - "no-compaction + long-running sessions cost you $Y this week; a mid-session /compact habit pays back fast"
   - "Your cache ratio is fine at 96%, but $Z of the week went on cold rebuilds — the cost is not
     how you work, it is coming back to stale sessions"
3. Keep it honest and specific — tie every claim to a session id + its real cost/flags, not vibes.

Guardrail: only read as many transcripts as the question needs (start with the top ~5 by cost).
`transcripts` can point at 100MB+ files, and a session that used subagents heavily may list
hundreds of them — target the reads rather than slurping everything.
