// Model pricing, externalized from source. token-board hardcodes this table in
// token-leaderboard.ts:169; here it is data you can override (env / JSON) without
// editing code or redeploying — one of the agreed optimizations.
//
// Units: USD per 1,000,000 tokens. Order matters: estimateCostUsd takes the FIRST
// matching entry, so cheaper mini/nano variants must precede their flagship arms,
// and broad arms use word boundaries so they cannot swallow lighter siblings.

export const DEFAULT_MODEL_PRICING = [
  // OpenAI gpt-5 family — mini/nano variants (any suffix depth) first
  { match: /gpt-5.*\b(mini|nano)\b/i, input: 0.75, cachedInput: 0.075, output: 4.5 },
  { match: /gpt-5\.5/i, input: 5, cachedInput: 0.5, output: 30 },
  { match: /gpt-5\.4/i, input: 2.5, cachedInput: 0.25, output: 15 },
  { match: /gpt-5(\.[0-3])?\b/i, input: 1.25, cachedInput: 0.125, output: 10 },
  // OpenAI o-series reasoning models
  { match: /\bo[34](-mini)?\b/i, input: 1.1, cachedInput: 0.275, output: 4.4 },
  // OpenAI gpt-4 family
  { match: /gpt-4\.1.*\b(mini|nano)\b/i, input: 0.4, cachedInput: 0.1, output: 1.6 },
  { match: /gpt-4\.1/i, input: 2, cachedInput: 0.5, output: 8 },
  { match: /gpt-4o-mini/i, input: 0.15, cachedInput: 0.075, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, cachedInput: 1.25, output: 10 },
  // Anthropic Claude
  { match: /claude.*opus/i, input: 15, cachedInput: 1.5, output: 75 },
  { match: /claude.*sonnet/i, input: 3, cachedInput: 0.3, output: 15 },
  { match: /claude.*haiku/i, input: 0.8, cachedInput: 0.08, output: 4 },
];

/**
 * Load a pricing override from JSON (env AGENT_SESSION_PRICING or a path).
 * Entries: { match: "<regex source>", flags?: "i", input, cachedInput, output }.
 * Falls back to DEFAULT_MODEL_PRICING when absent/invalid.
 */
export function resolvePricing(override) {
  if (!override) return DEFAULT_MODEL_PRICING;
  try {
    const raw = typeof override === "string" ? JSON.parse(override) : override;
    if (!Array.isArray(raw)) return DEFAULT_MODEL_PRICING;
    const compiled = raw
      .map((e) => ({
        match: e.match instanceof RegExp ? e.match : new RegExp(String(e.match), e.flags ?? "i"),
        input: Number(e.input) || 0,
        cachedInput: Number(e.cachedInput) || 0,
        output: Number(e.output) || 0,
      }))
      .filter((e) => e.match);
    return compiled.length ? compiled : DEFAULT_MODEL_PRICING;
  } catch {
    return DEFAULT_MODEL_PRICING;
  }
}

/**
 * Estimate cost in USD. Faithful to token-board's estimateCostUsd:
 * cachedInputTokens is a subset of inputTokens, so the full rate is charged only
 * on the uncached remainder and the discounted rate on the cached portion.
 * Unknown model → 0 (no silent guess).
 */
export function estimateCostUsd({ model, inputTokens, cachedInputTokens, outputTokens }, pricing = DEFAULT_MODEL_PRICING) {
  const entry = pricing.find((item) => item.match.test(model || ""));
  if (!entry) return 0;
  const billableInput = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0));
  return (
    (billableInput / 1_000_000) * entry.input +
    ((cachedInputTokens || 0) / 1_000_000) * entry.cachedInput +
    ((outputTokens || 0) / 1_000_000) * entry.output
  );
}
