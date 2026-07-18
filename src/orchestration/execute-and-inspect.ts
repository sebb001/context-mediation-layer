/**
 * Execute-and-Inspect — CLI-facing composition over peer services.
 *
 * This is NOT a new service or orchestration seam. It is a thin composition
 * function that runs ExecutionOrchestrator.executeStep() then uses
 * GovernanceService reads to build a complete operator-facing result.
 *
 * The CLI command calls this; both services remain independently usable.
 *
 * Input: plain numbers + strings (no branded types — transport-agnostic).
 * Output: fold-back result + enriched governance context for inspection.
 */

import { GovernanceService, ServiceResponse } from "../governance/service.js";
import { ExecutionOrchestrator, ExecuteStepParams, ExecuteStepResult } from "./execution-orchestrator.js";
import {
  IntentEnriched,
  InterpretationEnriched,
  Action,
  Event,
} from "../governance/domain.js";

// ============================================================
// CLI-facing input contract
// ============================================================

/** What an operator provides to execute a step. Plain values, no branded types. */
export interface ExecuteStepCommand {
  /** Existing intent ID to execute against. Must be active. */
  intentId: number;
  /** Optional interpretation ID justifying this step. Must belong to the intent. */
  interpretationId?: number;
  /** Actor ID performing the execution. */
  actorId: number;
  /** Target agent name (maps to AgentRuntime). */
  agentName: string;
  /** Plain-language task description. */
  task: string;
  /** Optional workspace label. Triggers workspace acquire/release if set. */
  workspaceRef?: string;
  /** Optional structured context payload. */
  context?: Record<string, unknown>;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

// ============================================================
// CLI-facing output contract
// ============================================================

/** Complete operator-facing result after execution + inspection. */
export interface ExecuteStepReport {
  /** Whether the execution step succeeded. */
  ok: boolean;
  /** Error message if execution failed. */
  error?: string;

  /** The execution fold-back (action recorded, events emitted, runtime result). */
  execution?: {
    actionId: number;
    eventCount: number;
    result: {
      requestId: string;
      status: "completed" | "failed" | "cancelled";
      output?: string;
      error?: string;
      durationMs?: number;
    };
  };

  /** Post-execution governance context for operator inspection. */
  context?: {
    /** Intent state after execution. */
    intent: {
      id: number;
      description: string;
      status: string;
      interpretationCount: number;
      activeClaimCount: number;
    };
    /** Interpretation state (if one was referenced). */
    interpretation?: {
      id: number;
      title: string;
      status: string;
      alignment: string;
      actionCount: number;
    };
    /** The action that was just recorded. */
    action: {
      id: number;
      description: string;
      outcome?: string;
    };
    /** Execution-related events from this step. */
    events: Array<{
      id: number;
      type: string;
      reason?: string;
    }>;
  };
}

// ============================================================
// Composition function
// ============================================================

/**
 * Execute a step and build an operator-facing inspection report.
 *
 * Calls ExecutionOrchestrator.executeStep(), then uses GovernanceService
 * reads to assemble post-execution context. Both services are peers —
 * this function composes them without introducing a new layer.
 */
export async function executeAndInspect(
  command: ExecuteStepCommand,
  orchestrator: ExecutionOrchestrator,
  service: GovernanceService
): Promise<ExecuteStepReport> {
  // 1. Execute
  const execResult = await orchestrator.executeStep(command as ExecuteStepParams);

  if (!execResult.ok && !execResult.foldBack) {
    // Validation failure — no fold-back, no context to inspect
    return { ok: false, error: execResult.error };
  }

  if (!execResult.foldBack) {
    return { ok: false, error: execResult.error ?? "Unknown execution failure" };
  }

  const fb = execResult.foldBack;

  // 2. Build execution summary
  const execution = {
    actionId: fb.actionId as number,
    eventCount: fb.eventIds.length,
    result: {
      requestId: fb.result.requestId,
      status: fb.result.status,
      output: fb.result.output,
      error: fb.result.error,
      durationMs: fb.result.durationMs,
    },
  };

  // 3. Read post-execution governance context
  const intentRes = await service.getIntent(command.intentId);
  if (!intentRes.ok) {
    // Execution happened but post-read failed — still return what we have
    return { ok: execResult.ok, error: execResult.error, execution };
  }

  const intentData = intentRes.data;

  // Read the action that was just recorded
  const actionRes = await service.listActions({ intentId: command.intentId });
  const recordedAction = actionRes.ok
    ? actionRes.data.find((a) => (a.id as number) === (fb.actionId as number))
    : undefined;

  // Read interpretation if one was referenced
  let interpContext: {
    id: number;
    title: string;
    status: string;
    alignment: string;
    actionCount: number;
  } | undefined;
  if (command.interpretationId != null) {
    const interpRes = await service.getInterpretation(command.interpretationId);
    if (interpRes.ok) {
      interpContext = {
        id: interpRes.data.id as number,
        title: interpRes.data.title,
        status: interpRes.data.status,
        alignment: interpRes.data.alignment,
        actionCount: interpRes.data.actions.length,
      };
    }
  }

  // Read execution events for this intent
  const historyRes = await service.getEntityHistory({
    entityTable: "intents",
    entityId: command.intentId,
  });
  const execEvents = historyRes.ok
    ? historyRes.data
        .filter((e) => e.eventType.startsWith("execution."))
        .slice(-fb.eventIds.length) // most recent N events matching this step
        .map((e) => ({
          id: e.id as number,
          type: e.eventType,
          reason: e.reason,
        }))
    : [];

  return {
    ok: execResult.ok,
    error: execResult.error,
    execution,
    context: {
      intent: {
        id: intentData.id as number,
        description: intentData.description,
        status: intentData.status,
        interpretationCount: intentData.interpretationCount,
        activeClaimCount: intentData.activeClaims.length,
      },
      interpretation: interpContext,
      action: recordedAction
        ? {
            id: recordedAction.id as number,
            description: recordedAction.description,
            outcome: recordedAction.outcome,
          }
        : {
            id: fb.actionId as number,
            description: "(recorded)",
            outcome: undefined,
          },
      events: execEvents,
    },
  };
}
