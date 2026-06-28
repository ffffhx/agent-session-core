// agent-session-core — public API.
// One parse, many projections. Zero runtime dependencies.

export { discoverSessionFiles, defaultRoots, expandHome } from "./discovery.mjs";
export { parseSessionFile, parseSessionText, detectEngine } from "./parse.mjs";
export { parseCodexSession } from "./engines/codex.mjs";
export { parseClaudeSession } from "./engines/claude.mjs";
export { toTokenEvents, sessionTokenTotals } from "./projections/token-events.mjs";
export { toMetrics, grade } from "./projections/metrics.mjs";
export { DEFAULT_MODEL_PRICING, resolvePricing, estimateCostUsd } from "./pricing.mjs";

import { discoverSessionFiles } from "./discovery.mjs";
import { parseSessionFile } from "./parse.mjs";

/**
 * High-level sweep: discover + parse. Returns NormalizedSession[] (newest first).
 * Skips files that fail to read/parse.
 */
export function loadSessions(options = {}) {
  const files = discoverSessionFiles(options);
  const out = [];
  for (const file of files) {
    const session = parseSessionFile(file);
    if (session) out.push(session);
  }
  return out;
}
