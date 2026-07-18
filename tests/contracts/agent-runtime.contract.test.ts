import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../src/runtime/interfaces/agent-runtime.js";
import {
  createFakeAgentRuntime,
  createLocalAgentRuntime,
} from "../../src/runtime/providers/index.js";

function runAgentRuntimeContract(name: string, factory: () => AgentRuntime) {
  describe(name, () => {
    it("lists available agents and adapters", async () => {
      const runtime = factory();
      const agents = await runtime.listAgents();

      expect(agents.length).toBeGreaterThan(0);
      expect(agents[0]).toHaveProperty("name");
      expect(agents[0]).toHaveProperty("adapter");
    });

    it("invokes an agent and returns a result by invocation id", async () => {
      const runtime = factory();
      const [agent] = await runtime.listAgents();
      const invocationId = await runtime.invoke({
        agent: agent!.name,
        task: "Summarise current state",
        context: { foo: "bar" },
      });

      expect(invocationId).toBeTruthy();

      await Promise.resolve();
      const result = await runtime.getResult(invocationId);
      expect(result.id).toBe(invocationId);
      expect(["running", "completed", "failed", "cancelled"]).toContain(result.status);
    });

    it("supports cancellation of in-progress or pending invocations", async () => {
      const runtime = factory();
      const [agent] = await runtime.listAgents();
      const invocationId = await runtime.invoke({
        agent: agent!.name,
        task: "Long-running task",
      });

      await runtime.cancel(invocationId);
      const result = await runtime.getResult(invocationId);
      expect(result.status).toBe("cancelled");
    });
  });
}

describe("AgentRuntime contract", () => {
  runAgentRuntimeContract("fake provider", () =>
    createFakeAgentRuntime([{ name: "agent.fake", adapter: "fake" }]),
  );

  runAgentRuntimeContract("local provider", () =>
    createLocalAgentRuntime({
      agents: [
        { name: "agent.codex", adapter: "codex_local" },
        { name: "agent.process", adapter: "process" },
      ],
      idFactory: (() => {
        let counter = 0;
        return () => `invoke-${++counter}`;
      })(),
      now: (() => {
        let tick = 1000;
        return () => tick++;
      })(),
    }),
  );
});
