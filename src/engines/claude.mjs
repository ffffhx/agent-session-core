// Claude Code engine: ~/.claude/projects/<slug>/<uuid>.jsonl -> NormalizedSession.
//
// Unlike Codex, Claude reports usage per assistant message (already incremental),
// so no cumulative-delta is needed — each assistant row's usage is one token event.
// input = input_tokens + cache_read + cache_creation (full input); cached = cache_read.

import { toNumber, toTokenCount, isRecord, safeJsonParse } from "../util.mjs";
import { basename } from "../util.mjs";

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
      const { text: msgText } = splitClaudeContent(message.content);
      // Tool results arrive as user rows; surface them as tool_result, not turns.
      for (const tr of toolResultsFrom(message.content)) {
        session.events.push({ kind: "tool_result", ts, callId: tr.callId, ok: tr.ok });
      }
      if (msgText) {
        session.events.push({
          kind: "message",
          ts,
          role: "user",
          text: msgText,
          isSidechain: row.isSidechain === true,
          isMeta: row.isMeta === true,
        });
        if (!firstUser) firstUser = msgText;
      }
      continue;
    }

    if (type === "assistant" && message) {
      if (typeof message.model === "string" && message.model && !session.model) session.model = message.model;
      const { text: msgText, toolUses, reasoningCount } = splitClaudeContent(message.content);
      if (msgText) {
        session.events.push({ kind: "message", ts, role: "assistant", text: msgText });
      }
      for (let i = 0; i < reasoningCount; i += 1) session.events.push({ kind: "reasoning", ts });
      for (const tu of toolUses) {
        session.events.push({ kind: "tool_call", ts, name: tu.name, args: tu.args, callId: tu.callId });
        if (/^web(search|fetch)$/i.test(tu.name)) session.events.push({ kind: "web_search", ts });
      }
      const usage = claudeUsage(message.usage);
      if (usage && usage.input + usage.output > 0) {
        session.events.push({ kind: "token_usage", ts, usage });
      }
      continue;
    }
  }

  session.id = sessionIdFromPath(session.filePath);
  session.title = truncate(aiTitle || lastPrompt || firstUser || "", 80);
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

/** Pull plain text, tool_use calls, and a thinking-block count out of a content value. */
function splitClaudeContent(content) {
  if (typeof content === "string") return { text: content, toolUses: [], reasoningCount: 0 };
  if (!Array.isArray(content)) return { text: "", toolUses: [], reasoningCount: 0 };
  let text = "";
  const toolUses = [];
  let reasoningCount = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += (text ? "\n" : "") + block.text;
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      reasoningCount += 1;
    } else if (block.type === "tool_use") {
      toolUses.push({
        name: typeof block.name === "string" ? block.name : "",
        args: safeStringify(block.input),
        callId: typeof block.id === "string" ? block.id : undefined,
      });
    }
  }
  return { text, toolUses, reasoningCount };
}

function toolResultsFrom(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_result") {
      out.push({
        callId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        ok: block.is_error !== true,
      });
    }
  }
  return out;
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function sessionIdFromPath(filePath) {
  return basename(filePath).replace(/\.jsonl$/, "");
}
