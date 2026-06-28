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

// Codex exec output has no exit code, so failures are sniffed from the first chunk
// of output. Markers + 1200-char window mirror agent-retro's looksFailed exactly so
// the unified parser reproduces its failure rate (conservative: under-count, never
// flag a command that merely prints the word "error").
const CODEX_ERROR_MARKERS = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\bnot a git repository\b/i,
  /\bfatal:/i,
  /\berror:/i,
  /\bTraceback \(most recent call last\)/,
  /\bException\b/,
  /\bnpm ERR!/,
  /\bexit code: [1-9]/i,
  /\bexit status [1-9]/i,
];

/** @param {unknown} output raw payload.output (stringified, like agent-retro). */
export function codexOutputLooksFailed(output) {
  if (output == null || output === "") return false;
  const head = String(output).slice(0, 1200);
  return CODEX_ERROR_MARKERS.some((re) => re.test(head));
}
