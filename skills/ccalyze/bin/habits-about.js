/**
 * Plain-language explanations for each scorecard row, shown in a collapsible under
 * the measure's name. Paragraphs are separated by a blank line.
 *
 * These describe what the measure means in someone's working day and what ccalyze
 * actually counts. Where the data cannot answer a "why" (rework, cold starts), the
 * text says so and points at how to check, rather than guessing at a cause.
 */
export const ABOUT = {
    longPremium: [
        'What one agent step costs in a session that ran 3 hours or more, divided by what it costs in a session under 1 hour. A 2 means the same step is twice as dear once the session is long.',
        'Every step resends the whole conversation, so the longer it runs, the more each step carries. This is the number that shows how much a long session costs you, in the same units as everything else here. It needs 30 steps on each side, otherwise it stays empty.',
        'What helps: /compact at a natural break, or a fresh session with a short summary, before the conversation gets heavy.',
    ].join('\n\n'),
    reread: [
        'How many tokens were read back from the cache for every token Claude wrote. Claude writes a little and re-reads a lot, because each step resends the conversation.',
        'It is not the same as the cache-read share below. That one says whether the cache is hitting. This one says how heavy the cached conversation has become. A heavy session can hit the cache every time and still burn a lot.',
        'Lower means lighter context for the same output. There is no fixed target: read the direction across the two windows.',
    ].join('\n\n'),
    coldShare: [
        'Claude keeps your conversation in a cache for about an hour. If a session sits idle for more than 60 minutes and you then send a message, the whole conversation is sent again and re-cached at the write price (1.25x input) instead of the read price (0.1x input). The premium is the difference: money paid only because the cache went cold.',
        'ccalyze counts a cold start when a gap over 60 minutes is followed by a rebuild of at least 20,000 tokens.',
        'Your picture is close. The common cause is: you send a prompt, the agent stops (it finished, or asked a question), you leave for a meeting or the end of the day, and you come back after an hour. The cost is for the idle gap, not for the agent being stuck. An agent that keeps working never goes cold, because it keeps sending requests.',
        'What helps: give tasks a clear "done" definition and enough permission so the agent can run to the end instead of stopping to ask. Plan your day so a big session is finished or handed off before a long break. When you return after a long gap, start a fresh session with a short summary instead of resuming a huge one.',
    ].join('\n\n'),
    top3: [
        'The share of the window\'s consumption that came from your three most expensive sessions.',
        'A high share means the week was dominated by a few sessions. A sudden jump is a signal to open those sessions and see what happened in them.',
    ].join('\n\n'),
    offHours: [
        'The share of consumption that happened at night or on the weekend, by the clock of the machine that ran ccalyze.',
        'This is a burnout signal, not a cost signal. A rising share across two windows is worth noticing even when the cost went down.',
    ].join('\n\n'),
    cacheRead: [
        'Of all the input tokens Claude read, the share that came from the cache at one tenth of the normal price. Every turn resends the whole conversation, so a healthy session reads most of it from cache.',
        '90% or more is healthy. A low share means the context is being rebuilt often, for example after idle gaps or after switching models mid-session. A high number is not a problem: it means the cache is working.',
    ].join('\n\n'),
    subagent: [
        'The share of input tokens that ran inside subagents. A subagent reads in a clean, separate context and is then thrown away, so its tokens are never resent on later turns of your main conversation.',
        'Higher is usually cheaper for the same work. It is not a target to maximise: some work needs your main context.',
    ].join('\n\n'),
    noCompact: [
        'The share of sessions that reached 30 or more prompts and were never compacted, neither by you with /compact nor automatically.',
        'What "large" means: ccalyze does not measure session size in tokens. It uses 30 prompts as the signal, because every prompt and tool result adds to the conversation that is resent on every turn. The real size depends on the model\'s context window, which ccalyze cannot see: standard Opus, Sonnet and Haiku sessions have a 200K-token window, and the 1M variants have 1M tokens. A 1M session can grow five times larger before it hits any wall, but each turn still resends everything it holds, so cost per turn keeps rising either way.',
        'To see the real size of a session, run /context inside it. A /compact at a natural break, such as after finishing a subtask, keeps the context small and the cache cheap.',
    ].join('\n\n'),
    autoCompact: [
        'The share of sessions where Claude Code compacted the conversation by itself because the context window was full. This is "hitting the wall".',
        'Why that is "too late": by the time the wall is reached, every turn has already been carrying a nearly full context for a long stretch, which is the expensive part. The automatic summary also happens at a moment you did not choose, so it can drop detail you still needed. A /compact you run earlier lets you decide what to keep.',
        'Where the wall is depends on the model: about 200K tokens for standard Opus, Sonnet and Haiku sessions, and about 1M for the 1M variants. ccalyze only sees that an auto-compaction happened, not which window you were using. Run /context to see how full a session is.',
    ].join('\n\n'),
    rework: [
        'The share of sessions where the agent edited a file that it had already edited earlier in the same session.',
        'The data cannot tell you why. It can be healthy: you saw the first version and refined it. It can be the agent being unsure and trying things. It can also be you changing the instruction after the agent already built the first version.',
        'To find out, open one high-rework session and look at what came before each repeat edit. A new instruction from you means the instructions moved. A failing test or error with nothing from you means the agent was feeling its way. A "no" or "revert" from you means a misunderstanding. Read it beside the corrections and interrupts rows below. One window means little; a rising share across two windows means more.',
    ].join('\n\n'),
    flagged: [
        'A session gets a behavioural flag when it shows a pattern that tends to be expensive: 30 or more prompts with no compaction, running more than 3 hours, a transcript over 50 MB, or a session cost over 10 (list price).',
        'This row is the share of consumption (not the share of sessions) that happened inside flagged sessions. The flags fire easily on long agentic work, so a high share is normal and says little by itself. Watch whether it moves down across windows, and compare against the unflagged sessions, which act as your cheap baseline.',
        'The target of under 40% is the level the re-measure aims for.',
    ].join('\n\n'),
    topModel: [
        'The share of consumption that ran on the most expensive model in the window, for example Opus.',
        'Nothing is wrong with a high share if the work needs that model. The question to ask is whether planning, exploration, review or simple edits ran on it by default.',
    ].join('\n\n'),
    turns: [
        'On average, how many agent steps one instruction you typed set off.',
        'More steps can mean the agent did more work for you, or that it ran in a loop. That is why this row has no direction: read it beside corrections and interrupts.',
    ].join('\n\n'),
    perInstruction: [
        'Consumption divided by the instructions you typed. This is the cost of one thing you asked for, whatever number of steps it took.',
        'Lower means each request cost less. It is the fairest single cost number here because it does not reward sending more prompts.',
    ].join('\n\n'),
    corrections: [
        'The share of your instructions that corrected the previous turn, detected from the opening words ("no", "revert", "still failing"). English only.',
        'Each one is a redo. A low share means instructions land the first time. Read the trend, not the exact number.',
    ].join('\n\n'),
    interrupts: [
        'How many times per 100 instructions you stopped the agent mid-way.',
        'An interrupt usually means the agent went in a direction you did not want. Fewer is better.',
    ].join('\n\n'),
    toolErrors: [
        'The share of tool calls that returned an error. Denied permissions and tests that fail on purpose count too, so it never reaches exactly 0.',
        'A rising share can mean the agent is guessing at commands or paths. Read the direction, not the level.',
    ].join('\n\n'),
    limitStops: [
        'How many times Claude Code stopped because a usage limit ran out (the five-hour window or the weekly cap).',
        'This is where quota loss turns into lost time: the work halts until the limit resets. Any number above zero is worth tracing back to the sessions that burned the window, using the rows above.',
    ].join('\n\n'),
};
//# sourceMappingURL=habits-about.js.map