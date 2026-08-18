/**
 * Render the habit report as one self-contained HTML page.
 *
 * The page is the same artifact the `ccalyze-recommendations` skill used to build
 * by hand: conclusion first, then recommendations, then the figures, then the
 * evidence, then the caveats. Someone deciding whether to grant more quota reads
 * the first screen and stops, so charts never come before the conclusion.
 *
 * Two rules the layout depends on, both load-bearing rather than cosmetic:
 *
 * - **Every number renders from the embedded findings JSON**, client-side, from
 *   the same object the CLI printed to stdout. Prose comes from `prose.ts`, which
 *   only ever quotes figures that are in that JSON. Neither side can drift.
 * - **No wide row holds a lone paragraph.** The container is 1120px and prose caps
 *   at 66ch, so an unpaired paragraph leaves a dead band down the right side and
 *   the page reads as padded. Each wide row is paired: conclusion beside the stat
 *   tiles, each recommendation beside its evidence column, the two charts two-up,
 *   the re-measure command beside its targets, the reading notes three across.
 *
 * The document deliberately omits `<!doctype>`, `<html>` and `<body>`: browsers
 * render it as-is from disk, and the Artifact tool wraps exactly this shape when
 * the page is published to claude.ai. Fonts are a system stack — the brand face
 * would have to be embedded as a base64 payload in every generated file, which is
 * not worth ~120KB per report for an internal read.
 */

import { buildProse, type ProseRecommendation } from './prose.ts';
import type { HabitsReport } from './types.ts';

export interface RenderOptions {
  /** `YYYY-MM-DD` the re-measure date counts from. Defaults to the clock. */
  today?: string;
}

/** Escape text for HTML text content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Embed the findings as JSON that cannot terminate the script that holds it.
 *
 * `</script` inside a `<script>` block ends the element wherever it appears, even
 * inside a string — a project directory called `</script>` would otherwise turn
 * the rest of the report into markup. Escaping every `<` is the blunt fix, and
 * `JSON.parse` reads `<` back as `<` unchanged.
 */
export function embedFindings(report: HabitsReport): string {
  return JSON.stringify(report, null, 2).replace(/</g, '\\u003c');
}

function recommendationHtml(rec: ProseRecommendation): string {
  return `    <div class="rec">
      <span class="rank">${rec.rank}</span>
      <div class="txt">
        <h3>${escapeHtml(rec.title)}</h3>
        <p>${escapeHtml(rec.body)}</p>
      </div>
      <div class="ev">${rec.evidence.map((line) => escapeHtml(line)).join('<br>')}</div>
      <div class="size"><b>${escapeHtml(rec.size)}</b><span>${escapeHtml(rec.sizeLabel)}</span></div>
    </div>`;
}

/** The whole page, as a string, from one findings object. */
export function renderHabitsHtml(report: HabitsReport, options: RenderOptions = {}): string {
  const prose = buildProse(report, { today: options.today });

  return `<title>${escapeHtml(prose.title)}</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* Optibus brand tokens — window A / window B is a validated pair. */
  :root {
    --a:#396DFF; --b:#FF2C95;
    --bg:#FAFBFF; --panel:#FFFFFF; --panel-2:#F1F5FF;
    --ink:#171717; --ink-2:#3F4763; --ink-3:#7A82A0;
    --rule:#DCE4FA; --rule-2:#EDF1FE; --brand:#2D1DA3;
    --better:#2D1DA3; --worse:#FF2C95; --flat:#7A82A0; --watch:#FFA015;
    --font:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --s1:.3rem; --s2:.55rem; --s3:.9rem; --s4:1.25rem; --s5:1.8rem; --s6:2.4rem;
  }
  @media (prefers-color-scheme:dark){:root{
    --a:#5C86FF; --b:#F53F94; --bg:#271066; --panel:#311878; --panel-2:#3A2089;
    --ink:#FFF; --ink-2:#D3DAFF; --ink-3:#A79DE6; --rule:#4B2F9E; --rule-2:#402888;
    --brand:#CDDBFF; --better:#8FB0FF; --worse:#F53F94; --flat:#A79DE6; --watch:#FFA941;}}
  :root[data-theme="dark"]{
    --a:#5C86FF; --b:#F53F94; --bg:#271066; --panel:#311878; --panel-2:#3A2089;
    --ink:#FFF; --ink-2:#D3DAFF; --ink-3:#A79DE6; --rule:#4B2F9E; --rule-2:#402888;
    --brand:#CDDBFF; --better:#8FB0FF; --worse:#F53F94; --flat:#A79DE6; --watch:#FFA941;}
  :root[data-theme="light"]{
    --a:#396DFF; --b:#FF2C95; --bg:#FAFBFF; --panel:#FFF; --panel-2:#F1F5FF;
    --ink:#171717; --ink-2:#3F4763; --ink-3:#7A82A0; --rule:#DCE4FA; --rule-2:#EDF1FE;
    --brand:#2D1DA3; --better:#2D1DA3; --worse:#FF2C95; --flat:#7A82A0; --watch:#FFA015;}

  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font-family:var(--font);font-size:15.5px;line-height:1.52;margin:0;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:var(--s5) var(--s3) var(--s6)}
  .flow>*+*{margin-top:var(--s3)}
  .eyebrow{font-size:.7rem;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0}
  h1{font-weight:600;font-size:clamp(1.8rem,4.2vw,2.45rem);line-height:1.12;letter-spacing:-.02em;text-wrap:balance;margin:var(--s2) 0 0;color:var(--brand)}
  h2{font-weight:600;font-size:clamp(1.2rem,2.6vw,1.45rem);line-height:1.24;letter-spacing:-.015em;text-wrap:balance;margin:0}
  h3{font-weight:600;font-size:1rem;line-height:1.35;margin:0;color:var(--ink)}
  p{margin:0;max-width:66ch;color:var(--ink-2)}
  p.lede{font-size:1.08rem;line-height:1.45;color:var(--ink);max-width:66ch}
  strong{color:var(--ink);font-weight:600}
  .n{font-variant-numeric:tabular-nums;font-weight:500}
  code{font-family:var(--mono);font-size:.86em}
  section{margin-top:var(--s6)}
  .sec-head{display:flex;flex-direction:column;gap:var(--s1);padding-bottom:var(--s2);border-bottom:1px solid var(--rule);margin-bottom:var(--s4)}
  header{border-bottom:3px solid var(--brand);padding-bottom:var(--s4)}
  .windows{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);margin-top:var(--s4);font-size:.83rem}
  .win{display:flex;align-items:center;gap:var(--s2)}
  .swatch{width:11px;height:11px;border-radius:2px;flex:none}
  .swatch.a{background:var(--a)}.swatch.b{background:var(--b)}
  .win b{color:var(--ink);font-weight:600}.win span{color:var(--ink-3)}
  .top{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(310px,.78fr);gap:var(--s4);align-items:stretch}
  .verdict{background:var(--panel);border:1px solid var(--rule);border-top:4px solid var(--b);padding:var(--s4);display:flex;flex-direction:column;gap:var(--s3);border-radius:4px}
  .top .stats{align-content:start}
  @media (max-width:940px){.top{grid-template-columns:1fr}}
  .recs{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
  .rec{background:var(--panel);padding:var(--s3) var(--s4);display:grid;grid-template-columns:1.9rem minmax(0,1.15fr) minmax(0,.85fr) 7.6rem;gap:var(--s3);align-items:start}
  .rec .rank{font-size:1.3rem;font-weight:600;color:var(--b);font-variant-numeric:tabular-nums}
  .rec .txt{display:flex;flex-direction:column;gap:var(--s1)}
  .rec .txt p{font-size:.9rem;max-width:none}
  .rec .size{text-align:right;display:flex;flex-direction:column;gap:2px;white-space:nowrap}
  .rec .size b{font-size:1.15rem;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
  .rec .size span{font-size:.7rem;color:var(--ink-3);letter-spacing:.05em;text-transform:uppercase;font-weight:500}
  .rec .ev{font-family:var(--mono);font-size:.73rem;line-height:1.6;color:var(--ink-2);background:var(--panel-2);border-left:3px solid var(--b);border-radius:3px;padding:var(--s2) var(--s3);overflow-x:auto;min-width:0}
  @media (max-width:940px){.rec{grid-template-columns:1.9rem minmax(0,1fr) 7.6rem}.rec .ev{grid-column:2;grid-row:2}}
  @media (max-width:620px){.rec{grid-template-columns:1.9rem minmax(0,1fr)}.rec .size{grid-column:2;text-align:left;align-items:flex-start}}
  .chip{display:inline-flex;align-items:center;gap:.35em;font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:.25em .6em;border:1.5px solid currentColor;border-radius:3px;white-space:nowrap}
  .chip.ok{color:var(--better)}.chip.no{color:var(--worse)}.chip.mid{color:var(--watch)}.chip.nil{color:var(--flat)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
  .stat{background:var(--panel);padding:var(--s3) var(--s4);display:flex;flex-direction:column;gap:var(--s1)}
  .stat .k{font-size:.68rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3)}
  .stat .v{font-size:1.6rem;line-height:1.1;font-weight:600;color:var(--brand);font-variant-numeric:tabular-nums}
  .stat .u{font-size:.5em;font-weight:500;color:var(--ink-3)}
  .stat .d{font-size:.8rem;font-weight:600;font-variant-numeric:tabular-nums}
  .stat .sub{font-size:.78rem;color:var(--ink-3);line-height:1.45}
  .up{color:var(--worse)}.down{color:var(--better)}.even{color:var(--flat)}
  figure{margin:0;display:flex;flex-direction:column;gap:var(--s2)}
  .figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:var(--s5) var(--s5);align-items:start}
  @media (max-width:560px){.figs{grid-template-columns:1fr}}
  figcaption{font-size:.83rem;color:var(--ink-3);max-width:64ch;line-height:1.55}
  .fig-title{font-weight:600;font-size:.98rem;color:var(--ink)}
  .legend{display:flex;gap:var(--s3);flex-wrap:wrap;font-size:.74rem;color:var(--ink-2);margin-top:var(--s1);font-weight:500}
  .legend i{display:inline-flex;align-items:center;gap:.45em;font-style:normal}
  .bars{display:flex;flex-direction:column;gap:var(--s2);border-left:1px solid var(--rule)}
  .grp{display:grid;grid-template-columns:132px minmax(0,1fr);gap:var(--s2);align-items:center}
  .grp>.lbl{font-size:.78rem;color:var(--ink-2);text-align:right;line-height:1.25;font-weight:500}
  .pair{display:flex;flex-direction:column;gap:2px}
  .bar{position:relative;height:15px;display:flex;align-items:center}
  .bar .fill{height:100%;border-radius:0 4px 4px 0;box-shadow:0 0 0 2px var(--panel);transition:filter .12s ease}
  .bar:hover .fill,.bar:focus-visible .fill{filter:brightness(1.1) saturate(1.12)}
  .bar.a .fill{background:var(--a)}.bar.b .fill{background:var(--b)}
  .bar .val{font-size:.73rem;font-variant-numeric:tabular-nums;color:var(--ink-2);padding-left:.5em;white-space:nowrap;font-weight:500}
  .tip{position:fixed;z-index:9;pointer-events:none;opacity:0;background:#2D1DA3;color:#fff;font-size:.74rem;padding:.45em .65em;border-radius:4px;transition:opacity .1s ease;max-width:270px;line-height:1.5;font-variant-numeric:tabular-nums}
  .tip.on{opacity:1}
  .tbl-scroll{overflow-x:auto;border:1px solid var(--rule);background:var(--panel);border-radius:4px}
  table{border-collapse:collapse;width:100%;min-width:560px;font-size:.86rem}
  caption{text-align:left;font-size:.7rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);padding:var(--s3) var(--s4) var(--s2)}
  th,td{text-align:left;padding:.58rem var(--s4);border-top:1px solid var(--rule-2)}
  thead th{font-size:.68rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);border-top:none;border-bottom:1.5px solid var(--rule)}
  tbody th{font-weight:500;color:var(--ink)}
  td.num{font-variant-numeric:tabular-nums;text-align:right;color:var(--ink-2);font-weight:500}
  tbody tr:hover{background:var(--panel-2)}
  .notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:var(--s3) var(--s4)}
  .note{border-left:3px solid var(--rule);padding-left:var(--s3)}
  .note p{font-size:.87rem;max-width:none}
  .note .t{font-weight:600;color:var(--ink)}
  .remeasure{display:grid;grid-template-columns:minmax(260px,.7fr) minmax(0,1fr);gap:var(--s3) var(--s4);align-items:start}
  @media (max-width:720px){.remeasure{grid-template-columns:1fr}}
  .cmdbox{font-family:var(--mono);font-size:.84rem;background:var(--panel-2);color:var(--ink);padding:var(--s3) var(--s4);border:1px solid var(--rule);border-radius:4px;overflow-x:auto}
  footer{margin-top:var(--s6);padding-top:var(--s3);border-top:1px solid var(--rule);font-size:.74rem;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  :focus-visible{outline:2px solid var(--b);outline-offset:2px}
  @media (max-width:560px){.grp{grid-template-columns:1fr}.grp>.lbl{text-align:left}}
</style>

<div class="wrap">

<header>
  <p class="eyebrow">Claude Code usage · session-level reading · <span data-f="generated"></span></p>
  <h1>${escapeHtml(prose.headline)}</h1>
  <div class="windows" id="win-legend"></div>
</header>

<section style="margin-top:var(--s4)">
 <div class="top">
  <div class="verdict">
    <div style="display:flex;gap:var(--s2);flex-wrap:wrap" id="verdict-chips"></div>
    <p class="lede">${escapeHtml(prose.conclusion)}</p>
    <p>${escapeHtml(prose.outlook)}</p>
  </div>
  <!-- The headline tiles sit beside the conclusion, not in a section of their
       own: the reader checks the claim against the numbers without scrolling. -->
  <div class="stats" id="stats"></div>
 </div>
</section>

<section>
  <div class="sec-head">
    <p class="eyebrow">Recommendations</p>
    <h2>What to do next, largest first</h2>
  </div>
  <div class="recs" id="recs">
${prose.recommendations.map(recommendationHtml).join('\n')}
  </div>

  <div style="margin-top:var(--s4)" class="remeasure">
    <div class="flow">
      <h3>Set the re-measure now</h3>
      <p>On <strong>${escapeHtml(prose.remeasure.date)}</strong>, run:</p>
      <div class="cmdbox">${escapeHtml(prose.remeasure.command)}</div>
    </div>
    <p style="max-width:none">${escapeHtml(prose.remeasure.targets)}</p>
  </div>
</section>

<section>
  <div class="sec-head">
    <p class="eyebrow">Scorecard</p>
    <h2>Habit by habit</h2>
  </div>
  <div class="tbl-scroll">
    <table>
      <caption>Every figure computed over the exact window. No session counted in both.</caption>
      <thead><tr>
        <th scope="col">Measure</th>
        <th scope="col" class="num" data-f="prior.label"></th>
        <th scope="col" class="num" data-f="current.label"></th>
        <th scope="col">Reading</th>
      </tr></thead>
      <tbody id="scorecard"></tbody>
    </table>
  </div>
</section>

<section>
  <div class="sec-head">
    <p class="eyebrow">Evidence</p>
    <h2>Where the consumption sits</h2>
  </div>

  <div class="figs">
  <figure>
    <div>
      <div class="fig-title">Share of window consumption, by session duration</div>
      <div class="legend" id="leg-dur"></div>
    </div>
    <div class="bars" id="c-dur"></div>
    <figcaption>${escapeHtml(prose.durationCaption)}</figcaption>
  </figure>

  <figure>
    <div>
      <div class="fig-title">Consumption per prompt, by the session's primary model</div>
      <div class="legend" id="leg-model"></div>
    </div>
    <div class="bars" id="c-model"></div>
    <figcaption>${escapeHtml(prose.modelCaption)}</figcaption>
  </figure>
  </div>

  <figure style="margin-top:var(--s5)">
    <div>
      <div class="fig-title">Consumption per prompt, by project — current window</div>
      <div class="legend" id="leg-proj"></div>
    </div>
    <div class="bars" id="c-proj"></div>
    <figcaption>${escapeHtml(prose.projectCaption)}</figcaption>
  </figure>
</section>

<section>
  <div class="sec-head">
    <p class="eyebrow">Reading notes</p>
    <h2>What these numbers do and do not mean</h2>
  </div>
  <div class="notes" id="notes"></div>
</section>

<footer>
  <span>Source · ccalyze over local Claude Code transcripts</span>
  <span id="foot-range"></span>
  <span id="foot-totals"></span>
  <span>Generated by <code>ccalyze --habits --html</code></span>
</footer>

</div>

<div class="tip" id="tip" role="status" aria-live="polite"></div>

<script id="findings" type="application/json">
${embedFindings(report)}
</script>

<script>
(() => {
  const D = JSON.parse(document.getElementById("findings").textContent);
  const cur = D.current, pri = D.prior, unit = D.unit || "units";
  const fmtRange = w => w && w.range ? \`\${w.range.from} → \${w.range.to}\` : "—";
  const num = v => v === null || v === undefined ? "—" : v.toLocaleString();

  // Window legend + column headers. "A" is always the earlier window.
  document.getElementById("win-legend").innerHTML =
    (pri ? \`<span class="win"><span class="swatch a"></span><b>Window A</b><span>\${fmtRange(pri)}</span></span>\` : "") +
    \`<span class="win"><span class="swatch b"></span><b>Window B</b><span>\${fmtRange(cur)}</span></span>\` +
    (pri ? \`<span class="win"><span>Two windows, no overlap</span></span>\` : "");
  const legend = pri
    ? \`<i><span class="swatch a"></span>A · \${fmtRange(pri)}</i><i><span class="swatch b"></span>B · \${fmtRange(cur)}</i>\`
    : \`<i><span class="swatch b"></span>\${fmtRange(cur)}</i>\`;
  ["leg-dur","leg-model"].forEach(id => document.getElementById(id).innerHTML = legend);
  document.getElementById("leg-proj").innerHTML =
    \`<i><span class="swatch b"></span>Current window · top \${cur.byProject.length} projects</i>\`;

  document.querySelectorAll("[data-f]").forEach(el => {
    const path = el.dataset.f;
    if (path === "generated") { el.textContent = new Date().toISOString().slice(0, 10); return; }
    if (path === "prior.label") { el.textContent = pri ? "A · earlier" : "—"; return; }
    if (path === "current.label") { el.textContent = "B · current"; return; }
    const v = path.split(".").reduce((o, k) => o == null ? o : o[k], D);
    if (v !== undefined && v !== null) el.textContent = v + (el.dataset.suffix || "");
  });

  // Verdict chips are mechanical — derived, never hand-written.
  const chips = [];
  const F = D.headline && D.headline.finding;
  if (F === "volume") chips.push(["ok", "Conclusion · the volume is real"]);
  else if (F === "efficiency-regression") chips.push(["no", "Conclusion · a habit is driving this"]);
  else if (F === "single-window") chips.push(["nil", "Single window · no habit tracking"]);
  else chips.push(["mid", "Conclusion · mixed"]);
  if (pri) {
    const improved = D.scorecard.filter(r => (r.verdict || "").endsWith("better")).length;
    const worse = D.scorecard.filter(r => r.verdict === "worse").length;
    chips.push(worse > improved ? ["no", \`\${worse} measures worse\`]
                                : ["nil", \`\${improved} measures improved, \${worse} worse\`]);
  }
  document.getElementById("verdict-chips").innerHTML =
    chips.map(([c, t]) => \`<span class="chip \${c}">\${t}</span>\`).join("");

  // Stat tiles.
  const d = D.delta || {};
  const tile = (k, v, u, delta, lowerBetter, sub) => {
    let cls = "even", txt = "no baseline";
    if (delta !== null && delta !== undefined) {
      const good = lowerBetter ? delta < 0 : delta > 0;
      cls = Math.abs(delta) < 5 ? "even" : good ? "down" : "up";
      txt = \`\${delta > 0 ? "▲" : delta < 0 ? "▼" : "■"} \${Math.abs(delta)}%\`;
    }
    return \`<div class="stat"><span class="k">\${k}</span>
      <span class="v">\${v}\${u ? \`<span class="u"> \${u}</span>\` : ""}</span>
      <span class="d \${cls}">\${txt}</span><span class="sub">\${sub}</span></div>\`;
  };
  document.getElementById("stats").innerHTML = [
    tile("Consumption", num(cur.cost), unit, d.cost, true,
      \`Notional API-rate equivalent, not billed spend — see reading notes.\`),
    tile("Prompts", num(cur.prompts), "", d.prompts, true,
      \`Across \${num(cur.sessions)} sessions and \${cur.daysCovered} days with data.\`),
    tile("Per prompt", cur.perPrompt, "", d.perPrompt, true,
      \`The efficiency number. Volume divides out of it.\`),
    tile("Sessions", num(cur.sessions), "", d.sessions, true,
      \`More but shorter is an improvement; read it with the duration split.\`)
  ].join("");

  // Scorecard.
  const chipFor = v => v === "worse" ? "no" : v === "flat" ? "nil"
    : v === "no-baseline" ? "nil" : "ok";
  document.getElementById("scorecard").innerHTML = D.scorecard.map(r =>
    \`<tr><th scope="row">\${r.measure}</th>
      <td class="num">\${r.prior === null ? "—" : r.prior}</td>
      <td class="num">\${r.current === null ? "—" : r.current}</td>
      <td><span class="chip \${chipFor(r.verdict)}">\${r.verdict}</span></td></tr>\`).join("");

  // Reading notes come from the JSON so they can never drift from the maths.
  // Any caveat key habits.ts adds later still renders — an unmapped key falls
  // back to its own name rather than disappearing from the report.
  const NOTE_TITLES = {
    costIsNotional: "The consumption figures are not money",
    durationIsWallClock: "A long session is not that many hours of work",
    flaggedShareIsHigh: "A high flagged share is normal, not alarming",
    byDayIsStartDated: "Do not read a day-by-day shape into this",
    autoCompactionNeedsRecentTranscripts: "Auto-compaction needs a recent transcript",
    reworkIsNotAJudgement: "Repeated edits are not a verdict",
    offHoursIsLocalClock: "Off-hours reads this machine's clock",
    cleanCohort: "The clean-cohort baseline",
    baselineUnmeasured: "The per-request baseline is unmeasured"
  };
  document.getElementById("notes").innerHTML = Object.entries(D.caveats || {})
    .map(([k, v]) => \`<div class="note"><p><span class="t">\${NOTE_TITLES[k] || k}.</span> \${v}</p></div>\`)
    .join("");

  document.getElementById("foot-range").textContent =
    pri ? \`Windows · \${fmtRange(pri)} and \${fmtRange(cur)}\` : \`Window · \${fmtRange(cur)}\`;
  document.getElementById("foot-totals").textContent =
    \`\${num(cur.sessions + (pri ? pri.sessions : 0))} sessions · \` +
    \`\${num(cur.prompts + (pri ? pri.prompts : 0))} prompts\`;

  /* ---------- charts ---------- */
  const tip = document.getElementById("tip");
  const wire = (el, text) => {
    const show = e => {
      tip.textContent = text; tip.classList.add("on");
      const p = 14; let x = e.clientX + p, y = e.clientY + p;
      const r = tip.getBoundingClientRect();
      if (x + r.width > innerWidth - 8) x = e.clientX - r.width - p;
      if (y + r.height > innerHeight - 8) y = e.clientY - r.height - p;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    el.addEventListener("pointerenter", show);
    el.addEventListener("pointermove", show);
    el.addEventListener("pointerleave", () => tip.classList.remove("on"));
    el.tabIndex = 0; el.setAttribute("aria-label", text);
    el.addEventListener("focus", () => {
      tip.textContent = text; tip.classList.add("on");
      const b = el.getBoundingClientRect();
      tip.style.left = b.left + "px"; tip.style.top = (b.bottom + 8) + "px";
    });
    el.addEventListener("blur", () => tip.classList.remove("on"));
  };
  const bar = (cls, pct, label, t) => {
    const row = document.createElement("div"); row.className = "bar " + cls;
    const fill = document.createElement("div"); fill.className = "fill";
    fill.style.width = Math.max(pct, 0.6) + "%";
    const val = document.createElement("span"); val.className = "val"; val.textContent = label;
    row.append(fill, val); wire(row, t); return row;
  };
  // One shared row builder: labels down the left, A above B in each group.
  const rows = (mount, keys, pick, max, fmt, tipText) => {
    const host = document.getElementById(mount);
    keys.forEach(key => {
      const g = document.createElement("div"); g.className = "grp";
      const l = document.createElement("div"); l.className = "lbl"; l.textContent = key;
      const pair = document.createElement("div"); pair.className = "pair";
      [["a", pri], ["b", cur]].forEach(([cls, w]) => {
        if (!w) return;
        const v = pick(w, key);
        if (v === null || v === undefined) return;
        pair.append(bar(cls, max ? 100 * v / max : 0, fmt(v), tipText(cls, w, key, v)));
      });
      g.append(l, pair); host.append(g);
    });
  };

  const bands = cur.byDuration.map(b => b.band);
  const bandOf = (w, k) => (w.byDuration.find(b => b.band === k) || {}).costShare;
  const bandN = (w, k) => (w.byDuration.find(b => b.band === k) || {}).sessions;
  rows("c-dur", bands, bandOf,
    Math.max(0, ...[cur, pri].filter(Boolean).flatMap(w => w.byDuration.map(b => b.costShare))) * 1.08,
    v => v.toFixed(1) + "%",
    (cls, w, k, v) => \`\${cls === "a" ? "A" : "B"} · \${k}: \${v.toFixed(1)}% of window — \${bandN(w, k)} sessions\`);

  const modelKeys = [...new Set([cur, pri].filter(Boolean)
    .flatMap(w => w.byModel.map(m => m.model)))];
  const rateOf = (w, k) => (w.byModel.find(m => m.model === k) || {}).perPrompt;
  const promptsOf = (w, k) => (w.byModel.find(m => m.model === k) || {}).prompts || 0;
  rows("c-model", modelKeys, rateOf,
    Math.max(0, ...[cur, pri].filter(Boolean).flatMap(w => w.byModel.map(m => m.perPrompt || 0))) * 1.08,
    v => v.toFixed(4),
    (cls, w, k, v) => \`\${cls === "a" ? "A" : "B"} · \${k}: \${v.toFixed(4)} per prompt across \${promptsOf(w, k).toLocaleString()} prompts\`);

  (() => {
    const host = document.getElementById("c-proj");
    const max = Math.max(0, ...cur.byProject.map(p => p.perPrompt || 0)) * 1.08;
    cur.byProject.filter(p => p.perPrompt).forEach(p => {
      const g = document.createElement("div"); g.className = "grp";
      const l = document.createElement("div"); l.className = "lbl"; l.textContent = p.project;
      const pair = document.createElement("div"); pair.className = "pair";
      pair.append(bar("b", max ? 100 * p.perPrompt / max : 0, p.perPrompt.toFixed(3),
        \`\${p.project}: \${p.perPrompt.toFixed(3)} per prompt — \${p.cost.toLocaleString()} \${unit} over \${p.prompts.toLocaleString()} prompts\`));
      g.append(l, pair); host.append(g);
    });
  })();
})();
</script>
`;
}
