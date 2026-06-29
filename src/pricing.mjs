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
  // Anthropic Claude. cacheWrite (cache_creation) bills at 1.25x base (5-min TTL);
  // cachedInput (cache_read) is ~0.1x base. Rates: claude-api skill table, 2026-06-04.
  // Order matters — current-generation arms precede the broad legacy opus fallback,
  // because Opus dropped from $15/$75 (3/4.0/4.1) to $5/$25 (4.5+) and a single
  // /claude.*opus/ arm would misprice 4.5+ by 3x. Fable/Mythos and the 4.5+ Opus
  // arms must come first (estimateCostUsd takes the FIRST matching entry).
  { match: /claude.*fable|claude-mythos/i, input: 10, cachedInput: 1.0, cacheWrite: 12.5, output: 50 },
  { match: /claude.*opus-4-[5-9]|claude.*opus-[5-9]/i, input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
  { match: /claude.*opus/i, input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 }, // legacy: opus 3 / 4.0 / 4.1
  { match: /claude.*sonnet/i, input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  { match: /claude.*haiku/i, input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
];

/**
 * Load a pricing override from JSON (env AGENT_SESSION_PRICING or a path).
 * Entries: { match: "<regex source>", flags?: "i", input, cachedInput, cacheWrite?, output }.
 * cacheWrite is optional ($/MTok for cache_creation); when absent it defaults to
 * input*1.25 inside estimateCostUsd. Falls back to DEFAULT_MODEL_PRICING when absent/invalid.
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
        cacheWrite: e.cacheWrite != null ? Number(e.cacheWrite) || 0 : undefined,
        output: Number(e.output) || 0,
      }))
      .filter((e) => e.match);
    return compiled.length ? compiled : DEFAULT_MODEL_PRICING;
  } catch {
    return DEFAULT_MODEL_PRICING;
  }
}

/**
 * Estimate cost in USD. Faithful to token-board's estimateCostUsd, with a fourth
 * cache-WRITE bucket: both cachedInputTokens (cache_read) and cacheCreationTokens
 * (cache_write) are subsets of inputTokens, so the full rate is charged only on the
 * uncached/non-creation remainder, the discounted read rate on the cached portion,
 * and the write rate (entry.cacheWrite, default input*1.25) on cache_creation.
 * Unknown model → 0 (no silent guess).
 *
 * INVARIANT: callers must pass inputTokens = base + cache_read + cache_creation
 * (as claudeUsage builds it). If a future refactor makes inputTokens the uncached
 * remainder, drop the two subtractions below in lockstep or cost undercounts.
 */
export function estimateCostUsd({ model, inputTokens, cachedInputTokens, cacheCreationTokens, outputTokens }, pricing = DEFAULT_MODEL_PRICING) {
  const entry = pricing.find((item) => item.match.test(model || ""));
  if (!entry) return 0;
  const cc = cacheCreationTokens || 0;
  const billableInput = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0) - cc);
  const cacheWriteRate = entry.cacheWrite ?? entry.input * 1.25;
  return (
    (billableInput / 1_000_000) * entry.input +
    ((cachedInputTokens || 0) / 1_000_000) * entry.cachedInput +
    (cc / 1_000_000) * cacheWriteRate +
    ((outputTokens || 0) / 1_000_000) * entry.output
  );
}
