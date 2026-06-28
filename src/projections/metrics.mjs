// Projection: NormalizedSession -> per-session efficiency metrics + 0-100 score.
// Reproduces agent-retro's analyzeSession (so its report/score stay stable) while
// fixing the engine-asymmetry bugs at the source:
//   - durationMs no longer = end-start (resume gaps inflated it to ~44h); we also
//     expose activeDurationMs = wall time minus idle/resume gaps.
//   - codex tokens come from reset-aware deltas (compaction no longer under-counts).
//   - codex webSearches now counted (agent-retro queried the wrong event → always 0).
//   - model is populated for codex.

const DEFAULT_IDLE_GAP_MS = 5 * 60 * 1000; // gaps longer than this are "away", not work

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10; // one decimal, like agent-retro
}

function detectLoops(toolCalls) {
  const counts = new Map();
  for (const call of toolCalls) {
    const key = `${call.name}::${String(call.args).replace(/\s+/g, " ").trim()}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const loops = [];
  for (const [key, count] of counts) {
    if (count >= 3) {
      const [name] = key.split("::");
      loops.push({ name, count, sample: key.split("::").slice(1).join("::").slice(0, 120) });
    }
  }
  return loops.sort((a, b) => b.count - a.count);
}

/** Pair tool_call events with their tool_result by callId; orphan calls default ok. */
function collectToolCalls(events) {
  const okByCall = new Map();
  for (const ev of events) {
    if (ev.kind === "tool_result" && ev.callId != null) okByCall.set(ev.callId, ev.ok);
  }
  const calls = [];
  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    const ok = ev.callId != null && okByCall.has(ev.callId) ? okByCall.get(ev.callId) : true;
    calls.push({ name: ev.name || "tool", args: ev.args ?? "", ok });
  }
  return calls;
}

/** Wall time minus idle/resume gaps — the fix for end-start inflating resumes to ~44h. */
function activeDuration(events, idleGapMs) {
  const stamps = [];
  for (const ev of events) {
    const t = ev.ts ? new Date(ev.ts).getTime() : NaN;
    if (Number.isFinite(t)) stamps.push(t);
  }
  stamps.sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap > 0 && gap <= idleGapMs) active += gap;
  }
  return active;
}

export function toMetrics(session, options = {}) {
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;

  let input = 0, cached = 0, output = 0, reasoning = 0;
  let turns = 0, compactions = 0, webSearches = 0, reasoningBlocks = 0;
  for (const ev of session.events) {
    switch (ev.kind) {
      case "token_usage":
        input += ev.usage.input; cached += ev.usage.cached; output += ev.usage.output; reasoning += ev.usage.reasoning;
        break;
      case "message":
        if (ev.role === "user" && !ev.isSidechain) turns += 1;
        break;
      case "compaction": compactions += 1; break;
      case "web_search": webSearches += 1; break;
      case "reasoning": reasoningBlocks += 1; break;
    }
  }
  const tokens = { input, cached, output, reasoning, total: input + output };

  const toolCalls = collectToolCalls(session.events);
  const toolCount = toolCalls.length;
  const toolFails = toolCalls.filter((c) => c.ok === false).length;
  const loops = detectLoops(toolCalls);
  const loopCalls = loops.reduce((sum, l) => sum + l.count, 0);

  const cacheRate = pct(tokens.cached, tokens.input);
  const failRate = pct(toolFails, toolCount);
  const reasoningRate = pct(tokens.reasoning, tokens.output);

  const durationMs =
    session.startedAt && session.endedAt
      ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
      : 0;
  const activeDurationMs = activeDuration(session.events, idleGapMs);

  const { score, deductions } = scoreSession({ tokens, cacheRate, failRate, toolFails, toolCount, loops, loopCalls, compactions, reasoningRate });

  return {
    engine: session.engine,
    id: session.id,
    cwd: session.cwd,
    project: basename(session.cwd),
    model: session.model,
    gitBranch: session.gitBranch,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    title: session.title,
    tokens,
    turns,
    compactions,
    webSearches,
    reasoningBlocks,
    score,
    grade: grade(score),
    deductions,
    metrics: {
      durationMs,
      activeDurationMs,
      toolCount,
      toolFails,
      failRate,
      cacheRate,
      reasoningRate,
      loops,
      loopCalls,
      tokensPerTurn: turns ? Math.round(tokens.total / turns) : tokens.total,
    },
  };
}

// Scoring is a line-for-line port of agent-retro's analyzeSession penalties, so a
// session's score is unchanged except where the underlying numbers were wrong.
function scoreSession({ tokens, cacheRate, failRate, toolFails, toolCount, loops, loopCalls, compactions, reasoningRate }) {
  const deductions = [];
  let score = 100;

  if (tokens.input > 20000 && cacheRate < 60) {
    const d = Math.min(25, Math.round((60 - cacheRate) * 0.5));
    score -= d;
    deductions.push({ reason: `缓存复用率偏低 (${cacheRate}%)`, points: d });
  }
  if (failRate > 0) {
    const d = Math.min(20, Math.round(failRate * 0.6));
    if (d > 0) {
      score -= d;
      deductions.push({ reason: `工具调用失败率 ${failRate}% (${toolFails}/${toolCount})`, points: d });
    }
  }
  if (loopCalls > 0) {
    const d = Math.min(25, loopCalls * 3);
    score -= d;
    deductions.push({ reason: `检测到 ${loops.length} 个重复调用循环 (共 ${loopCalls} 次)`, points: d });
  }
  if (compactions > 0) {
    const d = Math.min(20, compactions * 8);
    score -= d;
    deductions.push({ reason: `上下文被压缩 ${compactions} 次`, points: d });
  }
  if (tokens.output > 2000 && reasoningRate > 120) {
    const d = Math.min(15, Math.round((reasoningRate - 120) * 0.05));
    if (d > 0) {
      score -= d;
      deductions.push({ reason: `推理 token 远超产出 (${reasoningRate}%)`, points: d });
    }
  }

  return { score: Math.max(0, Math.min(100, score)), deductions };
}

export function grade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function basename(p) {
  if (!p) return "";
  const c = p.replace(/[\\/]+$/, "");
  const i = Math.max(c.lastIndexOf("/"), c.lastIndexOf("\\"));
  return i >= 0 ? c.slice(i + 1) : c;
}
