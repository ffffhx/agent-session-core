import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { toMetrics } from "../src/projections/metrics.mjs";

// A codex session with: 2 human turns, 2 tool calls (1 failed), 1 web search,
// cumulative token snapshots, and a 24h resume gap between turns.
const T0 = Date.parse("2026-06-01T00:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const resume = (h) => new Date(T0 + h * 3600 * 1000).toISOString();

const text = [
  `{"timestamp":"${at(0)}","type":"session_meta","payload":{"id":"s","cwd":"/home/u/proj","model":"gpt-5.5"}}`,
  `{"timestamp":"${at(0)}","type":"event_msg","payload":{"type":"user_message","message":"do a thing"}}`,
  `{"timestamp":"${at(1)}","type":"response_item","payload":{"type":"function_call","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}","call_id":"c1"}}`,
  `{"timestamp":"${at(2)}","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"file.txt"}}`,
  `{"timestamp":"${at(3)}","type":"response_item","payload":{"type":"function_call","name":"Bash","arguments":"nope","call_id":"c2"}}`,
  `{"timestamp":"${at(4)}","type":"response_item","payload":{"type":"function_call_output","call_id":"c2","output":"bash: command not found"}}`,
  `{"timestamp":"${at(5)}","type":"response_item","payload":{"type":"web_search_call"}}`,
  `{"timestamp":"${at(6)}","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":30000,"cached_input_tokens":25000,"output_tokens":1000,"total_tokens":31000}}}}`,
  `{"timestamp":"${resume(24)}","type":"event_msg","payload":{"type":"user_message","message":"resumed next day"}}`,
  `{"timestamp":"${resume(24.001)}","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":60000,"cached_input_tokens":50000,"output_tokens":2000,"total_tokens":62000}}}}`,
].join("\n");

test("metrics: turns / tools / webSearches / model", () => {
  const s = parseCodexSession(text, { filePath: "/x/s.jsonl" });
  const m = toMetrics(s);
  assert.equal(m.model, "gpt-5.5"); // codex model populated (was always "" in agent-retro)
  assert.equal(m.turns, 2);
  assert.equal(m.metrics.toolCount, 2);
  assert.equal(m.metrics.toolFails, 1);
  assert.equal(m.metrics.failRate, 50);
  assert.equal(m.webSearches, 1); // codex web search counted (agent-retro reported 0)
});

test("metrics: tokens telescope across cumulative snapshots", () => {
  const m = toMetrics(parseCodexSession(text, { filePath: "/x/s.jsonl" }));
  assert.equal(m.tokens.input, 60000);
  assert.equal(m.tokens.cached, 50000);
  assert.equal(m.tokens.output, 2000);
  assert.equal(m.tokens.total, 62000);
  assert.equal(m.metrics.cacheRate, 83.3);
});

test("metrics: active duration excludes the 24h resume gap", () => {
  const m = toMetrics(parseCodexSession(text, { filePath: "/x/s.jsonl" }));
  assert.ok(m.metrics.durationMs > 23 * 3600 * 1000, "raw duration includes the gap");
  assert.ok(m.metrics.activeDurationMs < 5 * 60 * 1000, "active duration excludes it");
  assert.ok(m.metrics.activeDurationMs > 0);
});

test("metrics: score penalizes the failed tool call (B), grade follows", () => {
  const m = toMetrics(parseCodexSession(text, { filePath: "/x/s.jsonl" }));
  // input>20k but cacheRate 83% => no cache penalty; failRate 50 => -min(20,30)= -20
  assert.equal(m.score, 80);
  assert.equal(m.grade, "B");
});
