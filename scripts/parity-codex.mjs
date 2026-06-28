#!/usr/bin/env node
// Parity + value demo for the Codex token math.
//
// For every Codex session it computes input+output two ways:
//   (A) reset-aware delta sum  — this package (== token-board's correct method)
//   (B) naive last snapshot    — agent-retro's current codex method (tokens.total = last total_token_usage)
//
// When NO compaction/reset happened the two MUST be equal (parity check on this
// package's engine). When a reset happened, (A) > (B): that gap is exactly what
// agent-retro silently under-counts today.
//
//   node scripts/parity-codex.mjs [--days N]

import { readFileSync } from "node:fs";
import { discoverSessionFiles, parseSessionFile } from "../src/index.mjs";
import { toNumber, isRecord, safeJsonParse } from "../src/util.mjs";

const days = num(flag("days"), 14);
const sinceMs = days * 24 * 60 * 60 * 1000;
const files = discoverSessionFiles({ sinceMs, roots: { codex: ["~/.codex/sessions", "~/.codex/archived_sessions"] } });

let sessions = 0;
let withReset = 0;
let parityChecked = 0;
let parityMismatch = 0;
const mismatches = [];
let sumEngine = 0; // (A) summed input+output via this package
let sumNaive = 0; // (B) last-snapshot input+output
const undercounts = [];

for (const file of files) {
  const raw = readRawCodexTotals(file.path);
  if (!raw) continue;
  const session = parseSessionFile(file);
  if (!session) continue;

  // (A) this package: sum token_usage input+output
  let engineInOut = 0;
  for (const ev of session.events) if (ev.kind === "token_usage") engineInOut += ev.usage.input + ev.usage.output;

  // (B) naive last snapshot: last total_token_usage input+output
  const naiveInOut = toNumber(raw.last.input_tokens) + toNumber(raw.last.output_tokens);

  if (engineInOut === 0 && naiveInOut === 0) continue;
  sessions += 1;
  sumEngine += engineInOut;
  sumNaive += naiveInOut;

  if (raw.resets > 0) {
    withReset += 1;
    const gap = engineInOut - naiveInOut;
    if (gap > 0) undercounts.push({ project: base(session.cwd), gap, naiveInOut, engineInOut, resets: raw.resets });
  } else {
    // No reset → telescoping sum of deltas must equal the last snapshot exactly.
    parityChecked += 1;
    if (engineInOut !== naiveInOut) {
      parityMismatch += 1;
      if (mismatches.length < 8) mismatches.push({ project: base(session.cwd), engineInOut, naiveInOut, file: file.path });
    }
  }
}

console.log(`Codex sessions analyzed: ${sessions}  (last ${days}d)`);
console.log("");
console.log("── PARITY (no-reset sessions: package engine MUST equal naive last-snapshot) ──");
console.log(`  checked: ${parityChecked}   mismatches: ${parityMismatch}  ${parityMismatch === 0 ? "✓ PASS" : "✗ FAIL"}`);
for (const m of mismatches) console.log(`    MISMATCH ${m.project}: engine=${m.engineInOut} naive=${m.naiveInOut}\n      ${m.file}`);
console.log("");
console.log("── VALUE (reset/compaction sessions: how much agent-retro under-counts) ──");
console.log(`  sessions with reset/compaction: ${withReset}`);
const totalGap = sumEngine - sumNaive;
const pct = sumNaive > 0 ? ((totalGap / sumNaive) * 100).toFixed(1) : "0";
console.log(`  Σ correct (reset-aware): ${fmt(sumEngine)}`);
console.log(`  Σ naive (last snapshot): ${fmt(sumNaive)}`);
console.log(`  under-counted by naive : ${fmt(totalGap)}  (+${pct}% the correct method recovers)`);
undercounts.sort((a, b) => b.gap - a.gap);
console.log("  top under-counted sessions:");
for (const u of undercounts.slice(0, 6)) {
  console.log(`    ${pad(u.project, 20)} naive ${pad(fmt(u.naiveInOut), 10)} → correct ${pad(fmt(u.engineInOut), 10)} (+${fmt(u.gap)}, ${u.resets} reset)`);
}

function readRawCodexTotals(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let last = {};
  let prev = {};
  let resets = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"token_count"')) continue;
    const row = safeJsonParse(line.trim());
    if (!isRecord(row)) continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (row.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = isRecord(payload.info) ? payload.info : {};
    const total = isRecord(info.total_token_usage) ? info.total_token_usage : null;
    if (!total) continue;
    if (toNumber(total.total_tokens) < toNumber(prev.total_tokens)) resets += 1;
    prev = total;
    last = total;
    seen = true;
  }
  return seen ? { last, resets } : null;
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
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
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function base(p) {
  if (!p) return "-";
  const c = p.replace(/[\\/]+$/, "");
  const i = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
  return i >= 0 ? c.slice(i + 1) : c;
}
