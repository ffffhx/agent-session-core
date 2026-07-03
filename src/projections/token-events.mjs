// Projection: NormalizedSession -> TokenUsageEvent[] (open-token-board's contract).
// Each token_usage event becomes one TokenUsageEvent. Totals/cost are computed the
// same way token-board does, so a consumer can drop this in without number drift.

import { basename } from "../util.mjs";
import { DEFAULT_MODEL_PRICING, estimateCostUsd } from "../pricing.mjs";

/**
 * @param {import('../../index.js').NormalizedSession} session
 * @param {object} [ctx] userId/displayName/team/source/tool overrides + pricing
 * @returns {Array<object>} TokenUsageEvent-shaped records
 */
export function toTokenEvents(session, ctx = {}) {
  const pricing = ctx.pricing || DEFAULT_MODEL_PRICING;
  const source = ctx.source || (session.engine === "claude" ? "claude-code" : "codex");
  const tool = ctx.tool || (session.engine === "claude" ? "Claude Code" : "Codex CLI");
  const project = ctx.project || basename(session.cwd) || "";
  const sessionModel = session.model || ctx.model || "unknown";
  const userId = ctx.userId || "local";

  const out = [];
  let seq = 0;
  for (const ev of session.events) {
    if (ev.kind !== "token_usage") continue;
    seq += 1;
    const { input, cached, cacheCreation = 0, output, reasoning } = ev.usage;
    const totalTokens = input + output;
    if (totalTokens <= 0) continue;
    // Prefer the event's own model: sessions can switch models mid-way, and
    // both attribution and pricing must follow the model that served the call.
    const model = ev.model || sessionModel;
    out.push({
      id: `asc:${session.engine}:${session.id}:${seq}`,
      userId,
      displayName: ctx.displayName || userId,
      team: ctx.team || "Friends",
      source,
      tool,
      model,
      project,
      timestamp: ev.ts || session.endedAt || session.startedAt || "",
      inputTokens: input,
      cachedInputTokens: cached,
      cacheCreationInputTokens: cacheCreation,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
      totalTokens,
      costUsd: estimateCostUsd({ model, inputTokens: input, cachedInputTokens: cached, cacheCreationTokens: cacheCreation, outputTokens: output }, pricing),
      sessionId: session.id,
      sessionTitle: session.title || undefined,
    });
  }
  return out;
}

/** Convenience: aggregate one session's token usage (the numbers a leaderboard sums). */
export function sessionTokenTotals(session, ctx = {}) {
  const events = toTokenEvents(session, ctx);
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    records: events.length,
  };
  for (const e of events) {
    totals.inputTokens += e.inputTokens;
    totals.cachedInputTokens += e.cachedInputTokens;
    totals.cacheCreationInputTokens += e.cacheCreationInputTokens;
    totals.outputTokens += e.outputTokens;
    totals.reasoningOutputTokens += e.reasoningOutputTokens;
    totals.totalTokens += e.totalTokens;
    totals.costUsd += e.costUsd;
  }
  return totals;
}
