// Claude Code engine: ~/.claude/projects/<slug>/<uuid>.jsonl -> NormalizedSession.
//
// Unlike Codex, Claude reports usage per assistant message (already incremental),
// so no cumulative-delta is needed — each assistant row's usage is one token event.
// input = input_tokens + cache_read + cache_creation (full input); cached = cache_read.

import { toTokenCount, isRecord, safeJsonParse, basename } from "../util.mjs";
import { extractClaudeMessageParts, stringifyClaudeContent, truncateForTitle } from "../text/parts.mjs";

/** @param {string} text @param {{filePath:string,mtimeMs?:number,sizeBytes?:number}} fileInfo */
export function parseClaudeSession(text, fileInfo = {}) {
  const session = {
    engine: "claude",
    id: "",
    filePath: fileInfo.filePath || "",
    cwd: "",
    model: "",
    version: "",
    gitBranch: "",
    startedAt: "",
    endedAt: "",
    mtimeMs: fileInfo.mtimeMs ?? 0,
    sizeBytes: fileInfo.sizeBytes ?? 0,
    title: "",
    goalObjective: "",
    events: [],
  };

  let aiTitle = "";
  let lastPrompt = "";
  let firstUser = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const row = safeJsonParse(line);
    if (!isRecord(row)) continue;

    const type = typeof row.type === "string" ? row.type : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    if (ts) {
      if (!session.startedAt) session.startedAt = ts;
      session.endedAt = ts;
    }
    if (typeof row.cwd === "string" && row.cwd) session.cwd = row.cwd;
    if (typeof row.version === "string") session.version = row.version;
    if (typeof row.gitBranch === "string" && row.gitBranch) session.gitBranch = row.gitBranch;

    // Title side-channels.
    if (type === "ai-title") {
      if (typeof row.aiTitle === "string" && row.aiTitle) aiTitle = row.aiTitle;
      continue;
    }
    if (type === "last-prompt") {
      if (typeof row.lastPrompt === "string" && row.lastPrompt) lastPrompt = row.lastPrompt;
      continue;
    }

    // Compaction markers (schema not fully stable across versions — match loosely).
    if (
      row.isCompactSummary === true ||
      (type === "system" && typeof row.subtype === "string" && /compact/i.test(row.subtype))
    ) {
      session.events.push({ kind: "compaction", ts });
      continue;
    }

    const message = isRecord(row.message) ? row.message : null;

    if (type === "user" && message) {
      const { text: msgText, images, toolResults } = extractClaudeMessageParts(message);
      // Tool results arrive as user rows; surface them as tool_result, not turns.
      for (const tr of toolResults) {
        session.events.push({ kind: "tool_result", ts, name: tr.toolUseId, callId: tr.toolUseId, ok: !tr.isError, outputText: tr.text });
      }
      if (msgText || images.length) {
        session.events.push({
          kind: "message",
          ts,
          role: "user",
          text: msgText,
          images,
          isSidechain: row.isSidechain === true,
          isMeta: row.isMeta === true,
        });
        if (!firstUser && msgText) firstUser = msgText;
      }
      continue;
    }

    if (type === "assistant" && message) {
      if (typeof message.model === "string" && message.model && !session.model) session.model = message.model;
      const { text: msgText, images, toolCalls } = extractClaudeMessageParts(message);
      if (msgText || images.length) {
        session.events.push({ kind: "message", ts, role: "assistant", text: msgText, images });
      }
      for (const tc of toolCalls) {
        session.events.push({
          kind: "tool_call",
          ts,
          name: tc.name,
          args: stringifyClaudeContent(tc.input ?? {}),
          callId: tc.id || undefined,
        });
      }
      const usage = claudeUsage(message.usage);
      if (usage && usage.input + usage.output > 0) {
        session.events.push({ kind: "token_usage", ts, usage });
      }
      continue;
    }
  }

  session.id = sessionIdFromPath(session.filePath);
  session.title = truncateForTitle(aiTitle || lastPrompt || firstUser || "");
  return session;
}

function claudeUsage(usage) {
  if (!isRecord(usage)) return null;
  const base = toTokenCount(usage.input_tokens);
  const cacheRead = toTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = toTokenCount(usage.cache_creation_input_tokens);
  const input = base + cacheRead + cacheCreation;
  const cached = input > 0 ? Math.min(input, cacheRead) : cacheRead;
  const output = toTokenCount(usage.output_tokens);
  return { input, cached, output, reasoning: 0 };
}

function sessionIdFromPath(filePath) {
  return basename(filePath).replace(/\.jsonl$/, "");
}
