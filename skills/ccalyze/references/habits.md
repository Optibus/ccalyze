# Habit tracking over time (`--habits`)

Read this file only when Step 5 of `SKILL.md` sends you here — a comparative question
("why do I keep hitting the limit?", "did the habit I changed actually work?", "am I
getting more efficient?"). Everything in Steps 1-4 describes one window; `--habits`
compares two, and needs this much more detail to use correctly.

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
| `--weekend DAYS` | Which days the off-hours row counts as the weekend, e.g. `fri,sat` (default `sat,sun`; `none` for a weekend-free week). |

The weekend default is *stated, not detected*. Node exposes no weekend-per-region
data here, and the machine locale is not a stand-in — an `en-US` locale on an
`Asia/Jerusalem` clock is ordinary. Left unset on a Sun-Thu week, the off-hours
row files every Sunday as off-hours and misses Friday entirely, so pass
`--weekend fri,sat`. The caveat block names whichever weekend was actually used.

## The report page, and publishing it

**Every `--habits` run writes the page. Publishing it as an Artifact is the default finish — not an
extra someone has to ask for.** A person who asks why they keep hitting the limit wants a link they
can read and forward, and the answer they should get back is that link plus a sentence, never a
wall of JSON in the chat.

The page lands in `~/.claude/ccalyze/habits-FROM_TO.html` unless `--html PATH` says otherwise, and
stdout stays JSON, so one run produces both forms:

```bash
$CC --habits 7d > ~/findings.json     # page path is printed on stderr
```

`--no-html` skips the page. Use it only when nothing will be read by a human — a scripted
collection, a size check, a pipeline. Not for a person asking a question.

The page is generated, not composed: the conclusion paragraph, the three recommendations, the
figure captions and the re-measure targets are all derived from the same JSON the run printed, by
fixed rules (top lever, the rows reading `much better`, the max/min of `byDuration`/`byModel`/
`byProject`). **Do not rewrite them, and never add a figure of your own** — every number in the
prose is already in the JSON, which is the only reason the paragraphs cannot contradict the tables.
Two runs on the same data produce the same page.

Structure is fixed and deliberate: conclusion, recommendations, scorecard, figures, reading notes.
Someone deciding whether to grant headroom reads the first screen and stops, so charts never come
before the conclusion.

Then publish it, every time:

1. **Read the file** before it leaves the machine, and check the project labels — they are
   directory names. Re-run with `--alias OLD=NEW` or `--redact-projects` if any of them names a
   customer, a person, or a private side project. Both flags apply to the page.
2. **Publish with the Artifact tool**, passing that file path, a one-sentence `description`, and a
   `favicon`. The page is written for exactly this: no `<!doctype>`, `<html>` or `<body>` of its
   own, nothing loaded from another host, and it themes itself to the viewer's light/dark setting.
3. **Reply with the link and one line of context** — which window, which finding, and what the
   person is already changing. The page leads with the conclusion, which is what a reader needs.
   Do not re-narrate the report underneath it; the link is the deliverable.

Only skip the publish when the person asked for the raw data, or asked not to publish.

The CLI writes files; only Claude Code can publish an Artifact. That split is permanent — a
standalone Node binary has no way to call the tool — so the run plus this step is the whole flow,
and the page is complete and readable straight from disk when someone runs the CLI in a terminal
with no agent around to publish it.

For a re-analysis by someone who will re-run the numbers themselves, send the JSON instead. The
page is for reading; the JSON is for computing.

## Reading the output

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

Four rows beyond consumption/cache/cold-start/model-mix, each with its own honesty caveat below —
read the row's direction across the two windows, not its level in one:

- **Off-hours share** (nights + weekends) — a burnout signal, not a cost one. Reads the local
  clock of the machine that ran ccalyze, so it is only honest when that is also the machine/time
  zone the work happened on.
- **Subagent delegation share** — the inverse polarity of most rows: *rising* is good. Delegated
  work is read once in a clean context and never rejoins the window that gets resent every turn.
- **Auto-compacted share** — sessions that hit Claude Code's own context wall rather than choosing
  to `/compact`. Read it alongside no-compact share, not instead of it: a session that auto-
  compacted did not go unmanaged, it ran out of room before anyone acted.
- **Repeated same-file edit share** — cannot tell deliberate iteration from thrashing on its own;
  the level in one window means little, a rising share across two means more.

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
- **Off-hours reads the local clock** of the machine that ran ccalyze — only honest when it is
  the same machine/time zone the work happened on.
- **Auto-compaction needs a recent-enough transcript** to carry the field at all; older ones read
  as 0, same as a session that never filled up.
- **Rework only counts Edit/Write/MultiEdit tool calls** on a file already touched this session —
  it cannot tell iteration from thrashing by itself.
- **The per-request baseline is not in this data.** MCP tool definitions plus instruction files
  ride on every single request, and only `/context`, run from inside a session in the heaviest
  repo, converts them into a share of the window. It cannot be automated — ask for it. It is the
  one finding that can overturn everything else.

The re-measure is just running this again after N days: Step 1 always computes a fresh
current/prior pair, so the next run compares against the window just measured. It worked if the
flagged-session share dropped **and** per-prompt consumption moved toward the clean cohort. If
both hold and the limit still binds, that is finding C arriving the long way round.

## Common mistakes

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
- **Judging rework or off-hours share from a single window.** Neither is a verdict on its own —
  read the direction across two windows.
