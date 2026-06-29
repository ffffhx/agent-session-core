// Shared session-file discovery. Today every consumer re-implements this walk
// with slightly different depth / mtime / size / skip rules; this is the single
// version they should all share.

import { homedir } from "node:os";
import { readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SKIP_DIRS = new Set([
  "node_modules", ".git", "Cache", "cache", "tmp", "logs",
  // Claude side-channels that are not top-level user sessions:
  "subagents", "workflows", "tool-results", "memory",
]);

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Default roots, per engine. Override via options.roots. */
export function defaultRoots() {
  return {
    codex: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    claude: ["~/.claude/projects"],
  };
}

/**
 * Recursively collect *.jsonl files under the given roots.
 * @returns Array<{ path, engine, mtimeMs, sizeBytes }> sorted by mtime desc.
 */
export function discoverSessionFiles(options = {}) {
  const {
    roots = defaultRoots(),
    sinceMs = null,        // only files modified within the last N ms (null = no window)
    minBytes = 0,
    // Admission filter only. The real hard cap is PARSE_MAX_BYTES in read-lines.mjs
    // (< V8's MAX_STRING_LENGTH): the parser streams + truncates, so an admitted huge
    // file is bounded there rather than slurped whole. Files past PARSE_MAX_BYTES are
    // parsed as a truncated prefix (session.truncated = true), not OOM'd or dropped.
    maxBytes = 512 * 1024 * 1024,
    maxDepth = 8,
    maxFiles = Infinity,
    skipDirs = DEFAULT_SKIP_DIRS,
    now = Date.now(),
  } = options;

  const cutoff = sinceMs == null ? null : now - sinceMs;
  const seenReal = new Set();
  const out = [];

  for (const [engine, engineRoots] of Object.entries(roots)) {
    for (const root of engineRoots) {
      walk(expandHome(root), engine, 0);
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return Number.isFinite(maxFiles) ? out.slice(0, maxFiles) : out;

  function walk(dir, engine, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full, engine, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      // Claude per-agent transcripts / journals are not user sessions.
      if (engine === "claude" && (/^agent-.*\.jsonl$/.test(entry.name) || entry.name === "journal.jsonl")) continue;

      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const mtimeMs = st.mtimeMs;
      const sizeBytes = st.size;
      if (cutoff != null && mtimeMs < cutoff) continue;
      if (sizeBytes < minBytes || sizeBytes > maxBytes) continue;

      let real;
      try {
        real = realpathSync(full);
      } catch {
        real = full;
      }
      if (seenReal.has(real)) continue;
      seenReal.add(real);

      out.push({ path: full, engine, mtimeMs, sizeBytes });
    }
  }
}
