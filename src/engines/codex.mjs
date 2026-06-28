// Codex engine: ~/.codex/sessions/**/rollout-*.jsonl -> NormalizedSession.
//
// The token math is a faithful port of open-token-board's
// token-usage-collector.ts (the ONE correct implementation): total_token_usage is
// a cumulative snapshot, so per-turn consumption is a field-wise max(0, cur-prev)
// delta, except on context-compaction resets where the whole turn is counted.

import { toNumber, toTokenCount, isRecord, safeJsonParse, codexOutputLooksFailed, basename } from "../util.mjs";
import {
  extractCodexMessageParts,
  extractInternalGoalObjective,
  isBootstrapUserMessage,
  truncateForTitle,
  stringifyClaudeContent,
} from "../text/parts.mjs";

const DELTA_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];

function tokenUsageDelta(current, previous) {
  const out = {};
  for (const field of DELTA_FIELDS) {
    out[field] = Math.max(0, toNumber(current[field]) - toNumber(previous[field]));
  }
  return out;
}

/** @param {string} text @param {{filePath:string,mtimeMs?:number,sizeBytes?:number}} fileInfo */
export function parseCodexSession(text, fileInfo = {}) {
  const session = {
    engine: "codex",
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

  let currentModel = "";
  let previousTotalUsage = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const row = safeJsonParse(line);
    if (!isRecord(row)) continue;

    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    if (ts) {
      if (!session.startedAt) session.startedAt = ts;
      session.endedAt = ts;
    }

    const type = typeof row.type === "string" ? row.type : "";
    const payload = isRecord(row.payload) ? row.payload : {};
    const ptype = typeof payload.type === "string" ? payload.type : "";

    if (type === "session_meta") {
      if (typeof payload.id === "string" && payload.id) session.id = payload.id;
      if (typeof payload.cwd === "string") session.cwd = payload.cwd;
      if (typeof payload.cli_version === "string") session.version = payload.cli_version;
      if (typeof payload.git_branch === "string") session.gitBranch = payload.git_branch;
      if (typeof payload.model === "string" && payload.model) currentModel = payload.model;
      continue;
    }

    if (type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) currentModel = payload.model;
      if (typeof payload.cwd === "string" && payload.cwd) session.cwd = payload.cwd;
      continue;
    }

    if (type === "event_msg") {
      if (ptype === "token_count") {
        const info = isRecord(payload.info) ? payload.info : {};
        const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
        let raw;
        if (totalUsage) {
          // Reset-aware: compaction shrinks the running total; a plain delta would
          // zero (drop) the post-compaction turn — count the whole turn instead.
          const isReset = toNumber(totalUsage.total_tokens) < toNumber(previousTotalUsage.total_tokens);
          raw = isReset ? totalUsage : tokenUsageDelta(totalUsage, previousTotalUsage);
          previousTotalUsage = totalUsage;
        } else if (isRecord(info.last_token_usage)) {
          raw = info.last_token_usage;
        }
        if (raw) {
          const usage = normalizeCodexUsage(raw);
          if (usage.input + usage.output > 0) {
            session.events.push({ kind: "token_usage", ts, usage });
          }
        }
        continue;
      }
      if (ptype && /compact/i.test(ptype)) {
        session.events.push({ kind: "compaction", ts });
      }
      continue;
    }

    if (type === "response_item") {
      // The conversation transcript lives on response_item messages (richer than
      // event_msg echoes — they carry image content blocks).
      if (ptype === "message") {
        const role = typeof payload.role === "string" ? payload.role : "assistant";
        const { text: msgText, images } = extractCodexMessageParts(payload);
        const goal = extractInternalGoalObjective(msgText);
        if (goal && !session.goalObjective) session.goalObjective = goal;
        const internal = isBootstrapUserMessage(role, msgText);
        session.events.push({ kind: "message", ts, role, text: msgText, images, internal });
        if (!internal && role === "user" && !session.title && msgText) session.title = truncateForTitle(msgText);
      } else if (ptype === "function_call") {
        session.events.push({
          kind: "tool_call",
          ts,
          name: typeof payload.name === "string" ? payload.name : "function_call",
          args: typeof payload.arguments === "string" ? payload.arguments : "",
          callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
        });
      } else if (ptype === "function_call_output") {
        const outputText = typeof payload.output === "string" ? payload.output : stringifyClaudeContent(payload.output);
        session.events.push({
          kind: "tool_result",
          ts,
          name: "function_output",
          callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
          ok: !codexOutputLooksFailed(payload.output),
          outputText,
        });
      } else if (ptype === "web_search_call") {
        const action = isRecord(payload.action) ? payload.action : {};
        const query =
          typeof action.query === "string" ? action.query
            : typeof action.url === "string" ? action.url
              : typeof payload.status === "string" ? payload.status
                : "completed";
        session.events.push({ kind: "web_search", ts, query });
      } else if (ptype === "reasoning") {
        session.events.push({ kind: "reasoning", ts });
      }
      continue;
    }
  }

  if (!session.id) session.id = sessionIdFromPath(session.filePath);
  session.model = currentModel;
  return session;
}

/** Map a raw Codex usage record (or its delta) to the unified token shape. */
function normalizeCodexUsage(raw) {
  const input = toTokenCount(raw.input_tokens);
  const output = toTokenCount(raw.output_tokens);
  const reasoning = toTokenCount(raw.reasoning_output_tokens);
  // cachedInputTokens is a subset of inputTokens (token-board clamps the same way).
  const cachedRaw = toTokenCount(raw.cached_input_tokens);
  const cached = input > 0 ? Math.min(input, cachedRaw) : cachedRaw;
  return { input, cached, output, reasoning };
}

function sessionIdFromPath(filePath) {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : name;
}
