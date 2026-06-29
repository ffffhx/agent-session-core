// Parse robustness (Stage III): engine detection edge cases (B4) and the
// streaming reader's byte-budget / truncation / cross-chunk invariants (B5).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as bufferConstants } from "node:buffer";

import { parseSessionFile, parseSessionText, detectEngine } from "../src/parse.mjs";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { parseClaudeSession } from "../src/engines/claude.mjs";
import { readLines, PARSE_MAX_BYTES } from "../src/read-lines.mjs";
import { sessionTokenTotals } from "../src/projections/token-events.mjs";
import { toSnapshot } from "../src/projections/snapshot.mjs";

const CODEX_META = `{"type":"session_meta","payload":{"id":"s1"}}`;
const CLAUDE_ROW = `{"type":"user","sessionId":"abc","message":{"role":"user","content":"hi"}}`;

// Write `body` to a fresh temp file and run `fn(path)`, cleaning up after.
function withFile(name, body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "asc-parse-"));
  const path = join(dir, name);
  try {
    writeFileSync(path, body);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── B4: engine detection robustness ───────────────────────────────────────

test("detect: single-line codex file with NO trailing newline still parses", () => {
  // The original bug: slice(0, indexOf("\n")=-1) dropped the closing brace and
  // detectEngine returned null, so the whole file was silently skipped.
  withFile("rollout.jsonl", CODEX_META, (path) => {
    const s = parseSessionFile({ path });
    assert.ok(s, "session must not be null");
    assert.equal(s.engine, "codex");
  });
});

test("detect: single-line claude file with NO trailing newline still parses", () => {
  withFile("uuid.jsonl", CLAUDE_ROW, (path) => {
    const s = parseSessionFile({ path });
    assert.ok(s);
    assert.equal(s.engine, "claude");
  });
});

test("detect: trailing-newline variant is identical (regression control)", () => {
  withFile("rollout.jsonl", CODEX_META + "\n", (path) => {
    assert.equal(parseSessionFile({ path }).engine, "codex");
  });
  withFile("uuid.jsonl", CLAUDE_ROW + "\n", (path) => {
    assert.equal(parseSessionFile({ path }).engine, "claude");
  });
});

test("detect: leading blank / preamble lines are skipped (marker-scan)", () => {
  const body = ["", "   ", CODEX_META, ""].join("\n");
  withFile("rollout.jsonl", body, (path) => {
    assert.equal(parseSessionFile({ path }).engine, "codex");
  });
});

test("detect: \\r\\n line ending on a single-line file is handled", () => {
  withFile("rollout.jsonl", CODEX_META + "\r\n", (path) => {
    assert.equal(parseSessionFile({ path }).engine, "codex");
  });
  // Single line, CRLF, no final newline — the \r must be stripped before parse.
  withFile("rollout.jsonl", CODEX_META + "\r", (path) => {
    assert.equal(parseSessionFile({ path }).engine, "codex");
  });
});

test("detect: pure non-JSON garbage is not misdetected (returns null)", () => {
  withFile("junk.jsonl", "not json at all\nstill not\n", (path) => {
    assert.equal(parseSessionFile({ path }), null);
  });
});

test("detect: discovery-provided engine wins over content (path-driven first)", () => {
  // A claude-looking row in a file tagged codex stays codex — engine is trusted.
  withFile("x.jsonl", CLAUDE_ROW, (path) => {
    assert.equal(parseSessionFile({ path, engine: "codex" }).engine, "codex");
  });
});

test("detectEngine: truncated JSON (missing closing brace) -> null; complete -> engine", () => {
  // Locks the invariant the old slice violated: a half a JSON object is undecidable.
  assert.equal(detectEngine(`{"type":"session_meta","payload":{}`), null);
  assert.equal(detectEngine(`{"type":"session_meta","payload":{}}`), "codex");
  assert.equal(detectEngine(`{"type":"user","sessionId":"a"}`), "claude");
  assert.equal(detectEngine(""), null);
});

// ── B5: streaming reader bounds & truncation ───────────────────────────────

test("invariant: PARSE_MAX_BYTES is strictly below V8 max string length", () => {
  // The old 512MB discovery cap exceeded this by 24 bytes, so near-512MB ASCII
  // files threw RangeError on readFileSync(utf8) and were silently dropped.
  assert.ok(PARSE_MAX_BYTES < bufferConstants.MAX_STRING_LENGTH);
});

test("readLines: splits correctly across a chunk boundary", () => {
  // Force a newline to fall right at the read-window edge.
  const a = "a".repeat(10);
  const b = "b".repeat(10);
  const body = `${a}\n${b}\n`;
  withFile("c.jsonl", body, (path) => {
    const lines = [...readLines(path, { chunkBytes: 11 })]; // boundary inside the data
    assert.deepEqual(lines, [a, b]);
  });
});

test("readLines: multi-byte UTF-8 split across a chunk boundary is not corrupted", () => {
  // A 3-byte char (世 '世') straddling the chunk edge must decode whole.
  const body = "x世界\nok\n";
  withFile("u.jsonl", body, (path) => {
    // chunkBytes=2 guarantees the '世' bytes span two reads.
    const lines = [...readLines(path, { chunkBytes: 2 })];
    assert.deepEqual(lines, ["x世界", "ok"]);
  });
});

test("readLines: final line without a trailing newline is yielded", () => {
  withFile("n.jsonl", "one\ntwo", (path) => {
    assert.deepEqual([...readLines(path)], ["one", "two"]);
  });
});

test("readLines: maxBytes truncation sets state.truncated and stops", () => {
  const body = `${"a".repeat(100)}\n${"b".repeat(100)}\n`;
  withFile("t.jsonl", body, (path) => {
    const state = { truncated: false };
    const lines = [...readLines(path, { maxBytes: 50, state })];
    assert.equal(state.truncated, true);
    // Only the prefix within budget is read; no second line.
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "a".repeat(50));
  });
});

test("parseSessionFile: oversized file is parsed as a truncated prefix, not dropped", () => {
  // Two valid codex token_count rows, but the second sits past a tiny budget.
  const row = (i) =>
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":${i},"output_tokens":${i},"total_tokens":${i * 2}}}}}`;
  const body = `${row(100)}\n${"#".repeat(2 * 1024 * 1024)}\n${row(500)}\n`;
  withFile("big.jsonl", body, (path) => {
    // PARSE_MAX_BYTES is 256MB (too large for a unit test), so drive the same
    // budgeted reader parseSessionFile uses with a small maxBytes to prove the
    // in-budget prefix still parses and the overflow is flagged, not dropped.
    const state = { truncated: false };
    const s = parseSessionText("codex", readLines(path, { maxBytes: 1024 * 1024, state }), { filePath: path });
    assert.equal(state.truncated, true);
    // Only the first row (before the 2MB filler) made it in.
    const t = sessionTokenTotals(s);
    assert.equal(t.inputTokens, 100);
  });
});

test("parseSessionFile: read error is observable via onWarn, returns null (no throw)", () => {
  const missing = join(tmpdir(), "asc-does-not-exist-" + Date.now(), "nope.jsonl");
  const warnings = [];
  const s = parseSessionFile({ path: missing, engine: "codex" }, { onWarn: (f, e) => warnings.push(e) });
  assert.equal(s, null);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0] instanceof Error);
});

// ── B5: streaming MUST be byte-identical to the old whole-string path ───────

test("equivalence: string path and streaming path yield identical sessions", () => {
  const codexBody = [
    `{"timestamp":"2026-06-01T00:00:00Z","type":"session_meta","payload":{"id":"eqv","cwd":"/p","cli_version":"1.0","model":"gpt-5.5"}}`,
    `{"timestamp":"2026-06-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":480,"cached_input_tokens":240,"output_tokens":120,"total_tokens":600}}}}`,
    `{"timestamp":"2026-06-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":40,"total_tokens":240}}}}`,
  ].join("\n");
  withFile("eqv.jsonl", codexBody + "\n", (path) => {
    const fromString = parseCodexSession(codexBody, { filePath: path });
    const fromStream = parseCodexSession(readLines(path), { filePath: path });
    assert.deepEqual(fromStream.events, fromString.events);
    assert.deepEqual(sessionTokenTotals(fromStream), sessionTokenTotals(fromString));
    assert.deepEqual(toSnapshot(fromStream), toSnapshot(fromString));
  });

  const claudeBody = [
    `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"hi"},"sessionId":"abc","cwd":"/p","gitBranch":"main"}`,
    `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"id":"m1","role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"yo"}],"usage":{"input_tokens":10,"cache_read_input_tokens":2000,"output_tokens":50}}}`,
  ].join("\n");
  withFile("abc.jsonl", claudeBody + "\n", (path) => {
    const fromString = parseClaudeSession(claudeBody, { filePath: path });
    const fromStream = parseClaudeSession(readLines(path), { filePath: path });
    assert.deepEqual(fromStream.events, fromString.events);
    assert.deepEqual(sessionTokenTotals(fromStream), sessionTokenTotals(fromString));
    assert.deepEqual(toSnapshot(fromStream), toSnapshot(fromString));
  });
});

test("equivalence: reset-aware codex math is preserved under streaming (order-sensitive)", () => {
  // The compaction reset detection depends on strict line order; streaming must
  // keep byte order so previousTotalUsage telescopes identically.
  const body = [
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"output_tokens":50,"total_tokens":300}}}}`,
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}}`,
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"output_tokens":30,"total_tokens":180}}}}`,
  ].join("\n");
  withFile("reset.jsonl", body + "\n", (path) => {
    const a = sessionTokenTotals(parseCodexSession(body, { filePath: path }));
    const b = sessionTokenTotals(parseCodexSession(readLines(path), { filePath: path }));
    assert.deepEqual(b, a);
    // sanity: reset recovered both windows (300 + 180), not just the last.
    assert.equal(b.inputTokens, 250 + 150);
  });
});

test("parseSessionFile end-to-end matches direct engine parse (full path)", () => {
  const body = [
    `{"type":"session_meta","payload":{"id":"e2e","model":"gpt-5.5"}}`,
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}}`,
  ].join("\n");
  withFile("e2e.jsonl", body, (path) => {
    const viaFile = parseSessionFile({ path, engine: "codex" });
    const viaEngine = parseCodexSession(body, { filePath: path });
    assert.deepEqual(viaFile.events, viaEngine.events);
    assert.equal(viaFile.truncated ?? undefined, undefined); // small file: not truncated
  });
});
