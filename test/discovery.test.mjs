import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessionFiles } from "../src/discovery.mjs";

// Subagent transcripts (.../subagents/workflows/**/agent-*.jsonl) are real per-agent
// token spend but not top-level user sessions. Excluded by default (viewers/status
// bars don't want them); token-accounting consumers opt in. journal.jsonl is the
// workflow orchestration log and is never a session, opt-in or not.
test("discovery: subagent transcripts excluded by default, included on opt-in; journal always excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "asc-disc-"));
  try {
    const proj = join(root, "projects", "p1");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "session.jsonl"), "{}\n");
    writeFileSync(join(proj, "agent-abc.jsonl"), "{}\n"); // top-level subagent transcript
    writeFileSync(join(proj, "journal.jsonl"), "{}\n");
    const wf = join(proj, "subagents", "workflows", "wf_1");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "agent-deep.jsonl"), "{}\n"); // nested under skipped dirs
    const roots = { claude: [join(root, "projects")] };

    const def = discoverSessionFiles({ roots }).map((f) => f.path);
    assert.ok(def.some((p) => p.endsWith("session.jsonl")), "regular session always discovered");
    assert.ok(!def.some((p) => p.includes("agent-")), "agent-*.jsonl excluded by default");
    assert.ok(!def.some((p) => p.endsWith("journal.jsonl")), "journal.jsonl excluded");
    assert.ok(!def.some((p) => p.includes("subagents")), "subagents/ dir skipped by default");

    const inc = discoverSessionFiles({ roots, includeSubagentTranscripts: true }).map((f) => f.path);
    assert.ok(inc.some((p) => p.endsWith("session.jsonl")), "regular session still discovered on opt-in");
    assert.ok(inc.some((p) => p.endsWith("agent-abc.jsonl")), "top-level agent-*.jsonl included on opt-in");
    assert.ok(inc.some((p) => p.endsWith("agent-deep.jsonl")), "nested subagents/workflows transcript included on opt-in");
    assert.ok(!inc.some((p) => p.endsWith("journal.jsonl")), "journal.jsonl still excluded on opt-in");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
