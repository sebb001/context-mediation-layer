import type {
  AgentDescriptor,
  AgentRuntime,
  InvocationId,
  InvocationRequest,
  InvocationResult,
} from "../../interfaces/agent-runtime.js";

type FakeInvocation = InvocationResult & { request: InvocationRequest };

export function createFakeAgentRuntime(
  agents: AgentDescriptor[] = [{ name: "agent.fake", adapter: "fake" }],
): AgentRuntime {
  const invocations = new Map<InvocationId, FakeInvocation>();
  let nextId = 1;

  function newId(): InvocationId {
    return `invocation-${nextId++}`;
  }

  return {
    async listAgents(): Promise<AgentDescriptor[]> {
      return agents.map((agent) => ({
        ...agent,
        config: agent.config ? { ...agent.config } : undefined,
      }));
    },

    async invoke(request: InvocationRequest): Promise<InvocationId> {
      const agent = agents.find((entry) => entry.name === request.agent);
      if (!agent) {
        throw new Error(`Unknown agent: ${request.agent}`);
      }

      const id = newId();
      invocations.set(id, {
        id,
        status: "completed",
        output: `fake:${request.task}`,
        usage: { inputTokens: 1, outputTokens: 1, costCents: 0 },
        durationMs: 1,
        request: {
          ...request,
          context: request.context ? { ...request.context } : undefined,
        },
      });
      return id;
    },

    async getResult(id: InvocationId): Promise<InvocationResult> {
      const invocation = invocations.get(id);
      if (!invocation) {
        throw new Error(`Unknown invocation: ${id}`);
      }
      return {
        id: invocation.id,
        status: invocation.status,
        output: invocation.output,
        error: invocation.error,
        usage: invocation.usage ? { ...invocation.usage } : undefined,
        durationMs: invocation.durationMs,
      };
    },

    async cancel(id: InvocationId): Promise<void> {
      const invocation = invocations.get(id);
      if (!invocation) {
        throw new Error(`Unknown invocation: ${id}`);
      }
      invocations.set(id, {
        ...invocation,
        status: "cancelled",
        error: "Invocation cancelled",
      });
    },
  };
}
