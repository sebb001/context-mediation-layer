/**
 * AgentRuntime — anti-corruption interface for agent invocation.
 *
 * Wraps: adapter registry, agent process lifecycle, invocation bookkeeping.
 * CML vocabulary only. No company/issue/goal concepts cross this boundary.
 *
 * Substitution criteria:
 * - Invoke a named agent with a task description and optional context
 * - Return structured invocation results (output, cost, status)
 * - Support cancellation of in-progress invocations
 * - Be adapter-agnostic (local process, HTTP, gateway — provider decides)
 */

/** Opaque handle for a running invocation. */
export type InvocationId = string;

export interface AgentDescriptor {
  /** Agent identifier (maps to CML actor name). */
  name: string;
  /** Runtime adapter type (e.g. "claude-local", "codex-local"). */
  adapter: string;
  /** Provider-specific configuration. Opaque to governance. */
  config?: Record<string, unknown>;
}

export interface InvocationRequest {
  /** Which agent to invoke. */
  agent: string;
  /** Plain-language task description. CML vocabulary. */
  task: string;
  /** Optional context payload (documents, prior output, etc). */
  context?: Record<string, unknown>;
  /** Optional working directory or workspace reference. */
  workspaceRef?: string;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

export type InvocationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface InvocationResult {
  id: InvocationId;
  status: InvocationStatus;
  /** Agent output (stdout, structured response, etc). */
  output?: string;
  /** Error message if status is "failed". */
  error?: string;
  /** Token/cost usage for this invocation. */
  usage?: InvocationUsage;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
}

export interface InvocationUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cost in USD cents. */
  costCents?: number;
}

export interface AgentRuntime {
  /** List available agents and their adapters. */
  listAgents(): Promise<AgentDescriptor[]>;

  /** Start an agent invocation. Returns immediately with an invocation handle. */
  invoke(request: InvocationRequest): Promise<InvocationId>;

  /** Poll or await the result of an invocation. */
  getResult(id: InvocationId): Promise<InvocationResult>;

  /** Cancel an in-progress invocation. */
  cancel(id: InvocationId): Promise<void>;
}
