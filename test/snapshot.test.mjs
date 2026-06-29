import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { parseClaudeSession } from "../src/engines/claude.mjs";
import { toSnapshot } from "../src/projections/snapshot.mjs";
import { sessionTokenTotals } from "../src/projections/token-events.mjs";

const codexText = [
  `{"timestamp":"2026-06-01T00:00:00Z","type":"session_meta","payload":{"id":"s","cwd":"/home/u/proj","model":"gpt-5.5"}}`,
  `{"timestamp":"2026-06-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"text","text":"permissions preamble"}]}}`,
  `{"timestamp":"2026-06-01T00:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"<goal_context><objective>Ship the thing</objective></goal_context>"}]}}`,
  `{"timestamp":"2026-06-01T00:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"please run ls"}]}}`,
  `{"timestamp":"2026-06-01T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"Bash","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"c1"}}`,
  `{"timestamp":"2026-06-01T00:00:05Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"file.txt"}}`,
  `{"timestamp":"2026-06-01T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"total_tokens":120}}}}`,
].join("\n");

test("snapshot/codex: developer + bootstrap dropped, goal lifted, tool turns built", () => {
  const snap = toSnapshot(parseCodexSession(codexText, { filePath: "/x/s.jsonl" }), { includeTools: true });
  assert.equal(snap.engine, "codex");
  assert.equal(snap.engineLabel, "Codex");
  assert.equal(snap.goalObjective, "Ship the thing");
  assert.equal(snap.turns.some((t) => t.role === "developer"), false);

  const messages = snap.turns.filter((t) => t.kind === "message");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].turn, 1);
  assert.equal(messages[0].text, "please run ls");

  const call = snap.turns.find((t) => t.kind === "tool" && t.name === "Bash");
  assert.ok(call.text.startsWith("Tool call: Bash"));
  assert.equal(call.turn, 1); // tool turns attach to the current message turn

  const out = snap.turns.find((t) => t.name === "function_output");
  assert.equal(out.text, "Tool output hidden. Re-run with output enabled to include it.");
  assert.equal(snap.tokenUsage.totalTokens, 120);
});

test("snapshot/codex: includeToolOutput reveals output", () => {
  const snap = toSnapshot(parseCodexSession(codexText, { filePath: "/x/s.jsonl" }), { includeTools: true, includeToolOutput: true });
  assert.equal(snap.turns.find((t) => t.name === "function_output").text, "file.txt");
});

test("snapshot: injected renderHtml + redactText are applied to message turns", () => {
  const snap = toSnapshot(parseCodexSession(codexText, { filePath: "/x/s.jsonl" }), {
    redact: true,
    redactText: (t) => t.replaceAll("ls", "[REDACTED]"),
    renderHtml: (t) => `<p>${t}</p>`,
  });
  const msg = snap.turns.find((t) => t.kind === "message");
  assert.equal(msg.text, "please run [REDACTED]");
  assert.equal(msg.html, "<p>please run [REDACTED]</p>");
  assert.equal(snap.redacted, true);
});

test("fixture/codex: multi-reset rollout totals are frozen (naive last-snapshot would collapse 5.47x)", () => {
  // Synthetic 6-reset rollout (test/fixtures/codex-multi-reset.jsonl), mimicking the
  // 019e76be shape. The reset-aware sum recovers every compaction window; the naive
  // "last total_token_usage" method (codex_usage / agent-retro) would report only the
  // final window. This frozen baseline turns any silent regression of the reset branch
  // back to naive into a red test instead of a 5.47x under-count nobody notices.
  const path = fileURLToPath(new URL("./fixtures/codex-multi-reset.jsonl", import.meta.url));
  const text = readFileSync(path, "utf8");
  const s = parseCodexSession(text, { filePath: path });
  const t = sessionTokenTotals(s);

  // FROZEN baseline — do not "fix" these by relaxing the reset branch.
  assert.equal(t.records, 14);
  assert.equal(t.inputTokens, 7880);
  assert.equal(t.outputTokens, 1970);
  assert.equal(t.totalTokens, 9850); // input + output, 7 telescoping windows
  assert.equal(t.cachedInputTokens, 3940);
  assert.ok(Math.abs(t.costUsd - 0.08077) < 1e-9);

  // The naive last-snapshot method (final cumulative input+output) is 5.47x smaller.
  const naiveLast = 1440 + 360; // last total_token_usage snapshot
  assert.equal(naiveLast, 1800);
  assert.ok(t.totalTokens > naiveLast * 5, "reset-aware must dwarf naive last-snapshot");
  assert.ok(Math.abs(t.totalTokens / naiveLast - 5.472) < 0.01);
});

test("snapshot/claude: title skips meta caveat + injected command rows, takes real prompt", () => {
  const text = [
    `{"type":"user","isMeta":true,"timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands."},"sessionId":"abc"}`,
    `{"type":"user","timestamp":"2026-06-02T00:00:01Z","message":{"role":"user","content":"<command-name>/model</command-name>"},"sessionId":"abc"}`,
    `{"type":"user","timestamp":"2026-06-02T00:00:02Z","message":{"role":"user","content":"fix the flaky test"},"sessionId":"abc"}`,
  ].join("\n");
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }));
  assert.equal(snap.title, "fix the flaky test");
});

test("snapshot/claude: pure slash-command session yields empty title (not caveat)", () => {
  const text = [
    `{"type":"user","isMeta":true,"timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands."},"sessionId":"abc"}`,
    `{"type":"user","timestamp":"2026-06-02T00:00:01Z","message":{"role":"user","content":"<local-command-stdout>done</local-command-stdout>"},"sessionId":"abc"}`,
  ].join("\n");
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }));
  assert.equal(snap.title, "");
});

test("snapshot/claude: sidechain subagent prompt is not used as title", () => {
  const text = [
    `{"type":"user","isSidechain":true,"timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"You are a subagent. Do X."},"sessionId":"abc"}`,
  ].join("\n");
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }));
  assert.equal(snap.title, "");
});

test("snapshot/claude: dedup only affects token_usage, transcript keeps all blocks", () => {
  const usage = `"usage":{"input_tokens":100,"cache_creation_input_tokens":40,"cache_read_input_tokens":0,"output_tokens":5}`;
  const text = [
    `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"go"},"sessionId":"abc"}`,
    `{"type":"assistant","requestId":"r1","timestamp":"2026-06-02T00:00:01Z","message":{"id":"m1","role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"thinking out loud"}],${usage}}}`,
    `{"type":"assistant","requestId":"r1","timestamp":"2026-06-02T00:00:01Z","message":{"id":"m1","role":"assistant","model":"claude-opus-4-8","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],${usage}}}`,
  ].join("\n");
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }), { includeTools: true });
  // token usage not doubled: input 100 + cache_creation 40 = 140; total = 140 + 5.
  assert.equal(snap.tokenUsage.totalTokens, 140 + 5);
  assert.equal(snap.tokenUsage.cacheCreationInputTokens, 40);
  // but both the assistant text turn and the tool turn survive.
  assert.ok(snap.turns.some((t) => t.kind === "message" && t.text === "thinking out loud"));
  assert.ok(snap.turns.some((t) => t.kind === "tool" && t.name === "Bash"));
});

test("snapshot/claude: base64 image becomes an inline data: attachment on the turn", () => {
  const text = `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"sessionId":"abc"}`;
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }));
  const msg = snap.turns.find((t) => t.kind === "message");
  assert.equal(msg.text, "look at this");
  assert.equal(msg.images.length, 1);
  assert.ok(msg.images[0].src.startsWith("data:image/png;base64,"));
});
