#!/usr/bin/env node
// Debug CLI for agent-session-core. Proves the parser on real ~/.codex / ~/.claude
// logs without any build step.
//
//   agent-sessions recent [--limit N] [--engine codex|claude] [--days N]
//   agent-sessions totals [--days N]

import { discoverSessionFiles, parseSessionFile } from "../src/index.mjs";
import { sessionTokenTotals } from "../src/projections/token-events.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "recent";
const opts = parseFlags(argv);
const limit = num(opts.limit, 12);
const days = num(opts.days, null);
const sinceMs = days == null ? null : days * 24 * 60 * 60 * 1000;

const roots = opts.engine
  ? { [opts.engine]: defaultRootsFor(opts.engine) }
  : undefined;

const files = discoverSessionFiles({ sinceMs, roots, maxFiles: cmd === "recent" ? limit * 3 : Infinity });

if (cmd === "totals") {
  runTotals(files);
} else {
  runRecent(files, limit);
}

function runRecent(files, n) {
  const rows = [];
  for (const file of files) {
    const s = parseSessionFile(file);
    if (!s) continue;
    const t = sessionTokenTotals(s);
    if (t.records === 0 && s.events.length === 0) continue;
    rows.push({ s, t });
    if (rows.length >= n) break;
  }
  const header = pad("ENGINE", 7) + pad("PROJECT", 18) + pad("MODEL", 22) + pad("MSGS", 6) + pad("TOOLS", 6) + pad("TOTAL", 12) + pad("CACHE%", 8) + pad("COST$", 9) + "TITLE";
  console.log(header);
  console.log("-".repeat(header.length + 10));
  for (const { s, t } of rows) {
    const msgs = s.events.filter((e) => e.kind === "message").length;
    const tools = s.events.filter((e) => e.kind === "tool_call").length;
    const cacheRate = t.inputTokens > 0 ? ((t.cachedInputTokens / t.inputTokens) * 100).toFixed(0) : "-";
    console.log(
      pad(s.engine, 7) +
        pad(basename(s.cwd) || "-", 18) +
        pad(s.model || "-", 22) +
        pad(String(msgs), 6) +
        pad(String(tools), 6) +
        pad(fmt(t.totalTokens), 12) +
        pad(cacheRate, 8) +
        pad(t.costUsd ? t.costUsd.toFixed(3) : "0", 9) +
        (s.title || "").slice(0, 50)
    );
  }
  console.log(`\n${rows.length} sessions${days ? ` (last ${days}d)` : ""}.`);
}

function runTotals(files) {
  const agg = { sessions: 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, costUsd: 0, records: 0 };
  const byEngine = {};
  let compactions = 0;
  for (const file of files) {
    const s = parseSessionFile(file);
    if (!s) continue;
    const t = sessionTokenTotals(s);
    if (t.totalTokens === 0) continue;
    agg.sessions += 1;
    for (const k of ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "costUsd", "records"]) agg[k] += t[k];
    compactions += s.events.filter((e) => e.kind === "compaction").length;
    const e = (byEngine[s.engine] ||= { sessions: 0, totalTokens: 0, costUsd: 0 });
    e.sessions += 1;
    e.totalTokens += t.totalTokens;
    e.costUsd += t.costUsd;
  }
  console.log(`Sessions: ${agg.sessions}${days ? ` (last ${days}d)` : ""}`);
  console.log(`Total tokens: ${fmt(agg.totalTokens)}  (in ${fmt(agg.inputTokens)} / cached ${fmt(agg.cachedInputTokens)} / out ${fmt(agg.outputTokens)} / reasoning ${fmt(agg.reasoningOutputTokens)})`);
  console.log(`Token events: ${fmt(agg.records)}   Compactions: ${compactions}`);
  console.log(`Est. cost (priced models only): $${agg.costUsd.toFixed(2)}`);
  for (const [eng, e] of Object.entries(byEngine)) {
    console.log(`  ${pad(eng, 8)} ${pad(String(e.sessions) + " sess", 12)} ${pad(fmt(e.totalTokens), 14)} $${e.costUsd.toFixed(2)}`);
  }
}

function defaultRootsFor(engine) {
  return engine === "claude" ? ["~/.claude/projects"] : ["~/.codex/sessions", "~/.codex/archived_sessions"];
}
function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      o[key] = val;
    }
  }
  return o;
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length);
}
function basename(p) {
  if (!p) return "";
  const c = p.replace(/[\\/]+$/, "");
  const i = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
  return i >= 0 ? c.slice(i + 1) : c;
}
