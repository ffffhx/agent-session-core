#!/usr/bin/env node
// Parity + value demo for the Claude token math (B1 dedup + B3 cache-write).
//
// Claude splits one assistant message across multiple content-block rows that
// share (message.id, requestId) and each repeat the message's FINAL usage. The old
// per-row sum therefore inflates input+output by ~2x. For every Claude session this
// computes input+output three ways:
//   (A) ASC engine        — parseClaudeSession + sessionTokenTotals (deduped)
//   (B) naive per-row sum  — every assistant row's usage added (the old bug)
//   (C) composite dedup    — reference: first (message.id, requestId) wins
//
// Asserts (A) == (C) (ASC dedups exactly), and reports (B)/(A) inflation.
// Subagent transcripts (agent-*.jsonl) are excluded to match the forensic method.
//
//   node scripts/parity-claude.mjs [--days N]

import { readFileSync } from "node:fs";
import { discoverSessionFiles, parseClaudeSession } from "../src/index.mjs";
import { sessionTokenTotals } from "../src/projections/token-events.mjs";
import { isRecord, safeJsonParse, toTokenCount, basename } from "../src/util.mjs";

const days = num(flag("days"), 14);
const sinceMs = days * 24 * 60 * 60 * 1000;
const files = discoverSessionFiles({ sinceMs, roots: { claude: ["~/.claude/projects"] } });

if (files.length === 0) {
  console.log("Claude parity: no ~/.claude sessions found — SKIP (frozen fixtures in test/ are the CI gate).");
  process.exit(0);
}

let sessions = 0;
let asc = 0; // (A)
let naive = 0; // (B)
let composite = 0; // (C)
let msgIdUnderMultipleRequestIds = 0;
let ascVsCompositeMismatch = 0;

for (const file of files) {
  if (basename(file.path).startsWith("agent-")) continue; // subagent transcripts
  let text;
  try {
    text = readFileSync(file.path, "utf8");
  } catch {
    continue;
  }
  const raw = rawClaudeTotals(text);
  if (!raw) continue;
  const session = parseClaudeSession(text, { filePath: file.path });

  let ascInOut = 0;
  for (const ev of session.events) if (ev.kind === "token_usage") ascInOut += ev.usage.input + ev.usage.output;
  const totals = sessionTokenTotals(session);
  // sanity: sessionTokenTotals telescopes to the same input+output the events carry.
  ascInOut = totals.inputTokens + totals.outputTokens;

  if (ascInOut === 0 && raw.naive === 0) continue;
  sessions += 1;
  asc += ascInOut;
  naive += raw.naive;
  composite += raw.composite;
  msgIdUnderMultipleRequestIds += raw.msgIdUnderMultipleRequestIds;
  if (ascInOut !== raw.composite) ascVsCompositeMismatch += 1;
}

console.log(`Claude sessions analyzed: ${sessions}  (last ${days}d, agent-*.jsonl excluded)`);
console.log("");
console.log("── PARITY (ASC engine MUST equal composite (message.id,requestId) dedup) ──");
console.log(`  mismatched sessions: ${ascVsCompositeMismatch}  ${ascVsCompositeMismatch === 0 ? "✓ PASS" : "✗ FAIL"}`);
console.log(`  message.id spanning multiple requestId: ${msgIdUnderMultipleRequestIds}`);
console.log("");
console.log("── VALUE (how much the old per-row sum inflates Claude usage) ──");
console.log(`  Σ ASC (deduped)        : ${fmt(asc)}`);
console.log(`  Σ composite (reference): ${fmt(composite)}`);
console.log(`  Σ naive per-row (old)  : ${fmt(naive)}`);
const inflation = asc > 0 ? (naive / asc).toFixed(3) : "n/a";
console.log(`  inflation naive/ASC    : ${inflation}x`);

if (ascVsCompositeMismatch > 0) {
  console.log("");
  console.log(`✗ FAIL: ${ascVsCompositeMismatch} session(s) where ASC engine != composite dedup oracle`);
  process.exit(1);
}

function rawClaudeTotals(text) {
  let naiveSum = 0;
  let compositeSum = 0;
  const seen = new Set();
  const msgIdReqIds = new Map();
  let any = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const row = safeJsonParse(t);
    if (!isRecord(row) || row.type !== "assistant") continue;
    const message = isRecord(row.message) ? row.message : null;
    if (!message || !isRecord(message.usage)) continue;
    const u = message.usage;
    const inOut =
      toTokenCount(u.input_tokens) +
      toTokenCount(u.cache_read_input_tokens) +
      toTokenCount(u.cache_creation_input_tokens) +
      toTokenCount(u.output_tokens);
    if (inOut <= 0) continue;
    any = true;
    naiveSum += inOut;
    const msgId = typeof message.id === "string" ? message.id : "";
    const reqId = typeof row.requestId === "string" ? row.requestId : "";
    const key = msgId ? `${msgId}:${reqId}` : "";
    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      compositeSum += inOut;
    }
    if (msgId) {
      const set = msgIdReqIds.get(msgId) || new Set();
      set.add(reqId);
      msgIdReqIds.set(msgId, set);
    }
  }
  let multi = 0;
  for (const set of msgIdReqIds.values()) if (set.size > 1) multi += 1;
  return any ? { naive: naiveSum, composite: compositeSum, msgIdUnderMultipleRequestIds: multi } : null;
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
