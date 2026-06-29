// Type definitions for agent-session-core (zero-dependency JS implementation).

export type Engine = "codex" | "claude";

export type NormalizedTokenUsage = {
  /** Full input incl. cache (codex: Δinput_tokens; claude: input + cache_read + cache_creation). */
  input: number;
  /** Discounted cached-read subset of input. */
  cached: number;
  /** Cache-write (cache_creation) subset of input; billed at the cacheWrite rate (codex: 0). */
  cacheCreation: number;
  output: number;
  /** Reasoning output tokens (codex only; claude API does not separate them → 0). */
  reasoning: number;
};

export interface NormalizedImage {
  src: string;
  alt?: string;
  mimeType?: string;
  size?: string;
  detail?: string;
  unavailableReason?: string;
}

export type NormalizedEvent =
  | { kind: "message"; ts: string; role: "user" | "assistant" | "system"; text: string; images?: NormalizedImage[]; internal?: boolean; isSidechain?: boolean; isMeta?: boolean }
  | { kind: "tool_call"; ts: string; name: string; args: unknown; callId?: string }
  | { kind: "tool_result"; ts: string; name?: string; callId?: string; ok: boolean; outputText?: string }
  | { kind: "token_usage"; ts: string; usage: NormalizedTokenUsage }
  | { kind: "compaction"; ts: string }
  | { kind: "web_search"; ts: string; query?: string }
  | { kind: "reasoning"; ts: string };

export interface NormalizedSession {
  engine: Engine;
  id: string;
  filePath: string;
  cwd: string;
  model: string;
  version: string;
  gitBranch: string;
  startedAt: string;
  endedAt: string;
  mtimeMs: number;
  sizeBytes: number;
  title: string;
  goalObjective: string;
  events: NormalizedEvent[];
}

export interface SnapshotImage {
  src?: string;
  alt?: string;
  unavailableReason?: string;
}

export interface SnapshotTurn {
  kind?: string;
  role?: string;
  name?: string;
  turn?: number;
  text?: string;
  html?: string;
  images?: SnapshotImage[];
  timestamp?: string;
}

export interface Snapshot {
  id?: string;
  ref?: string;
  title?: string;
  engine?: string;
  engineLabel?: string;
  sourceDetail?: string;
  goalObjective?: string;
  cwd?: string;
  displayCwd?: string;
  filePath?: string;
  displayFilePath?: string;
  generatedAt?: string;
  redacted?: boolean;
  size?: number;
  turnCount?: number;
  tokenUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
    updatedAt?: string;
  };
  turns?: SnapshotTurn[];
  risks?: Array<{ id: string; label: string; severity: string; count: number; turns: number[] }>;
  notices?: Array<{ severity?: string; label?: string; text?: string }>;
}

export interface SnapshotOptions {
  includeTools?: boolean;
  includeToolOutput?: boolean;
  redact?: boolean;
  generatedAt?: string;
  renderHtml?: (text: string) => string;
  redactText?: (text: string) => string;
  detectRisks?: (text: string) => Array<{ id: string; label: string; severity: string }>;
}

export function toSnapshot(session: NormalizedSession, opts?: SnapshotOptions): Snapshot;

export interface DiscoveredFile {
  path: string;
  engine: Engine;
  mtimeMs: number;
  sizeBytes: number;
}

export interface DiscoverOptions {
  roots?: Record<string, string[]>;
  sinceMs?: number | null;
  minBytes?: number;
  maxBytes?: number;
  maxDepth?: number;
  maxFiles?: number;
  skipDirs?: Set<string>;
  /**
   * Include per-subagent transcripts (`.../subagents/workflows/**\/agent-*.jsonl`).
   * These are real, separately-billed token spend but not top-level user sessions,
   * so they are excluded by default. Token-accounting consumers opt in to count them;
   * `journal.jsonl` is always excluded. Default: false.
   */
  includeSubagentTranscripts?: boolean;
  now?: number;
}

export interface PricingEntry {
  match: RegExp;
  input: number;
  cachedInput: number;
  /** $/MTok for cache_creation (cache-write); defaults to input*1.25 when absent. */
  cacheWrite?: number;
  output: number;
}

export interface TokenEventContext {
  userId?: string;
  displayName?: string;
  team?: string;
  source?: string;
  tool?: string;
  project?: string;
  model?: string;
  pricing?: PricingEntry[];
}

export interface TokenUsageEvent {
  id: string;
  userId: string;
  displayName: string;
  team?: string;
  source: string;
  tool?: string;
  model: string;
  project?: string;
  timestamp: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd?: number;
  sessionId?: string;
  sessionTitle?: string;
}

export interface SessionTokenTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  records: number;
}

export function discoverSessionFiles(options?: DiscoverOptions): DiscoveredFile[];
export function defaultRoots(): Record<string, string[]>;
export function expandHome(p: string): string;
export function parseSessionFile(file: DiscoveredFile): NormalizedSession | null;
export function parseSessionText(engine: Engine, text: string, fileInfo?: Partial<DiscoveredFile> & { filePath?: string }): NormalizedSession;
export function detectEngine(sampleLine: string): Engine | null;
export function parseCodexSession(text: string, fileInfo?: { filePath?: string; mtimeMs?: number; sizeBytes?: number }): NormalizedSession;
export function parseClaudeSession(text: string, fileInfo?: { filePath?: string; mtimeMs?: number; sizeBytes?: number }): NormalizedSession;
export function toTokenEvents(session: NormalizedSession, ctx?: TokenEventContext): TokenUsageEvent[];
export function sessionTokenTotals(session: NormalizedSession, ctx?: TokenEventContext): SessionTokenTotals;
export function loadSessions(options?: DiscoverOptions): NormalizedSession[];
export const DEFAULT_MODEL_PRICING: PricingEntry[];
export function resolvePricing(override?: string | unknown[]): PricingEntry[];
export function estimateCostUsd(args: { model: string; inputTokens: number; cachedInputTokens: number; cacheCreationTokens?: number; outputTokens: number }, pricing?: PricingEntry[]): number;
