/**
 * ExecutionOrchestrator — governance-owned execution handoff and fold-back.
 *
 * This is the seam where governance meets runtime. It:
 * 1. Validates governance state (intent active, interpretation valid if provided)
 * 2. Constructs a governance-owned ExecutionRequest
 * 3. Optionally acquires a workspace
 * 4. Invokes runtime via anti-corruption interface
 * 5. Folds operational results back into governance records (Action + Events)
 *
 * Dependencies: GovernanceRepository + runtime interfaces (AgentRuntime,
 * WorkspaceService, EventAuditBus). No Local-native imports.
 *
 * See #47 (vertical slice plan), #53 (CLI-first), #55 (updated recommendation).
 */

import { GovernanceRepository } from "../governance/repository.js";
import {
  intendId,
  actorId as toActorId,
  interpretationId as toInterpretationId,
  eventId as toEventId,
  IntentId,
  InterpretationId,
  ActorId,
  EventId,
} from "../governance/domain.js";
import { AgentRuntime, InvocationId } from "../runtime/interfaces/agent-runtime.js";
import { WorkspaceService, WorkspaceId } from "../runtime/interfaces/workspace-service.js";
import { EventAuditBus } from "../runtime/interfaces/event-audit-bus.js";
import { ExecutionRequest, ExecutionResult, ExecutionFoldBack, ExecutionStatus } from "./types.js";

/** Input params for executeStep — the thin surface a CLI command would call. */
export interface ExecuteStepParams {
  /** Intent ID this execution step belongs to. */
  intentId: number;
  /** Interpretation ID that justifies this step (optional). */
  interpretationId?: number;
  /** Actor ID requesting execution. */
  actorId: number;
  /** Target agent name. */
  agentName: string;
  /** Task description in plain language. */
  task: string;
  /** Optional workspace label. If set, a workspace is acquired. */
  workspaceRef?: string;
  /** Optional execution context. */
  context?: Record<string, unknown>;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ExecuteStepResult {
  ok: boolean;
  foldBack?: ExecutionFoldBack;
  error?: string;
}

let requestCounter = 0;
function nextRequestId(): string {
  return `exec-${Date.now()}-${++requestCounter}`;
}

export class ExecutionOrchestrator {
  constructor(
    private readonly repo: GovernanceRepository,
    private readonly agentRuntime: AgentRuntime,
    private readonly workspaceService?: WorkspaceService,
    private readonly eventBus?: EventAuditBus
  ) {}

  /**
   * Execute a single governance-owned step.
   *
   * Flow (from #47):
   * 1. Validate intent exists and is active
   * 2. Validate interpretation if provided (exists, belongs to intent, actionable)
   * 3. Construct canonical ExecutionRequest
   * 4. Emit governance event: execution requested
   * 5. Optionally acquire workspace
   * 6. Invoke agent via AgentRuntime
   * 7. Await result
   * 8. Fold back: record Action + Events in governance
   * 9. Release workspace if acquired
   */
  async executeStep(params: ExecuteStepParams): Promise<ExecuteStepResult> {
    const intentId = intendId(params.intentId);
    const actorId = toActorId(params.actorId);
    const interpretationId = params.interpretationId != null
      ? toInterpretationId(params.interpretationId)
      : undefined;

    // 1. Validate intent exists and is active
    const intent = await this.repo.getIntent(intentId);
    if (!intent) {
      return { ok: false, error: `Intent ${params.intentId} not found` };
    }
    if (intent.status !== "active") {
      return {
        ok: false,
        error: `Intent ${params.intentId} is '${intent.status}', must be 'active' to execute against`,
      };
    }

    // 2. Validate interpretation if provided
    if (interpretationId != null) {
      const interp = await this.repo.getInterpretation(interpretationId);
      if (!interp) {
        return {
          ok: false,
          error: `Interpretation ${params.interpretationId} not found`,
        };
      }
      if (interp.intentId !== intentId) {
        return {
          ok: false,
          error: `Interpretation ${params.interpretationId} belongs to intent ${interp.intentId}, not ${params.intentId}`,
        };
      }
      if (interp.status === "superseded") {
        return {
          ok: false,
          error: `Interpretation ${params.interpretationId} is superseded, cannot execute against it`,
        };
      }
    }

    // 3. Construct canonical ExecutionRequest
    const requestId = nextRequestId();
    const execRequest: ExecutionRequest = {
      requestId,
      agentName: params.agentName,
      task: params.task,
      workspaceRef: params.workspaceRef,
      context: params.context,
      sourceIntentId: intentId,
      sourceInterpretationId: interpretationId,
      requestingActorId: actorId,
      timeoutMs: params.timeoutMs,
    };

    const eventIds: EventId[] = [];

    // 4. Emit governance event: execution requested
    const reqEvent = await this.repo.emitEvent(
      "execution.requested",
      "intents",
      intentId,
      actorId,
      {
        reason: `Execution step requested: ${params.task}`,
        snapshot: {
          requestId,
          agentName: execRequest.agentName,
          interpretationId: interpretationId ?? null,
        },
      }
    );
    eventIds.push(reqEvent.id);

    // 5. Optionally acquire workspace
    let workspaceId: string | undefined;
    if (params.workspaceRef && this.workspaceService) {
      try {
        const ws = await this.workspaceService.create({
          label: params.workspaceRef,
          strategy: "directory",
          basePath: "/tmp/cml-workspaces",
          reusable: false,
        });
        await this.workspaceService.acquire(ws.id);
        workspaceId = ws.id;

        const wsEvent = await this.repo.emitEvent(
          "execution.workspace_acquired",
          "intents",
          intentId,
          actorId,
          { snapshot: { requestId, workspaceId } }
        );
        eventIds.push(wsEvent.id);
      } catch (err) {
        // Workspace failure is not fatal — log and continue without workspace
        const failEvent = await this.repo.emitEvent(
          "execution.workspace_failed",
          "intents",
          intentId,
          actorId,
          { reason: `Workspace acquisition failed: ${err}`, snapshot: { requestId } }
        );
        eventIds.push(failEvent.id);
      }
    }

    // 6. Invoke agent
    let invocationId: InvocationId;
    try {
      invocationId = await this.agentRuntime.invoke({
        agent: execRequest.agentName,
        task: execRequest.task,
        context: execRequest.context,
        workspaceRef: workspaceId ?? execRequest.workspaceRef,
        timeoutMs: execRequest.timeoutMs,
      });

      const startEvent = await this.repo.emitEvent(
        "execution.invocation_started",
        "intents",
        intentId,
        actorId,
        { snapshot: { requestId, invocationId, agentName: execRequest.agentName } }
      );
      eventIds.push(startEvent.id);
    } catch (err) {
      // Invocation failed to start
      const failEvent = await this.repo.emitEvent(
        "execution.invocation_failed",
        "intents",
        intentId,
        actorId,
        { reason: `Invocation failed to start: ${err}`, snapshot: { requestId } }
      );
      eventIds.push(failEvent.id);

      // Fold back: record failure action
      const action = await this.repo.logAction({
        intentId,
        interpretationId,
        actorId,
        description: `Execution step failed to start: ${params.task}`,
        outcome: `Error: ${err}`,
      });

      await this.releaseWorkspace(workspaceId, requestId, intentId, actorId, eventIds);

      return {
        ok: false,
        error: `Invocation failed to start: ${err}`,
        foldBack: {
          actionId: action.id,
          eventIds: [...eventIds],
          result: { requestId, status: "failed", error: String(err) },
        },
      };
    }

    // 7. Await result
    const runtimeResult = await this.agentRuntime.getResult(invocationId);

    const status: ExecutionStatus = runtimeResult.status === "completed"
      ? "completed"
      : runtimeResult.status === "cancelled"
        ? "cancelled"
        : "failed";

    const execResult: ExecutionResult = {
      requestId,
      status,
      output: runtimeResult.output,
      error: runtimeResult.error,
      durationMs: runtimeResult.durationMs,
      usage: runtimeResult.usage,
      workspaceId,
    };

    const completeEvent = await this.repo.emitEvent(
      `execution.invocation_${status}`,
      "intents",
      intentId,
      actorId,
      {
        reason: status === "completed"
          ? `Agent ${execRequest.agentName} completed execution`
          : `Agent ${execRequest.agentName} ${status}: ${runtimeResult.error ?? "unknown"}`,
        snapshot: {
          requestId,
          invocationId,
          status,
          durationMs: runtimeResult.durationMs,
          usage: runtimeResult.usage,
        },
      }
    );
    eventIds.push(completeEvent.id);

    // 8. Fold back: record Action in governance
    const action = await this.repo.logAction({
      intentId,
      interpretationId,
      actorId,
      description: status === "completed"
        ? `Executed: ${params.task}`
        : `Execution ${status}: ${params.task}`,
      outcome: status === "completed"
        ? runtimeResult.output ?? "completed"
        : runtimeResult.error ?? status,
    });

    // 9. Release workspace
    await this.releaseWorkspace(workspaceId, requestId, intentId, actorId, eventIds);

    return {
      ok: status === "completed",
      foldBack: {
        actionId: action.id,
        eventIds: [...eventIds],
        result: execResult,
      },
    };
  }

  private async releaseWorkspace(
    workspaceId: string | undefined,
    requestId: string,
    intentId: IntentId,
    actorId: ActorId,
    eventIds: EventId[]
  ): Promise<void> {
    if (workspaceId && this.workspaceService) {
      try {
        await this.workspaceService.release(workspaceId as WorkspaceId);
        const releaseEvent = await this.repo.emitEvent(
          "execution.workspace_released",
          "intents",
          intentId,
          actorId,
          { snapshot: { requestId, workspaceId } }
        );
        eventIds.push(releaseEvent.id);
      } catch {
        // Log but don't fail the fold-back
      }
    }
  }
}
