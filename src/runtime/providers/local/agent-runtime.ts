import { randomUUID } from "node:crypto";
import type {
  AgentDescriptor,
  AgentRuntime,
  InvocationId,
  InvocationRequest,
  InvocationResult,
} from "../../interfaces/agent-runtime.js";

type InvocationRecord = InvocationResult & { request: InvocationRequest; startedAtMs: number };

export interface LocalAgentRuntimeOptions {
  agents?: AgentDescriptor[];
  idFactory?: () => string;
  now?: () => number;
  autoComplete?: boolean;
}

function cloneInvocation(record: InvocationRecord): InvocationResult {
  return {
    id: record.id,
    status: record.status,
    output: record.output,
    error: record.error,
    usage: record.usage ? { ...record.usage } : undefined,
    durationMs: record.durationMs,
  };
}

/**
 * Local agent runtime.
 *
 * This provider preserves the useful substrate pattern:
 * - adapter-aware agent registry
 * - asynchronous invocation handles
 * - result polling
 * - cancellation
 *
 * It intentionally avoids importing work graph or governance assumptions.
 * Invocation is expressed only in CML-facing task/context terms.
 */
export function createLocalAgentRuntime(
  options: LocalAgentRuntimeOptions = {},
): AgentRuntime {
  const agents = options.agents ?? [
    { name: "agent.codex", adapter: "codex_local" },
    { name: "agent.claude", adapter: "claude_local" },
    { name: "agent.process", adapter: "process" },
  ];
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => Date.now());
  const autoComplete = options.autoComplete ?? true;
  const invocations = new Map<InvocationId, InvocationRecord>();

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

      const startedAt = now();
      const id = idFactory() as InvocationId;

      const record: InvocationRecord = {
        id,
        status: "running",
        startedAtMs: startedAt,
        request: {
          ...request,
          context: request.context ? { ...request.context } : undefined,
        },
      };

      invocations.set(id, record);

      return id;
    },

    async getResult(id: InvocationId): Promise<InvocationResult> {
      const record = invocations.get(id);
      if (!record) {
        throw new Error(`Unknown invocation: ${id}`);
      }
      if (autoComplete && record.status === "running") {
        const completedAt = now();
        const completed: InvocationRecord = {
          ...record,
          status: "completed",
          output: `[${record.request.agent}] ${record.request.task}`,
          usage: {
            inputTokens: 32,
            outputTokens: 64,
            costCents: 1,
          },
          durationMs: Math.max(1, completedAt - record.startedAtMs),
        };
        invocations.set(id, completed);
        return cloneInvocation(completed);
      }
      return cloneInvocation(record);
    },

    async cancel(id: InvocationId): Promise<void> {
      const record = invocations.get(id);
      if (!record) {
        throw new Error(`Unknown invocation: ${id}`);
      }
      if (record.status === "completed" || record.status === "failed") return;
      invocations.set(id, {
        ...record,
        status: "cancelled",
        error: "Invocation cancelled",
        durationMs: record.durationMs ?? 0,
      });
    },
  };
}
