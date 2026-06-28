#!/usr/bin/env node
// Gold-standard parity: run agent-retro's OWN parser + analyzer against this
// package's metrics projection on the same real session files, and diff field by
// field. Fields that SHOULD match (turns, toolCount, toolFails, raw durationMs,
// and score on non-compaction sessions) flag any divergence as a real bug; fields
// that are intended fixes (codex webSearches, compaction-session tokens/score) are
// reported separately as "improved, not regressed".
//
//   node scripts/parity-metrics.mjs [--limit N] [--days N]

import { discoverSessionFiles, parseSessionFile } from "../src/index.mjs";
import { toMetrics } from "../src/projections/metrics.mjs";
import { parseCodexSession as retroParseCodex } from "/Users/bytedance/Code/agent-retro/src/parsers/codex.mjs";
import { parseClaudeSession as retroParseClaude } from "/Users/bytedance/Code/agent-retro/src/parsers/claude.mjs";
import { analyzeSession as retroAnalyze, grade as retroGrade } from "/Users/bytedance/Code/agent-retro/src/analyze.mjs";

const limit = num(flag("limit"), 150);
const days = num(flag("days"), 14);
const files = discoverSessionFiles({ sinceMs: days * 864e5 }).slice(0, limit);

const MUST_MATCH = ["turns", "toolCount", "toolFails", "cacheRate", "failRate", "durationMs", "score", "grade"];
const tally = Object.fromEntries(MUST_MATCH.map((k) => [k, { checked: 0, mismatch: 0, samples: [] }]));
let analyzed = 0;
let codexWebFixed = 0, codexWebFixedTotal = 0;
const scoreDiffsOnReset = [];
const scoreDiffsNoReset = [];

for (const file of files) {
  const session = parseSessionFile(file);
  if (!session) continue;
  let retroMeta;
  try {
    retroMeta = file.engine === "claude" ? await retroParseClaude(file.path) : await retroParseCodex(file.path);
  } catch {
    continue;
  }
  const retro = retroAnalyze(retroMeta);
  const mine = toMetrics(session);
  const hadReset = mine.compactions > 0;
  analyzed += 1;

  const pairs = {
    turns: [retroMeta.turns, mine.turns],
    toolCount: [retro.metrics.toolCount, mine.metrics.toolCount],
    toolFails: [retro.metrics.toolFails, mine.metrics.toolFails],
    cacheRate: [retro.metrics.cacheRate, mine.metrics.cacheRate],
    failRate: [retro.metrics.failRate, mine.metrics.failRate],
    durationMs: [retro.metrics.durationMs, mine.metrics.durationMs],
    score: [retro.score, mine.score],
    grade: [retroGrade(retro.score), mine.grade],
  };

  for (const key of MUST_MATCH) {
    const [a, b] = pairs[key];
    // tokens/score on reset (compaction) codex sessions are an intended fix, not a regression
    const intendedFix = hadReset && (key === "cacheRate" || key === "score" || key === "grade");
    if (intendedFix) continue;
    tally[key].checked += 1;
    if (a !== b) {
      tally[key].mismatch += 1;
      if (tally[key].samples.length < 6) tally[key].samples.push({ p: mine.project || "-", eng: session.engine, a, b, file: base(file.path) });
    }
  }

  if (pairs.score[0] !== pairs.score[1]) {
    (hadReset ? scoreDiffsOnReset : scoreDiffsNoReset).push({ p: mine.project, eng: session.engine, retro: pairs.score[0], mine: pairs.score[1], reset: mine.compactions });
  }

  if (session.engine === "codex" && mine.webSearches > 0 && retroMeta.webSearches === 0) {
    codexWebFixed += 1;
    codexWebFixedTotal += mine.webSearches;
  }
}

console.log(`Analyzed: ${analyzed} sessions (last ${days}d, cap ${limit})\n`);
console.log("── MUST-MATCH fields (mismatch here = real bug) ──");
for (const key of MUST_MATCH) {
  const t = tally[key];
  const ok = t.mismatch === 0;
  console.log(`  ${pad(key, 12)} ${pad(`${t.checked - t.mismatch}/${t.checked}`, 10)} ${ok ? "✓" : "✗ " + t.mismatch + " mismatch"}`);
  for (const s of t.samples) console.log(`        ${s.eng} ${s.p}: retro=${s.a} mine=${s.b}  (${s.file})`);
}

console.log("\n── INTENDED FIXES (improved, not regressed) ──");
console.log(`  codex webSearches recovered: ${codexWebFixed} sessions (agent-retro reported 0; ${codexWebFixedTotal} searches total)`);
console.log(`  score diffs on compaction sessions (reset-aware tokens): ${scoreDiffsOnReset.length}`);
for (const s of scoreDiffsOnReset.slice(0, 8)) console.log(`        ${s.eng} ${s.p}: retro=${s.retro} → mine=${s.mine} (${s.reset} compaction)`);
if (scoreDiffsNoReset.length) {
  console.log(`\n  ⚠ score diffs WITHOUT compaction (unexpected, investigate): ${scoreDiffsNoReset.length}`);
  for (const s of scoreDiffsNoReset.slice(0, 10)) console.log(`        ${s.eng} ${s.p}: retro=${s.retro} mine=${s.mine}`);
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function base(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
