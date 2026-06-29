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

import { discoverSessionFiles, parseSessionFile } from "../src/index.mjs";
import { readLines } from "../src/read-lines.mjs";
import { toNumber, isRecord, safeJsonParse } from "../src/util.mjs";

const days = num(flag("days"), 14);
const sinceMs = days * 24 * 60 * 60 * 1000;
const files = discoverSessionFiles({ sinceMs, roots: { codex: ["~/.codex/sessions", "~/.codex/archived_sessions"] } });

if (files.length === 0) {
  console.log("Codex parity: no ~/.codex sessions found — SKIP (frozen fixtures in test/ are the CI gate).");
  process.exit(0);
}

let sessions = 0;
let withReset = 0;
let parityChecked = 0;
let parityMismatch = 0;
const mismatches = [];
let sumEngine = 0; // (A) summed input+output via this package
let sumNaive = 0; // (B) last-snapshot input+output
let resetOracleChecked = 0;
let resetOracleMismatch = 0;
const oracleMismatches = [];
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
    // HARD GATE for the reset branch: an independent reset-aware recomputation straight
    // from the raw cumulative snapshots (no shared code with the engine event pipeline)
    // must equal the engine. This is the only invariant that actually exercises
    // codex.mjs's reset path — without it the branch could silently regress to naive
    // (the 5.5x under-count). It must ALSO be > naive (anti-collapse / value guard).
    const oracle = resetAwareInOutOracle(raw.snapshots);
    resetOracleChecked += 1;
    if (engineInOut !== oracle || engineInOut <= naiveInOut) {
      resetOracleMismatch += 1;
      if (oracleMismatches.length < 8) oracleMismatches.push({ project: base(session.cwd), engineInOut, oracle, naiveInOut, file: file.path });
    }
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
console.log("── PARITY (reset sessions: engine MUST equal independent reset-aware oracle, and exceed naive) ──");
console.log(`  checked: ${resetOracleChecked}   mismatches: ${resetOracleMismatch}  ${resetOracleMismatch === 0 ? "✓ PASS" : "✗ FAIL"}`);
for (const m of oracleMismatches) console.log(`    MISMATCH ${m.project}: engine=${m.engineInOut} oracle=${m.oracle} naive=${m.naiveInOut}\n      ${m.file}`);
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

if (parityMismatch > 0 || resetOracleMismatch > 0) {
  console.log("");
  console.log(`✗ FAIL: ${parityMismatch} no-reset + ${resetOracleMismatch} reset oracle mismatch(es)`);
  process.exit(1);
}

// Independent reset-aware oracle: recompute input+output straight from the raw
// cumulative snapshots, with NO shared code with the engine's event pipeline, so an
// exact match is genuine cross-validation of codex.mjs's reset path. A reset (total
// drops) counts the whole snapshot; otherwise a field-wise saturating delta.
//
// NOTE: a pure "sum each context window's LAST snapshot" shortcut is only exact when
// input_tokens AND output_tokens are monotonic within the window. Real Codex logs have
// output_tokens dip mid-window (total_tokens still rises), so the per-field clamped
// delta legitimately exceeds the window-last sum by the dip total — hence we mirror the
// per-field saturating math here rather than the window-last shortcut.
function resetAwareInOutOracle(snapshots) {
  let inSum = 0;
  let outSum = 0;
  let prev = null;
  for (const s of snapshots) {
    const isReset = prev && toNumber(s.total_tokens) < toNumber(prev.total_tokens);
    if (!prev || isReset) {
      inSum += toNumber(s.input_tokens);
      outSum += toNumber(s.output_tokens);
    } else {
      inSum += Math.max(0, toNumber(s.input_tokens) - toNumber(prev.input_tokens));
      outSum += Math.max(0, toNumber(s.output_tokens) - toNumber(prev.output_tokens));
    }
    prev = s;
  }
  return inSum + outSum;
}

function readRawCodexTotals(path) {
  let last = {};
  let prev = {};
  let resets = 0;
  let seen = false;
  const snapshots = [];
  try {
    // Stream the file (same bounded reader the library uses) instead of slurping
    // it whole, so this oracle can't OOM on a huge session. readLines opens the fd
    // lazily on first iteration, so the read can only throw inside the loop.
    for (const raw of readLines(path)) {
      const line = raw.replace(/\r$/, "");
      if (!line.includes('"token_count"')) continue;
      const row = safeJsonParse(line.trim());
      if (!isRecord(row)) continue;
      const payload = isRecord(row.payload) ? row.payload : {};
      if (row.type !== "event_msg" || payload.type !== "token_count") continue;
      const info = isRecord(payload.info) ? payload.info : {};
      const total = isRecord(info.total_token_usage) ? info.total_token_usage : null;
      if (!total) continue;
      if (toNumber(total.total_tokens) < toNumber(prev.total_tokens)) resets += 1;
      snapshots.push(total);
      prev = total;
      last = total;
      seen = true;
    }
  } catch {
    return null;
  }
  return seen ? { last, resets, snapshots } : null;
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
