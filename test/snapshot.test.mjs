import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { parseClaudeSession } from "../src/engines/claude.mjs";
import { toSnapshot } from "../src/projections/snapshot.mjs";

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

test("snapshot/claude: base64 image becomes an inline data: attachment on the turn", () => {
  const text = `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"sessionId":"abc"}`;
  const snap = toSnapshot(parseClaudeSession(text, { filePath: "/x/abc.jsonl" }));
  const msg = snap.turns.find((t) => t.kind === "message");
  assert.equal(msg.text, "look at this");
  assert.equal(msg.images.length, 1);
  assert.ok(msg.images[0].src.startsWith("data:image/png;base64,"));
});
