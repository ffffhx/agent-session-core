// parse: read a session file and dispatch to the right engine.

import { parseCodexSession } from "./engines/codex.mjs";
import { parseClaudeSession } from "./engines/claude.mjs";
import { readLines, PARSE_MAX_BYTES } from "./read-lines.mjs";
import { safeJsonParse, isRecord } from "./util.mjs";

/** Detect engine from a single sample line when the source root is unknown. */
export function detectEngine(sampleLine) {
  const row = safeJsonParse(sampleLine);
  if (!isRecord(row)) return null;
  if (row.type === "session_meta" || row.payload !== undefined) return "codex";
  if (typeof row.sessionId === "string" || row.type === "user" || row.type === "assistant") return "claude";
  return null;
}

// Marker-scan: find the engine from the first parseable JSONL line rather than a
// single fixed-position slice. This fixes a whole class of misdetection — a
// single-line file with no trailing newline (the old `slice(0, indexOf("\n")=-1)`
// dropped the closing brace and returned null), a leading blank / preamble line, or
// a \r\n line ending. Bounded to the first few non-empty lines so we never scan a
// huge file just to pick an engine.
const DETECT_MAX_LINES = 8;
function detectEngineFromFile(path) {
  let scanned = 0;
  for (const raw of readLines(path, { maxBytes: 1024 * 1024 })) {
    if (scanned >= DETECT_MAX_LINES) break;
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue; // skip blank / preamble lines
    scanned += 1;
    const engine = detectEngine(line);
    if (engine) return engine;
  }
  return null;
}

/** Parse raw text (or a line iterable) for a known engine. */
export function parseSessionText(engine, input, fileInfo = {}) {
  if (engine === "codex") return parseCodexSession(input, fileInfo);
  if (engine === "claude") return parseClaudeSession(input, fileInfo);
  throw new Error(`unknown engine: ${engine}`);
}

/**
 * Parse a discovered file ({ path, engine, mtimeMs, sizeBytes }).
 * Returns null on read/detect failure rather than throwing, so a bad file can't
 * abort a sweep. Pass { onWarn(file, err) } to observe what was skipped and why
 * (read errors, near-MAX_STRING_LENGTH RangeError, ENOMEM) instead of silently
 * losing the session.
 */
export function parseSessionFile(file, opts = {}) {
  const onWarn = typeof opts.onWarn === "function" ? opts.onWarn : null;

  // Path-driven engine (from discovery) is the first source of truth; content
  // detection is only a fallback when the engine is unknown.
  let engine = file.engine;
  if (!engine) {
    try {
      engine = detectEngineFromFile(file.path);
    } catch (err) {
      if (onWarn) onWarn(file, err);
      return null;
    }
  }
  if (!engine) return null;

  // Stream the file line-by-line under a hard byte budget instead of slurping it
  // whole: no 3.4x RSS blow-up, and no near-512MB RangeError that the old bare
  // `catch { return null }` swallowed into a silent dropped session.
  const state = { truncated: false };
  try {
    const session = parseSessionText(engine, readLines(file.path, { maxBytes: PARSE_MAX_BYTES, state }), {
      filePath: file.path,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
    });
    if (state.truncated) session.truncated = true;
    return session;
  } catch (err) {
    if (onWarn) onWarn(file, err);
    return null;
  }
}
