import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexSession } from "../src/engines/codex.mjs";
import { parseClaudeSession } from "../src/engines/claude.mjs";
import { resetAwareTotals, resetAwareDelta, curTotalTokens } from "../src/engines/codex-tokens.mjs";
import { sessionTokenTotals, toTokenEvents } from "../src/projections/token-events.mjs";
import { estimateCostUsd, resolvePricing } from "../src/pricing.mjs";

const usageEvents = (s) => s.events.filter((e) => e.kind === "token_usage").map((e) => e.usage);

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Path-INDEPENDENT reference for the reset-aware math: a reset (running total drops)
// closes a context window, and each window's input+output contribution is just its
// LAST cumulative snapshot (the deltas telescope). Implemented with no shared code
// with codex-tokens.mjs so an equal result genuinely cross-validates the engine.
function windowSumOracle(snapshots) {
  let input = 0;
  let output = 0;
  for (let i = 0; i < snapshots.length; i++) {
    const cur = snapshots[i];
    const next = snapshots[i + 1];
    const windowEnds = !next || n(next.total_tokens) < n(cur.total_tokens);
    if (windowEnds) {
      input += n(cur.input_tokens);
      output += n(cur.output_tokens);
    }
  }
  return { input, output };
}

const sumInOut = (records) => ({
  input: records.reduce((a, r) => a + n(r.input_tokens), 0),
  output: records.reduce((a, r) => a + n(r.output_tokens), 0),
});

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
    { input: 100, cached: 50, cacheCreation: 0, output: 20, reasoning: 5 },
    { input: 150, cached: 70, cacheCreation: 0, output: 40, reasoning: 10 },
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
    { input: 250, cached: 120, cacheCreation: 0, output: 60, reasoning: 15 },
    { input: 80, cached: 40, cacheCreation: 0, output: 10, reasoning: 2 },
  ]);
  const t = sessionTokenTotals(s);
  assert.equal(t.totalTokens, 310 + 90); // naive "last snapshot" would have reported just 90
});

test("codex-tokens: resetAwareTotals cross-checks the path-independent windowSum oracle", () => {
  // Several shapes: monotonic (no reset), 3 resets, reset-then-keep-accumulating.
  const cases = [
    // plain monotonic — telescopes to last snapshot.
    [
      { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      { input_tokens: 250, output_tokens: 60, total_tokens: 310 },
      { input_tokens: 400, output_tokens: 90, total_tokens: 490 },
    ],
    // three resets (totals: 300↓50↑180↓40↑70↓20) -> four windows.
    [
      { input_tokens: 250, output_tokens: 50, total_tokens: 300 },
      { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
      { input_tokens: 150, output_tokens: 30, total_tokens: 180 },
      { input_tokens: 32, output_tokens: 8, total_tokens: 40 },
      { input_tokens: 60, output_tokens: 10, total_tokens: 70 },
      { input_tokens: 16, output_tokens: 4, total_tokens: 20 },
    ],
    // reset, then continue accumulating within the new window (no further reset).
    [
      { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
      { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
      { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
      { input_tokens: 160, output_tokens: 40, total_tokens: 200 },
    ],
  ];
  for (const snaps of cases) {
    assert.deepEqual(sumInOut(resetAwareTotals(snaps)), windowSumOracle(snaps));
  }
});

test("codex-tokens: missing total_tokens is reconstructed, not misread as a reset", () => {
  // The post-turn snapshot omits total_tokens. The OLD code did toNumber(undefined)=0,
  // saw 0 < 1200, declared a reset and counted the WHOLE snapshot (1330) — a reverse
  // over-count. curTotalTokens rebuilds the total from components (1100+230=1330 > 1200)
  // so it is a normal delta of (100, 30).
  const prev = { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 };
  const cur = { input_tokens: 1100, output_tokens: 230 }; // no total_tokens
  assert.equal(curTotalTokens(cur), 1330);
  const [, second] = resetAwareTotals([prev, cur]);
  assert.equal(second.input_tokens, 100);
  assert.equal(second.output_tokens, 230 - 200);
});

test("codex-tokens: resume — a large first snapshot (no prev) is counted whole, never dropped", () => {
  const big = { input_tokens: 50000, cached_input_tokens: 30000, output_tokens: 4000, total_tokens: 54000 };
  const [first] = resetAwareTotals([big]);
  assert.equal(first.input_tokens, 50000);
  assert.equal(first.output_tokens, 4000);
  // Direct single-step form agrees.
  assert.deepEqual(resetAwareDelta(big, {}), {
    input_tokens: 50000,
    cached_input_tokens: 30000,
    output_tokens: 4000,
    reasoning_output_tokens: 0,
    total_tokens: 54000,
  });
});

test("codex: three compaction resets recover every window (no silent under-count)", () => {
  const text = [
    `{"timestamp":"2026-06-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":250,"output_tokens":50,"total_tokens":300}}}}`,
    `{"timestamp":"2026-06-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}}`,
    `{"timestamp":"2026-06-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"output_tokens":30,"total_tokens":180}}}}`,
    `{"timestamp":"2026-06-01T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":32,"output_tokens":8,"total_tokens":40}}}}`,
  ].join("\n");
  const s = parseCodexSession(text, { filePath: "/x/three-reset.jsonl" });
  const t = sessionTokenTotals(s);
  // Windows end at 300, 180, 40 -> Σ input 250+150+32, Σ output 50+30+8.
  assert.equal(t.inputTokens, 250 + 150 + 32);
  assert.equal(t.outputTokens, 50 + 30 + 8);
  // Naive last-snapshot would have reported only the final window (40).
  assert.equal(t.totalTokens, 432 + 88);
});

test("codex: reset then continued accumulation telescopes within the new window", () => {
  const text = [
    `{"timestamp":"2026-06-01T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200,"output_tokens":100,"total_tokens":300}}}}`,
    `{"timestamp":"2026-06-01T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50}}}}`,
    `{"timestamp":"2026-06-01T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":160,"output_tokens":40,"total_tokens":200}}}}`,
  ].join("\n");
  const s = parseCodexSession(text, { filePath: "/x/reset-cont.jsonl" });
  const t = sessionTokenTotals(s);
  // Window 1 ends at 300; window 2 (reset) telescopes 50 -> 200, contributing 200.
  assert.equal(t.inputTokens, 200 + 160);
  assert.equal(t.outputTokens, 100 + 40);
  assert.equal(t.totalTokens, 360 + 140);
});

test("claude: per-message usage splits cache_read vs cache_creation", () => {
  const text = [
    `{"type":"user","timestamp":"2026-06-02T00:00:00Z","message":{"role":"user","content":"hi"},"sessionId":"abc","cwd":"/home/u/proj","gitBranch":"main"}`,
    `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":50}}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  assert.equal(s.model, "claude-opus-4-8");
  assert.equal(s.gitBranch, "main");
  assert.deepEqual(usageEvents(s), [{ input: 2110, cached: 2000, cacheCreation: 100, output: 50, reasoning: 0 }]);
});

test("claude: multi-block message dedups token_usage on (message.id,requestId)", () => {
  // One assistant message split across two content-block rows (thinking + tool_use)
  // sharing message.id + requestId; each row repeats the SAME final usage.
  const usage = `"usage":{"input_tokens":16956,"cache_creation_input_tokens":200,"cache_read_input_tokens":1000,"output_tokens":115}`;
  const text = [
    `{"type":"assistant","requestId":"req_1","timestamp":"2026-06-02T00:00:01Z","message":{"id":"msg_A","role":"assistant","model":"claude-opus-4-8","content":[{"type":"thinking","thinking":"hmm"}],${usage}}}`,
    `{"type":"assistant","requestId":"req_1","timestamp":"2026-06-02T00:00:01Z","message":{"id":"msg_A","role":"assistant","model":"claude-opus-4-8","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],${usage}}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  // token_usage counted once for the message, even though it spans 2 rows.
  assert.equal(usageEvents(s).length, 1);
  const t = sessionTokenTotals(s);
  assert.equal(t.records, 1);
  // input = 16956 + 1000 + 200 = 18156; total = input + output.
  assert.equal(t.totalTokens, 18156 + 115);
});

test("claude: distinct message.id are counted separately (no over-dedup)", () => {
  const text = [
    `{"type":"assistant","requestId":"req_1","timestamp":"2026-06-02T00:00:01Z","message":{"id":"msg_A","role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":5}}}`,
    `{"type":"assistant","requestId":"req_2","timestamp":"2026-06-02T00:00:02Z","message":{"id":"msg_B","role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":20,"output_tokens":7}}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  assert.equal(usageEvents(s).length, 2);
  assert.equal(sessionTokenTotals(s).totalTokens, 10 + 5 + 20 + 7);
});

test("claude: missing message.id falls back to per-line counting", () => {
  const text = [
    `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":10,"output_tokens":5}}}`,
    `{"type":"assistant","timestamp":"2026-06-02T00:00:02Z","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":20,"output_tokens":7}}}`,
  ].join("\n");
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  // No id to dedup on → keep both (never silently drop).
  assert.equal(usageEvents(s).length, 2);
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

test("cost: opus splits base / cache_creation(1.25x) / cache_read, zero on unknown model", () => {
  // input 2110 = base 10 + cache_creation 100 + cache_read 2000.
  const c = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 2110, cachedInputTokens: 2000, cacheCreationTokens: 100, outputTokens: 50 });
  // opus 4.5+ = $5/$25: base 10*5 + cache_creation 100*6.25 + cache_read 2000*0.5 + out 50*25, per 1e6
  assert.ok(Math.abs(c - (10 / 1e6 * 5 + 100 / 1e6 * 6.25 + 2000 / 1e6 * 0.5 + 50 / 1e6 * 25)) < 1e-9);
  assert.equal(estimateCostUsd({ model: "some-local-llm", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 }), 0);
});

test("cost: cache_creation billed at 1.25x write rate, not base", () => {
  // Pure base sanity (no cache at all): 100 base tokens at 5 (opus 4.5+).
  const base = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
  assert.ok(Math.abs(base - (100 / 1e6 * 5)) < 1e-12);
  // Add 100 cache_creation: write bucket priced separately at 6.25 (5*1.25), base unchanged.
  const withWrite = estimateCostUsd({ model: "claude-opus-4-8", inputTokens: 200, cachedInputTokens: 0, cacheCreationTokens: 100, outputTokens: 0 });
  assert.ok(Math.abs(withWrite - (100 / 1e6 * 5 + 100 / 1e6 * 6.25)) < 1e-12);
});

test("cost: cacheWrite defaults to input*1.25 and is overridable per entry", () => {
  // Explicit table cacheWrite for sonnet (3*1.25=3.75) and haiku (1*1.25=1.25).
  const sonnet = estimateCostUsd({ model: "claude-sonnet-4", inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 100, outputTokens: 0 });
  assert.ok(Math.abs(sonnet - (100 / 1e6 * 3.75)) < 1e-12);
  const haiku = estimateCostUsd({ model: "claude-haiku-4", inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 100, outputTokens: 0 });
  assert.ok(Math.abs(haiku - (100 / 1e6 * 1.25)) < 1e-12);
  // Explicit override is honored; absence falls through to the 1.25x default.
  const custom = resolvePricing([{ match: "mymodel", input: 10, cachedInput: 1, cacheWrite: 99, output: 20 }]);
  const overridden = estimateCostUsd({ model: "mymodel", inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 100, outputTokens: 0 }, custom);
  assert.ok(Math.abs(overridden - (100 / 1e6 * 99)) < 1e-12);
  const noWrite = resolvePricing([{ match: "mymodel", input: 10, cachedInput: 1, output: 20 }]);
  const derived = estimateCostUsd({ model: "mymodel", inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 100, outputTokens: 0 }, noWrite);
  assert.ok(Math.abs(derived - (100 / 1e6 * 12.5)) < 1e-12);
});

test("cost: per-model Claude rates match the published table; legacy vs current Opus split", () => {
  const in1m = (model) => estimateCostUsd({ model, inputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 });
  const out1m = (model) => estimateCostUsd({ model, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1_000_000 });
  // Current generation (claude-api skill table, 2026-06-04): $ per MTok input / output.
  assert.equal(in1m("claude-opus-4-8"), 5); assert.equal(out1m("claude-opus-4-8"), 25);
  assert.equal(in1m("claude-opus-4-5"), 5); assert.equal(out1m("claude-opus-4-5"), 25);
  assert.equal(in1m("claude-sonnet-4-6"), 3); assert.equal(out1m("claude-sonnet-4-6"), 15);
  assert.equal(in1m("claude-haiku-4-5"), 1); assert.equal(out1m("claude-haiku-4-5"), 5);
  assert.equal(in1m("claude-fable-5"), 10); assert.equal(out1m("claude-fable-5"), 50);
  assert.equal(in1m("claude-mythos-5"), 10); assert.equal(out1m("claude-mythos-5"), 50);
  // Legacy Opus (3 / 4.0 / 4.1) stays at $15/$75 — must NOT be caught by the 4.5+ arm.
  assert.equal(in1m("claude-opus-4-1-20250805"), 15); assert.equal(out1m("claude-opus-4-1-20250805"), 75);
  assert.equal(in1m("claude-3-opus-20240229"), 15);
  // fable-5 previously matched no arm and cost 0 — guard that regression.
  assert.ok(out1m("claude-fable-5") > 0);
});

test("token event ctx: source/tool default per engine, cost attached", () => {
  const text = `{"type":"assistant","timestamp":"2026-06-02T00:00:01Z","message":{"role":"assistant","model":"gpt-5.5","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1000,"output_tokens":1000}}}`;
  const s = parseClaudeSession(text, { filePath: "/x/abc.jsonl" });
  const [ev] = toTokenEvents(s);
  assert.equal(ev.source, "claude-code");
  assert.equal(ev.totalTokens, 2000);
  assert.ok(ev.costUsd > 0);
});
