// Projection: NormalizedSession -> codex-snapshots' Snapshot (full transcript).
// Reconstructs the same turns codex-snapshots' local-history.mts builds, but from
// the unified event stream — so its 3079-line per-engine parser can be deleted.
//
// Stays zero-dependency by taking the html renderer / redactor / risk detector as
// injected callbacks: codex-snapshots passes its markdown-it + privacy functions,
// other callers get text-only turns. The transcript renderer already falls back to
// turn.text when turn.html is absent, so html is optional.

import { trimLongText, TOOL_OUTPUT_PREVIEW_CHARS, MAX_TURNS } from "../text/parts.mjs";

const ENGINE_LABELS = { codex: "Codex", claude: "Claude Code" };

/**
 * @param {import('../../index.js').NormalizedSession} session
 * @param {{
 *   includeTools?: boolean, includeToolOutput?: boolean, redact?: boolean,
 *   generatedAt?: string,
 *   renderHtml?: (text: string) => string,
 *   redactText?: (text: string) => string,
 *   detectRisks?: (text: string) => Array<{ id: string, label: string, severity: string }>,
 * }} [opts]
 */
export function toSnapshot(session, opts = {}) {
  const includeTools = opts.includeTools !== false;
  const includeToolOutput = opts.includeToolOutput === true;
  const redact = opts.redact === true;
  const renderHtml = typeof opts.renderHtml === "function" ? opts.renderHtml : null;
  const redactText = redact && typeof opts.redactText === "function" ? opts.redactText : (t) => t;
  const detectRisks = typeof opts.detectRisks === "function" ? opts.detectRisks : null;
  // Optional risk finding accrued once per image in an image-bearing message
  // (caller-defined id/label/severity). Lets redaction consumers flag attachments
  // the text scanner can't see — mirrors local-history's addImageRisk.
  const imageRiskFinding = opts.imageRiskFinding && typeof opts.imageRiskFinding === "object" && opts.imageRiskFinding.id
    ? opts.imageRiskFinding
    : null;

  const turns = [];
  const riskMap = new Map();
  let turnNumber = 0;
  let truncated = false;

  let inTok = 0, cachedTok = 0, cacheCreationTok = 0, outTok = 0, reasoningTok = 0, tokenUpdatedAt = "";

  for (const ev of session.events) {
    if (turns.length >= MAX_TURNS) {
      truncated = true;
      break;
    }
    switch (ev.kind) {
      case "token_usage":
        inTok += ev.usage.input; cachedTok += ev.usage.cached; cacheCreationTok += ev.usage.cacheCreation || 0; outTok += ev.usage.output; reasoningTok += ev.usage.reasoning;
        if (ev.ts) tokenUpdatedAt = ev.ts;
        break;
      case "message": {
        if (ev.internal) break; // Codex bootstrap / goal-context — lifted, not rendered
        if (ev.role !== "user" && ev.role !== "assistant") break; // developer/system preambles aren't transcript turns
        const images = ev.images || [];
        const rawText = ev.text || "";
        if (!rawText.trim() && !images.length) break;
        turnNumber += 1;
        if (detectRisks) accumulateRisks(riskMap, detectRisks(rawText), turnNumber);
        if (imageRiskFinding && images.length) {
          for (let i = 0; i < images.length; i++) accumulateRisks(riskMap, [imageRiskFinding], turnNumber);
        }
        const text = redactText(rawText);
        turns.push({
          kind: "message",
          role: ev.role,
          turn: turnNumber,
          text,
          html: renderHtml ? renderHtml(text) : undefined,
          images,
          timestamp: ev.ts,
        });
        break;
      }
      case "tool_call": {
        if (!includeTools) break;
        // Scan the SAME rendered text we display (trimmed; pre-redact), then redact
        // for display — mirrors local-history renderToolText + addRisks(rawText)
        // gated by includeTools. Tool-call args are shown regardless of includeToolOutput.
        const raw = `Tool call: ${ev.name || "unknown"}\n${trimLongText(stringifyArgs(ev.args), TOOL_OUTPUT_PREVIEW_CHARS)}`;
        if (detectRisks) accumulateRisks(riskMap, detectRisks(raw), turnNumber || 1);
        turns.push({ kind: "tool", role: "tool", name: ev.name, turn: turnNumber || 1, text: redactText(raw), timestamp: ev.ts });
        break;
      }
      case "tool_result": {
        if (!includeTools) break;
        // Output text is gated by includeToolOutput; when hidden, the placeholder
        // carries no risk — matching local-history (it scans the hidden placeholder).
        const raw = includeToolOutput
          ? trimLongText(ev.outputText || "", TOOL_OUTPUT_PREVIEW_CHARS)
          : "Tool output hidden. Re-run with output enabled to include it.";
        if (detectRisks) accumulateRisks(riskMap, detectRisks(raw), turnNumber || 1);
        turns.push({ kind: "tool", role: "tool", name: ev.name || "function_output", turn: turnNumber || 1, text: redactText(raw), timestamp: ev.ts });
        break;
      }
      case "web_search": {
        if (!includeTools) break;
        const raw = `Web search: ${ev.query || "completed"}`;
        if (detectRisks) accumulateRisks(riskMap, detectRisks(raw), turnNumber || 1);
        turns.push({ kind: "tool", role: "tool", name: "web_search", turn: turnNumber || 1, text: redactText(raw), timestamp: ev.ts });
        break;
      }
    }
  }

  const hasTokens = inTok + outTok > 0;
  const snapshot = {
    id: session.id,
    ref: `${session.engine}:${session.id}`,
    title: redactText(session.title || ""),
    engine: session.engine,
    engineLabel: ENGINE_LABELS[session.engine] || session.engine,
    sourceDetail: "full transcript",
    goalObjective: redactText(session.goalObjective || "") || undefined,
    cwd: session.cwd,
    displayCwd: redactText(session.cwd || ""),
    filePath: session.filePath,
    displayFilePath: redactText(session.filePath || ""),
    generatedAt: opts.generatedAt,
    redacted: redact,
    size: session.sizeBytes,
    turnCount: turns.length,
    tokenUsage: hasTokens
      ? {
          inputTokens: inTok,
          cachedInputTokens: cachedTok,
          cacheCreationInputTokens: cacheCreationTok,
          outputTokens: outTok,
          reasoningOutputTokens: reasoningTok,
          totalTokens: inTok + outTok,
          updatedAt: tokenUpdatedAt,
        }
      : undefined,
    turns,
    risks: [...riskMap.values()].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    notices: truncated
      ? [{ severity: "medium", label: "Truncated", text: `This session is very large; only the first ${MAX_TURNS} entries are shown.` }]
      : [],
  };
  return snapshot;
}

function stringifyArgs(args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? "", null, 2);
  } catch {
    return "";
  }
}

function accumulateRisks(map, findings, turn) {
  if (!Array.isArray(findings)) return;
  for (const f of findings) {
    if (!f || !f.id) continue;
    const entry = map.get(f.id) || { id: f.id, label: f.label || f.id, severity: f.severity || "low", count: 0, turns: [] };
    entry.count += 1;
    if (!entry.turns.includes(turn)) entry.turns.push(turn);
    map.set(f.id, entry);
  }
}

function severityRank(severity) {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}
