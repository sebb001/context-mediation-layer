/**
 * Governance-owned DTOs for execution handoff.
 *
 * These types live above the governance repository and below any transport layer.
 * Both CLI and MCP adapter consume them unchanged.
 *
 * Key rule from #47: "runtime events are transport facts; governance decides
 * whether and when they become Actions."
 */

import { IntentId, InterpretationId, ActorId, ActionId, EventId } from "../governance/domain.js";

// ============================================================
// Execution Request — governance → runtime
// ============================================================

/** Governance-owned request to invoke a runtime agent. */
export interface ExecutionRequest {
  /** Governance-owned opaque ID for this request. */
  requestId: string;
  /** Target runtime agent name (maps to AgentRuntime agent identifier). */
  agentName: string;
  /** Plain-language execution instruction. */
  task: string;
  /** Optional workspace label/reference. If present, workspace is acquired before invoke. */
  workspaceRef?: string;
  /** Optional structured execution context payload. */
  context?: Record<string, unknown>;
  /** Governance reference: which intent triggered this. */
  sourceIntentId: IntentId;
  /** Governance reference: which interpretation justified this. */
  sourceInterpretationId?: InterpretationId;
  /** Actor requesting the execution. */
  requestingActorId: ActorId;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

// ============================================================
// Execution Result — runtime → governance
// ============================================================

export type ExecutionStatus = "completed" | "failed" | "cancelled";

/** Governance-owned result after runtime execution completes. */
export interface ExecutionResult {
  /** Matches ExecutionRequest.requestId. */
  requestId: string;
  /** Final status. */
  status: ExecutionStatus;
  /** Agent output (stdout, structured response, etc). */
  output?: string;
  /** Error message if status is "failed". */
  error?: string;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Token/cost usage. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costCents?: number;
  };
  /** Workspace ID if one was allocated. */
  workspaceId?: string;
}

// ============================================================
// Governance Fold-back — what the orchestrator records
// ============================================================

/** What the orchestrator writes back into governance after execution. */
export interface ExecutionFoldBack {
  /** The Action recorded for this execution step. */
  actionId: ActionId;
  /** Event IDs recorded during this execution. */
  eventIds: EventId[];
  /** The execution result from runtime. */
  result: ExecutionResult;
}
