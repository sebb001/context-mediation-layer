/**
 * Fake AgentRuntime for vertical-slice integration tests.
 * Configurable success/failure behaviour per agent name.
 */

import {
  AgentRuntime,
  AgentDescriptor,
  InvocationId,
  InvocationRequest,
  InvocationResult,
} from "../../src/runtime/interfaces/agent-runtime.js";

export interface FakeInvocationBehaviour {
  /** Simulated status. */
  status: "completed" | "failed" | "cancelled";
  /** Output if completed. */
  output?: string;
  /** Error if failed. */
  error?: string;
  /** Simulated duration. */
  durationMs?: number;
}

export class FakeAgentRuntime implements AgentRuntime {
  /** Recorded invocation requests. */
  invocations: InvocationRequest[] = [];

  private behaviours = new Map<string, FakeInvocationBehaviour>();
  private defaultBehaviour: FakeInvocationBehaviour = {
    status: "completed",
    output: "fake output",
    durationMs: 100,
  };

  private nextId = 1;
  private results = new Map<InvocationId, InvocationResult>();

  /** Configure behaviour for a specific agent name. */
  setBehaviour(agentName: string, behaviour: FakeInvocationBehaviour): void {
    this.behaviours.set(agentName, behaviour);
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    return [{ name: "fake-agent", adapter: "fake" }];
  }

  async invoke(request: InvocationRequest): Promise<InvocationId> {
    this.invocations.push(request);
    const id = `inv-${this.nextId++}` as InvocationId;
    const behaviour = this.behaviours.get(request.agent) ?? this.defaultBehaviour;

    this.results.set(id, {
      id,
      status: behaviour.status,
      output: behaviour.output,
      error: behaviour.error,
      durationMs: behaviour.durationMs,
    });

    return id;
  }

  async getResult(id: InvocationId): Promise<InvocationResult> {
    const result = this.results.get(id);
    if (!result) throw new Error(`No result for invocation ${id}`);
    return result;
  }

  async cancel(id: InvocationId): Promise<void> {
    const result = this.results.get(id);
    if (result) {
      this.results.set(id, { ...result, status: "cancelled" });
    }
  }
}
