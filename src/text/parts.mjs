// Transcript content extraction — text, images, tool calls/results — for both
// engines. Ported faithfully from codex-snapshots' local-history.mts so the
// snapshot projection reconstructs the same turns from the unified event stream.
// Zero external dependencies (node:path only).

import { extname } from "node:path";

export const MAX_TEXT_CHARS = 20000;
export const TOOL_OUTPUT_PREVIEW_CHARS = 24000;
export const MAX_INLINE_IMAGE_CHARS = 5_000_000;
export const MAX_TURNS = 5000;

export function trimLongText(text, maxChars = MAX_TEXT_CHARS) {
  if (!text || text.length <= maxChars) return text || "";
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

export function truncateForTitle(text) {
  const singleLine = String(text || "").replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function stripImageMarkers(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*<\/?image>\s*$/i.test(line))
    .join("\n")
    .trim();
}

// Strip Codex/Claude inline image markers (`<image …>`, `</image>`, including
// attributed forms like `<image name=… path=…>`) for title derivation, so an
// image-first message does not become an "<image path=…>" title (which also
// leaked the temp file path). Returns the remaining human text, collapsed.
export function stripImageTagsForTitle(text) {
  return String(text || "")
    .replace(/<\/?image\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSafeImageSource(src) {
  if (!src) return false;
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src) || /^https?:\/\//i.test(src);
}

function imageMimeType(src) {
  const match = src.match(/^data:(image\/[^;,]+)[;,]/i);
  if (match) return match[1].toLowerCase();
  if (/^https?:\/\//i.test(src)) {
    const clean = src.split(/[?#]/)[0] || "";
    const ext = extname(clean).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".png") return "image/png";
    if (ext === ".gif") return "image/gif";
    if (ext === ".webp") return "image/webp";
  }
  return "image";
}

function imageSourceSize(src) {
  const comma = src.indexOf(",");
  if (!src.startsWith("data:") || comma === -1) return "";
  const base64 = src.slice(comma + 1).replace(/\s/g, "");
  const padding = base64.match(/=+$/)?.[0].length || 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return formatBytes(bytes);
}

function buildImage(src, index, detail = "") {
  const safe = isSafeImageSource(src);
  const tooLarge = src.length > MAX_INLINE_IMAGE_CHARS;
  return {
    alt: `Image attachment ${index}`,
    detail,
    mimeType: imageMimeType(src),
    size: imageSourceSize(src),
    src: safe && !tooLarge ? src : "",
    unavailableReason: !safe ? "Unsupported image source" : tooLarge ? `Image is larger than ${formatBytes(MAX_INLINE_IMAGE_CHARS)}` : "",
  };
}

// ---- Codex ----

function extractCodexImage(content, index) {
  const src = typeof content.image_url === "string"
    ? content.image_url.trim()
    : typeof content.imageUrl === "string"
      ? content.imageUrl.trim()
      : typeof content.url === "string"
        ? content.url.trim()
        : "";
  if (!src && content.type !== "input_image") return null;
  return buildImage(src, index, typeof content.detail === "string" ? content.detail : "");
}

/** Codex response_item message payload -> { text, images }. */
export function extractCodexMessageParts(item) {
  const parts = [];
  const images = [];
  const rawContent = item?.content;
  const contentList = Array.isArray(rawContent)
    ? rawContent
    : typeof rawContent === "string"
      ? [{ text: rawContent }]
      : [];
  for (const content of contentList) {
    if (!content || typeof content !== "object") continue;
    if (typeof content.text === "string") {
      const text = stripImageMarkers(content.text);
      if (text) parts.push(text);
    }
    const image = extractCodexImage(content, images.length + 1);
    if (image) images.push(image);
  }
  return { text: trimLongText(parts.join("\n\n")), images };
}

export function isInternalCodexContextMessage(text) {
  return /^<goal_context>\s*[\s\S]*<\/goal_context>\s*$/i.test(String(text || "").trim());
}

export function isBootstrapUserMessage(role, text) {
  return role === "user" && (
    text.startsWith("# AGENTS.md instructions for ") ||
    text.includes("<environment_context>") ||
    isInternalCodexContextMessage(text)
  );
}

export function extractInternalGoalObjective(text) {
  const value = String(text || "").trim();
  if (!isInternalCodexContextMessage(value)) return "";
  const match = value.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  return match ? trimLongText(match[1].trim()) : "";
}

// ---- Claude ----

export function stringifyClaudeContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        return JSON.stringify(item, null, 2);
      })
      .join("\n\n");
  }
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value || "");
}

function extractClaudeImage(item, index) {
  if (item?.type !== "image") return null;
  const source = item.source || {};
  const src = source.type === "base64" && source.data
    ? `data:${source.media_type || "image/png"};base64,${source.data}`
    : source.type === "url"
      ? source.url || ""
      : "";
  return buildImage(src, index, "");
}

/** Claude message -> { text, images, toolCalls:[{name,id,input}], toolResults:[{toolUseId,text,isError}] }. */
export function extractClaudeMessageParts(message) {
  const parts = [];
  const images = [];
  const toolCalls = [];
  const toolResults = [];
  const content = message?.content;

  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (typeof item?.text === "string" && (item.type === "text" || !item.type)) {
        parts.push(item.text);
        continue;
      }
      const image = extractClaudeImage(item, images.length + 1);
      if (image) {
        images.push(image);
        continue;
      }
      if (item?.type === "tool_use") {
        toolCalls.push({ name: item.name || "tool_use", id: item.id || "", input: item.input });
        continue;
      }
      if (item?.type === "tool_result") {
        toolResults.push({
          toolUseId: item.tool_use_id || "tool_result",
          text: trimLongText(stringifyClaudeContent(item.content), TOOL_OUTPUT_PREVIEW_CHARS),
          isError: item.is_error === true,
        });
      }
    }
  }

  return { text: trimLongText(parts.join("\n\n").trim()), images, toolCalls, toolResults };
}

// Claude injects non-user-authored "user" rows (slash-command caveat/meta lines,
// command-name/stdout echoes, system reminders) and sidechain/subagent prompts.
// These must not become the session title — mirror Codex's isBootstrapUserMessage
// guard. Keep the prefix list loose and centralized here so new markers are easy
// to add. `row` carries the structural flags (isMeta/isSidechain are on the row,
// NOT the message).
const CLAUDE_INJECTED_PREFIX =
  /^(<command-name>|<command-message>|<command-args>|<local-command-(caveat|stdout|stderr)>|<system-reminder>|<bash-(input|stdout|stderr)>)/i;
const CLAUDE_CAVEAT = /^(<local-command-caveat>)?\s*Caveat: The messages below were generated/i;

export function isClaudeInjectedUserMessage(text, row) {
  const t = String(text || "").trim();
  const meta = Boolean(row && (row.isMeta === true || row.isSidechain === true));
  return meta || CLAUDE_INJECTED_PREFIX.test(t) || CLAUDE_CAVEAT.test(t);
}

export function normalizeClaudeTimestamp(value) {
  if (!value) return "";
  if (typeof value === "number") return new Date(value).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}
