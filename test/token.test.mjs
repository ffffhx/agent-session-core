import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { parseClaudeSession } from "../src/engines/claude.mjs";
import { sessionTokenTotals, toTokenEvents } from "../src/projections/token-events.mjs";
import { estimateCostUsd } from "../src/pricing.mjs";

const usageEvents = (s) => s.events.filter((e) => e.kind === "token_usage").map((e) => e.usage);

test("codex: cumulative snapshots become per-turn deltas", () => {
  const text = [
    `{"timestamp":"2026-06-01T00:00:00Z","type":"session_meta","payload":{"id":"sess-1","cwd":"/home/u/proj","cli_version":"1.0","model":"gpt-5.5"}}`,
    `{"timestamp":"2026-06-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120}}}}`,
    `{"timestamp":"2026-06-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"cached_input_tokens":120,"output_tokens":60,"reasoning_output_tokens":15,"total_tokens":310}}}}`,
  ].join("\n");
  const s = parseCodexSession(text, { filePath: "/x/sess-1.jsonl" });
  assert.equal(s.model, "gpt-5.5");
  assert.equal(s.id, "sess-1");
  assert.deepEqual(usageEvents(s), [
    { input: 100, cached: 50, output: 20, reasoning: 5 },
    { input: 150, cached: 70, output: 40, reasoning: 10 },
  ]);
  const t = sessionTokenTotals(s);
  assert.equal(t.inputTokens, 250);
  assert.equal(t.outputTokens, 60);
  assert.equal(t.totalTokens, 310); // input+output, telescopes to last snapshot
});

test("codex: compaction reset counts the whole post-reset turn (no under-count)", () => {
  const text = [
    `{"timestamp":"2026-06-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"cached_input_tokens":120,"output_tokens":60,"reasoning_output_tokens":15,"total_tokens":310}}}}`,
    `{"timestamp":"2026-06-01T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":80,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":90}}}}`,
  ].join("\n");
  const s = parseCodexSession(text, { filePath: "/x/sess-2.jsonl" });
  // second snapshot's total (90) < first (310) => reset => count it whole, not a negative delta
  assert.deepEqual(usageEvents(s), [
    { input: 250, cached: 120, output: 60, reasoning: 15 },
    { input: 80, cached: 40, output: 10, reasoning: 2 },
  ]);
  const t = sessionTokenTotals(s);
  assert.equal(t.totalTokens, 310 + 90); // naive "last snapshot" would have reported just 90
});

test("claude: per-message usage splits cache_read vs cache_creation", () => {
  const text = [
    `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"hi"},"sessionId":"abc","cwd":"/home/u/proj","gitBranch":"main"}`,
    `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":50}}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  assert.equal(s.model, "claude-opus-4-8");
  assert.equal(s.gitBranch, "main");
  assert.deepEqual(usageEvents(s), [{ input: 2110, cached: 2000, output: 50, reasoning: 0 }]);
});

test("claude: structured is_error drives tool_result.ok", () => {
  const text = [
    `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":5,"output_tokens":5}}}`,
    `{"type":"user","timestamp":"2026-06-02T00:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"boom"}]}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  const call = s.events.find((e) => e.kind === "tool_call");
  const result = s.events.find((e) => e.kind === "tool_result");
  assert.equal(call.name, "Bash");
  assert.equal(result.ok, false);
  assert.equal(result.callId, "t1");
});

test("cost: opus charges full rate on uncached, discounted on cached, zero on unknown model", () => {
  const c = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 2110, cachedInputTokens: 2000, outputTokens: 50 });
  // billable 110*15 + cached 2000*1.5 + out 50*75, per 1e6
  assert.ok(Math.abs(c - (110 / 1e6 * 15 + 2000 / 1e6 * 1.5 + 50 / 1e6 * 75)) < 1e-9);
  assert.equal(estimateCostUsd({ model: "some-local-llm", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 }), 0);
});

test("token event ctx: source/tool default per engine, cost attached", () => {
  const text = `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","model":"gpt-5.5","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1000,"output_tokens":1000}}}`;
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  const [ev] = toTokenEvents(s);
  assert.equal(ev.source, "claude-code");
  assert.equal(ev.totalTokens, 2000);
  assert.ok(ev.costUsd > 0);
});
