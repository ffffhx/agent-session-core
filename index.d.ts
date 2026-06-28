// Type definitions for agent-session-core (zero-dependency JS implementation).

export type Engine = "codex" | "claude";

export type NormalizedTokenUsage = {
  /** Full input incl. cache (codex: Δinput_tokens; claude: input + cache_read + cache_creation). */
  input: number;
  /** Discounted cached-read subset of input. */
  cached: number;
  output: number;
  /** Reasoning output tokens (codex only; claude API does not separate them → 0). */
  reasoning: number;
};

export type NormalizedEvent =
  | { kind: "message"; ts: string; role: "user" | "assistant" | "system"; text: string; isSidechain?: boolean; isMeta?: boolean }
  | { kind: "tool_call"; ts: string; name: string; args: unknown; callId?: string }
  | { kind: "tool_result"; ts: string; callId?: string; ok: boolean }
  | { kind: "token_usage"; ts: string; usage: NormalizedTokenUsage }
  | { kind: "compaction"; ts: string }
  | { kind: "web_search"; ts: string }
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
  events: NormalizedEvent[];
}

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
  now?: number;
}

export interface PricingEntry {
  match: RegExp;
  input: number;
  cachedInput: number;
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
export function estimateCostUsd(args: { model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number }, pricing?: PricingEntry[]): number;
