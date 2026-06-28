// parse: read a session file and dispatch to the right engine.

import { readFileSync } from "node:fs";
import { parseCodexSession } from "./engines/codex.mjs";
import { parseClaudeSession } from "./engines/claude.mjs";
import { safeJsonParse, isRecord } from "./util.mjs";

/** Detect engine from a single sample line when the source root is unknown. */
export function detectEngine(sampleLine) {
  const row = safeJsonParse(sampleLine);
  if (!isRecord(row)) return null;
  if (row.type === "session_meta" || row.payload !== undefined) return "codex";
  if (typeof row.sessionId === "string" || row.type === "user" || row.type === "assistant") return "claude";
  return null;
}

/** Parse raw text for a known engine. */
export function parseSessionText(engine, text, fileInfo = {}) {
  if (engine === "codex") return parseCodexSession(text, fileInfo);
  if (engine === "claude") return parseClaudeSession(text, fileInfo);
  throw new Error(`unknown engine: ${engine}`);
}

/**
 * Parse a discovered file ({ path, engine, mtimeMs, sizeBytes }).
 * Returns null on read failure rather than throwing, so a bad file can't abort a sweep.
 */
export function parseSessionFile(file) {
  let text;
  try {
    text = readFileSync(file.path, "utf8");
  } catch {
    return null;
  }
  const engine = file.engine || detectEngine(text.slice(0, text.indexOf("\n")));
  if (!engine) return null;
  return parseSessionText(engine, text, {
    filePath: file.path,
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
  });
}
