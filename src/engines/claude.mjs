// Claude Code engine: ~/.claude/projects/<slug>/<uuid>.jsonl -> NormalizedSession.
//
// A single assistant message is split across multiple content-block rows (thinking
// / text / tool_use) that share one (message.id, requestId); every such row repeats
// the message's FINAL usage (not an increment). So usage is reported once per
// message — token_usage is deduped on that composite key (first-seen wins) to avoid
// counting one message N times. message/tool_call events are still emitted per row.
// input = input_tokens + cache_read + cache_creation (full input); cached = cache_read.

import { toTokenCount, isRecord, safeJsonParse, basename } from "../util.mjs";
import { extractClaudeMessageParts, stringifyClaudeContent, truncateForTitle, isClaudeInjectedUserMessage } from "../text/parts.mjs";

/** @param {string|Iterable<string>} input @param {{filePath:string,mtimeMs?:number,sizeBytes?:number}} fileInfo */
export function parseClaudeSession(input, fileInfo = {}) {
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
  // First-seen-wins dedup for token_usage across an assistant message's blocks.
  const seenUsageKeys = new Set();

  for (const rawLine of asLines(input)) {
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
        if (!firstUser && msgText && !isClaudeInjectedUserMessage(msgText, row)) firstUser = msgText;
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
        // Dedup on (message.id, requestId): the message's blocks each repeat the
        // same final usage. Missing message.id (rare) falls back to per-row count.
        const msgId = typeof message.id === "string" ? message.id : "";
        const reqId = typeof row.requestId === "string" ? row.requestId : "";
        const usageKey = msgId ? `${msgId}:${reqId}` : "";
        if (!usageKey || !seenUsageKeys.has(usageKey)) {
          if (usageKey) seenUsageKeys.add(usageKey);
          session.events.push({ kind: "token_usage", ts, usage });
        }
      }
      continue;
    }
  }

  session.id = sessionIdFromPath(session.filePath);
  session.title = truncateForTitle(aiTitle || lastPrompt || firstUser || "");
  return session;
}

// Accept either a whole-file string (test fixtures / direct callers) or a line
// iterable (the streaming reader). The string path stays byte-identical to before;
// the per-line .trim() above absorbs any \r the reader leaves on.
function asLines(input) {
  return typeof input === "string" ? input.split(/\r?\n/) : input;
}

function claudeUsage(usage) {
  if (!isRecord(usage)) return null;
  const base = toTokenCount(usage.input_tokens);
  const cacheRead = toTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = toTokenCount(usage.cache_creation_input_tokens);
  const input = base + cacheRead + cacheCreation;
  const cached = input > 0 ? Math.min(input, cacheRead) : cacheRead;
  const output = toTokenCount(usage.output_tokens);
  // cacheCreation kept as its own bucket so estimateCostUsd can bill it at the
  // 1.25x write rate; input/cached are unchanged so totals/display don't drift.
  return { input, cached, cacheCreation, output, reasoning: 0 };
}

function sessionIdFromPath(filePath) {
  return basename(filePath).replace(/\.jsonl$/, "");
}
