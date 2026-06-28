// Small zero-dependency helpers shared across engines and projections.

/** Finite number or 0 (no clamp). Mirrors token-board's toNumber. */
export function toNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Non-negative finite integer, else 0. Used for token fields. */
export function toTokenCount(value) {
  const n = toNumber(value);
  return n > 0 ? Math.round(n) : 0;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.parse a single line, returning undefined on any failure. */
export function safeJsonParse(line) {
  if (typeof line !== "string" || line.length === 0) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** basename without requiring node:path (keeps the module trivially portable). */
export function basename(p) {
  if (typeof p !== "string" || !p) return "";
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Flatten a Codex/Claude "content" value (string | array of parts | record)
 * into plain text. Bounded recursion so a pathological log can't blow the stack.
 */
export function flattenText(value, depth = 0) {
  if (depth > 12) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join("");
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.input_text === "string") return value.input_text;
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.content === "string") return value.content;
    if (value.content !== undefined) return flattenText(value.content, depth + 1);
  }
  return "";
}

/** ISO string passthrough; anything non-string becomes "". */
export function isoOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Heuristic: did a Codex function_call_output indicate failure?
 * Codex has no structured is_error, so we sniff the output text — same spirit as
 * agent-retro's looksFailed, kept conservative to avoid false positives.
 */
export function codexOutputLooksFailed(outputText) {
  if (typeof outputText !== "string" || !outputText) return false;
  const head = outputText.slice(0, 400).toLowerCase();
  return (
    /\b(command failed|exit code [1-9]|exit status [1-9]|traceback \(most recent|fatal:|error:|errno)\b/.test(head) ||
    /\bnpm err!|\bbun(?:x)? error\b/.test(head)
  );
}
