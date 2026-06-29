// Reset-aware Codex token math — extracted so the engine AND the parity/oracle
// checks share ONE implementation of the cumulative→per-turn delta. Keeping the
// formula in a single place is the whole point: the reset branch is the one piece
// that has no naturally-failing invariant, so it must not be re-typed inline.
//
// total_token_usage is a cumulative snapshot. Per-turn consumption is a field-wise
// max(0, cur-prev) delta, EXCEPT on context-compaction resets where the running
// total shrinks — there a plain delta would zero-out (drop) the whole post-reset
// turn, so the entire snapshot is counted instead. The telescoping sum of a no-reset
// run therefore equals the last snapshot; each reset opens a new window that again
// telescopes to its own last snapshot (see windowSum oracle in the tests/parity).

import { toNumber } from "../util.mjs";

export const DELTA_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];

/**
 * Robust running total used for reset detection. Codex normally emits total_tokens,
 * but if it is absent we reconstruct it from the component fields. Treating a missing
 * total_tokens as toNumber(undefined)===0 would make a normal turn look like a reset
 * (cur 0 < prev big) and over-count the whole snapshot — exactly the field-level
 * fragility ccusage guards against.
 * @param {Record<string, unknown>|undefined} usage
 */
export function curTotalTokens(usage) {
  if (!usage) return 0;
  if (usage.total_tokens != null && Number.isFinite(Number(usage.total_tokens))) {
    return toNumber(usage.total_tokens);
  }
  return toNumber(usage.input_tokens) + toNumber(usage.output_tokens) + toNumber(usage.reasoning_output_tokens);
}

/** Field-wise non-negative delta (saturating_sub, like ccusage's subtract). */
function tokenUsageDelta(current, previous) {
  const out = {};
  for (const field of DELTA_FIELDS) {
    out[field] = Math.max(0, toNumber(current[field]) - toNumber(previous[field]));
  }
  return out;
}

/**
 * One cumulative snapshot → the raw usage record to count for its turn, given the
 * previous snapshot. Returns the whole snapshot on a reset, else the field-wise delta.
 * A reset is only declared when the running total truly shrinks from a POSITIVE
 * baseline; prevTotal===0 (first snapshot, or a prev with no usable total) is a normal
 * first turn, never a reset.
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} previous
 */
export function resetAwareDelta(current, previous) {
  const curTotal = curTotalTokens(current);
  const prevTotal = curTotalTokens(previous);
  const isReset = prevTotal > 0 && curTotal < prevTotal;
  return isReset ? current : tokenUsageDelta(current, previous);
}

/**
 * Fold resetAwareDelta over a full sequence of cumulative total_token_usage snapshots,
 * yielding the per-turn raw usage records. The engine consumes snapshots incrementally
 * via resetAwareDelta; this array form is the single reference the tests/parity assert
 * against (and cross-check with a path-independent windowSum oracle).
 * @param {Array<Record<string, unknown>>} snapshots
 */
export function resetAwareTotals(snapshots) {
  const out = [];
  let previous = {};
  for (const snap of snapshots) {
    out.push(resetAwareDelta(snap, previous));
    previous = snap || {};
  }
  return out;
}
