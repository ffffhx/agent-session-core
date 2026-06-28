# agent-session-core

Unified parser for local AI-coding session logs (`~/.codex` and `~/.claude`).
**One parse, many projections** — so token boards, retrospectives, and transcript
viewers stop each re-implementing (and drifting on) the same JSONL parsing.

> Why this exists, the field-level ground truth, and the migration plan live in
> [DESIGN.md](./DESIGN.md). Zero runtime dependencies; ships JS + `.d.ts`.

## Quick look

```bash
node bin/agent-sessions.mjs recent --days 2     # recent sessions w/ tokens + cost
node bin/agent-sessions.mjs totals --days 7     # aggregate usage
node scripts/parity-codex.mjs --days 30         # verify token math vs the naive method
node --test                                     # unit tests
```

## API

```js
import { loadSessions, parseSessionFile, toTokenEvents, sessionTokenTotals } from "agent-session-core";

const sessions = loadSessions({ sinceMs: 7 * 864e5 });        // NormalizedSession[]
for (const s of sessions) {
  const events = toTokenEvents(s, { userId: "me" });          // open-token-board's TokenUsageEvent[]
  const totals = sessionTokenTotals(s);                       // { totalTokens, costUsd, ... }
}
```

### `NormalizedSession`

A session is `{ engine, id, cwd, model, startedAt, endedAt, title, events[] }`.
`events` is one ordered timeline of a discriminated union:
`message | tool_call | tool_result | token_usage | compaction | web_search | reasoning`.

Token usage is normalized to the same meaning across engines (`input` is the full
input incl. cache; `cached` is the discounted-read subset; `total = input + output`).
Codex cumulative snapshots are turned into reset-aware per-turn deltas, so context
compaction no longer silently drops a turn's tokens.

## Status

Increment 1: discovery + codex/claude parse + **token-events projection** (verified
against real logs — 508/508 parity on no-reset Codex sessions). Next: metrics
projection (agent-retro), snapshot projection + privacy (codex-snapshots), then wire
the consumers to drop their duplicate parsers. See DESIGN.md §5.
