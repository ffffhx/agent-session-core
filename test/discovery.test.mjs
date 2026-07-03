import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSessionFiles, defaultRoots } from "../src/discovery.mjs";

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

// Orca hardlink-mirrors ~/.codex sessions into its runtime home. Scanning both
// roots must count the file once — realpath can't dedup hardlinks, (dev,ino) can.
test("discovery: a hardlinked session reached via two roots is discovered once", () => {
  const root = mkdtempSync(join(tmpdir(), "asc-disc-"));
  try {
    const a = join(root, "home-a", "sessions");
    const b = join(root, "home-b", "sessions");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "rollout-1.jsonl"), "{}\n");
    linkSync(join(a, "rollout-1.jsonl"), join(b, "rollout-1.jsonl"));
    writeFileSync(join(b, "rollout-2.jsonl"), "{}\n"); // b-only session

    const found = discoverSessionFiles({ roots: { codex: [a, b] } }).map((f) => f.path);
    assert.equal(found.length, 2, "hardlinked mirror counted once, unique file kept");
    assert.ok(found.some((p) => p.endsWith("rollout-2.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// $CODEX_HOME moves where the Codex CLI writes sessions (Orca sets it); default
// discovery must follow it, and always include the Orca runtime home for
// processes that don't inherit the env (launchd, cron).
test("defaultRoots: codex honours $CODEX_HOME and includes the Orca runtime home", () => {
  const prev = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "/custom/codex-home";
    const roots = defaultRoots().codex;
    assert.ok(roots.includes("~/.codex/sessions"));
    assert.ok(roots.includes(join("/custom/codex-home", "sessions")));
    assert.ok(roots.some((r) => r.includes("orca/codex-runtime-home/home/sessions")));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});
