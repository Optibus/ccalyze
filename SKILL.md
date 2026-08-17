---
name: ccalyze
description: Analyze Claude Code usage patterns, cost, quota burn, and prompt-cache efficiency, and produce cost-aware behavioral insights about how you work. Use when user asks about token usage, costs, quota, spending, burn rate, rate limits, cache behaviour, wants usage insights, or wants to know how to improve how they use Claude Code. Triggers on: usage, cost, quota, spending, burn rate, tokens, ccalyze, insights, deep, insights fusion, how much did I use, why did I hit my limit, why was that so expensive, how do I improve my usage, what am I doing wrong, cache, cache hit rate, cache reads, cache misses, cache efficiency, why does my cache keep missing, cold start, context rebuild, why is my context being resent, does switching models cost me, is it cheaper to start a fresh session, why do I keep hitting my limit, did my habit change work, am I getting more efficient, compare this week to last week, habit tracking, --habits.
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

**When to use `--habits` instead.** Any *comparative* question — "why do I keep hitting the limit",
"did the change I made work", "am I getting more efficient" — is Step 5, not this step. A single
window cannot answer it, whatever range you pass. `--habits` replaces the range with a window
length and emits a different document (a two-window comparison, not a usage summary), so don't
combine it with the rendering in Steps 2-3.

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

### Step 5: Habit tracking over time (`--habits`)

Use `--habits` when the question is **"why do I keep hitting the limit?"** or **"did the habit I
changed actually work?"** — anything comparative, or any request for recommendations that should
be measurable later. Everything above describes one window; `--habits` compares two.

```bash
$CC --habits          # last 7 complete days vs. the 7 before them (default)
$CC 15d --habits      # 15 vs. 15
$CC 30d --habits      # 30 vs. 30
```

**Compare the usage against itself.** Not against a benchmark, not against someone else, and
never against output metrics like commits or PRs — those answer a different question with
different data. The two comparisons that work are *this period versus the last one* and *this
person's cheap sessions versus their expensive ones*. Both are in the output.

**The length is settable; the dates are not.** ccalyze picks them: the current window is the last
N **complete** days, ending yesterday, and the prior window is the N complete days immediately
before it. Never offer a date range and never accept one — `--habits 2026-03-01 2026-03-15` is
refused on purpose. Choosing endpoints after seeing the numbers is how a comparison turns into an
argument, and nothing downstream can detect it; choosing a *length* up front cannot do the same
damage, because both windows move together.

Pick the length from the question **before looking at any figure**, and say which you used:

| N | What it answers | Needs on disk |
|---|---|---|
| `7d` (default) | Did last week's habit change hold? Sharpest signal, noisiest sample. | 14 days |
| `15d` | Did it hold past one quiet week? | 30 days |
| `30d` | Is this a trend rather than a week? A mid-window change is averaged away. | 60 days |

**Needs** is `2 × N`, and it is the real ceiling on N — usually lower than people expect, because
ccalyze only sees transcripts still on disk. A window reaching back before the person's history
comes back the right length and nearly empty, and the deltas explode. ccalyze **refuses** that
pair (`lopsided coverage` / `window too sparse`, exit 1) and names a shorter length. Take the
advice; do not work around the refusal.

Two failure modes, opposite fixes — don't confuse them:

- **Sparse** (a window is mostly empty): N is too large for the history. Go **shorter**. This is
  the refusal above.
- **Noisy** (both windows well populated, but a row swings on a thin sample): the period was
  unrepresentative — a holiday week produces real numbers about an unreal week. Go **longer**.
  Below about `2 × N` sessions in a window, name the row, say the sample was thin, and offer the
  longer re-run instead of defending the figure.

Never re-run at several lengths and report the one that told the nicer story. Re-measure at the
**same** N as the run you are comparing against, or the comparison answers nothing.

For a first-ever run with less than `2 × N` days of history, add `--single-window`: the report
comes back with `prior: null` and `headline.finding: "single-window"`. Say plainly that habits are
being **described, not tracked**, until a second window exists.

Sharing options — check them *before* anything leaves the machine, because project labels are
**directory names** and routinely carry a customer name, a person's name, or a private side
project:

| Option | Why |
|---|---|
| `--alias OLD=NEW` | Rename one project label. Repeatable. |
| `--redact-projects` | Replace every label with `project-1`, `project-2`, … |
| `--unit NAME` | What to call the cost figure (default `units`). |
| `--top N` | Projects in the table (default 8). |

#### Reading the output

Check these in order. **The first that matches is the headline** — and `headline.finding` already
says which, so lead with it rather than re-deriving it:

**A. `volume`.** Consumption rose roughly in step with prompts, and per-prompt held flat or fell.
The extra usage is workload; there is no habit to fix. If a habit had degraded, consumption would
have grown *faster* than volume. Say this plainly — it is the most common result and people are
often braced for the opposite.

**B. `efficiency-regression`.** Per-prompt consumption rose while volume did not. Name the
specific flag from the scorecard, quantify it against the cheaper cohort or the cheaper project
(`levers`), say what to change.

**C. Efficient, and the ceiling is the constraint.** Sessions mostly unflagged, model use
selective, baseline lean, volume still high. **This is a real finding, not a consolation prize.**
The follow-up is asking for headroom, not more optimisation. Do not manufacture savings that are
not in the data.

`mixed` means no single explanation dominates — read the scorecard rather than forcing a headline.

The scorecard's verdicts are mechanical, and about a number rather than a person: a sub-5%
relative move reads `flat`, not `better`, because a scorecard that books noise as a win stops
being worth reading. `levers` sizes what is left — the model-mix ceiling assumes every
expensive-model prompt was avoidable, which it is not, so quote `realistic` (a third) as the band
worth aiming at.

**A flag is not a mark against anyone.** Several have perfectly good reasons — "13 hours because
I was tracing a data-corruption bug across three services" explains it completely. These are
tooling habits, which nobody is taught, and the expensive patterns are invisible from the inside
precisely because long sessions *feel* productive. Note the real reasons alongside the numbers.

`report.caveats` ships the reading notes that keep the figures honest — quote them, don't
paraphrase them:

- **The consumption figure is not money.** It is priced at published per-token API list rates,
  which is explicitly *not* what a subscription charges. Presenting it as spend to a manager is
  the single worst mistake available here: the number is large, it will dominate the
  conversation, and it is wrong.
- **Duration is wall clock**, so overnight and weekend idle counts. A "40-hour session" was not
  40 hours of work, and unlabelled it reads as either burnout or carelessness.
- **A high flagged share is normal** for sustained agentic work — the flags fire at 30 prompts and
  three hours. Read the direction, not the level.
- **`byDay` is start-dated**, so per-day figures are not daily effort. Don't chart it.
- **The per-request baseline is not in this data.** MCP tool definitions plus instruction files
  ride on every single request, and only `/context`, run from inside a session in the heaviest
  repo, converts them into a share of the window. It cannot be automated — ask for it. It is the
  one finding that can overturn everything else.

The re-measure is just running this again after N days: Step 1 always computes a fresh
current/prior pair, so the next run compares against the window just measured. It worked if the
flagged-session share dropped **and** per-prompt consumption moved toward the clean cohort. If
both hold and the limit still binds, that is finding C arriving the long way round.

#### Common mistakes

- **Presenting the consumption figure as money.** It is an API-list-rate proxy, not billed spend.
- **Concluding from totals.** Heavy work on a large codebase legitimately costs more; totals
  cannot distinguish that from a fixable habit.
- **Reaching for output metrics.** Commits, PRs and tickets answer a different question. A period
  that used more prompts on fewer merged PRs is not thereby wasteful.
- **Blaming cache reads.** A 90-99% cache-read share is healthy — it means the cache is working.
  A *low* share is the alarm. Someone will point at the huge cache-read number; it is not the cause.
- **Accepting a date range because someone offered one.** The knob is the *length*.
- **Treating a low-session period as a habit change.** A `7d` window can land on a quiet week.
- **Treating "efficient" as a failure to find something.** If the sessions are clean and the limit
  still binds, that *is* the finding.
- **Sharing without checking the project labels.** They are directory names.
- **Waiting until fully blocked.** Two weeks of data and an early conversation beats an emergency one.
