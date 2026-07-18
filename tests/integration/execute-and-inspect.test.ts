/**
 * Execute-and-Inspect Integration Tests
 *
 * Proves the CLI-facing composition function returns operator-legible
 * reports by composing ExecutionOrchestrator + GovernanceService reads.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { GovernanceService } from "../../src/governance/service.js";
import { ExecutionOrchestrator } from "../../src/orchestration/execution-orchestrator.js";
import { executeAndInspect, ExecuteStepCommand } from "../../src/orchestration/execute-and-inspect.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import { FakeWorkspaceService } from "../fakes/fake-workspace-service.js";
import { actorId, domainId } from "../../src/governance/domain.js";

describe("executeAndInspect", () => {
  let repo: InMemoryGovernanceRepository;
  let service: GovernanceService;
  let runtime: FakeAgentRuntime;
  let orchestrator: ExecutionOrchestrator;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
    runtime = new FakeAgentRuntime();
    orchestrator = new ExecutionOrchestrator(repo, runtime);
  });

  async function seedState() {
    const intentRes = await service.registerIntent({
      description: "Verify server health",
      source: "seb",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const domain = await repo.registerDomain({
      scope: "default",
      name: "Operations",
      concern: "Infrastructure health",
    });

    const actor = await repo.registerActor({
      name: "health-agent",
      role: "agent",
      provider: "claude-code",
      capabilityNamespace: "runtime.invoke",
      defaultScope: "default",
    });

    const interpRes = await service.registerInterpretation({
      intentId: intentRes.data.id as number,
      domainId: domain.id as number,
      actorId: actor.id as number,
      title: "SSH and run health checks",
      status: "proposed",
      alignment: "aligned",
    });
    if (!interpRes.ok) throw new Error("unreachable");

    return {
      intentId: intentRes.data.id as number,
      interpId: interpRes.data.id as number,
      actorId: actor.id as number,
    };
  }

  // ---- Report shape ----

  it("returns a complete report with execution and context on success", async () => {
    const { intentId, interpId, actorId } = await seedState();

    const report = await executeAndInspect(
      {
        intentId,
        interpretationId: interpId,
        actorId,
        agentName: "health-agent",
        task: "Check disk and memory",
      },
      orchestrator,
      service
    );

    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();

    // Execution section
    expect(report.execution).toBeDefined();
    expect(report.execution!.result.status).toBe("completed");
    expect(report.execution!.eventCount).toBeGreaterThanOrEqual(3);
    expect(typeof report.execution!.actionId).toBe("number");

    // Context section
    expect(report.context).toBeDefined();
    expect(report.context!.intent.id).toBe(intentId);
    expect(report.context!.intent.status).toBe("active");
    expect(report.context!.intent.interpretationCount).toBe(1);

    expect(report.context!.interpretation).toBeDefined();
    expect(report.context!.interpretation!.id).toBe(interpId);
    expect(report.context!.interpretation!.title).toBe("SSH and run health checks");
    expect(report.context!.interpretation!.actionCount).toBe(1);

    expect(report.context!.action.description).toContain("Executed:");
    expect(report.context!.action.outcome).toBe("fake output");

    expect(report.context!.events.length).toBeGreaterThanOrEqual(3);
    expect(report.context!.events.every((e) => e.type.startsWith("execution."))).toBe(true);
  });

  // ---- Without interpretation ----

  it("works without interpretation and omits interpretation context", async () => {
    const { intentId, actorId } = await seedState();

    const report = await executeAndInspect(
      {
        intentId,
        actorId,
        agentName: "health-agent",
        task: "Quick ping check",
      },
      orchestrator,
      service
    );

    expect(report.ok).toBe(true);
    expect(report.context).toBeDefined();
    expect(report.context!.interpretation).toBeUndefined();
    expect(report.context!.action.description).toContain("Quick ping check");
  });

  // ---- Validation failure ----

  it("returns error without context on validation failure", async () => {
    const report = await executeAndInspect(
      {
        intentId: 999,
        actorId: 1,
        agentName: "agent",
        task: "Should fail",
      },
      orchestrator,
      service
    );

    expect(report.ok).toBe(false);
    expect(report.error).toContain("not found");
    expect(report.execution).toBeUndefined();
    expect(report.context).toBeUndefined();
  });

  it("returns error for non-active intent", async () => {
    const intentRes = await service.registerIntent({
      description: "Draft intent",
      source: "test",
      // defaults to draft
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const report = await executeAndInspect(
      {
        intentId: intentRes.data.id as number,
        actorId: 1,
        agentName: "agent",
        task: "Should fail",
      },
      orchestrator,
      service
    );

    expect(report.ok).toBe(false);
    expect(report.error).toContain("draft");
  });

  // ---- Failed execution still has fold-back ----

  it("reports failure with fold-back context when agent fails", async () => {
    const { intentId, actorId } = await seedState();
    runtime.setBehaviour("failing-agent", { shouldSucceed: false, error: "Agent crashed" });

    const report = await executeAndInspect(
      {
        intentId,
        actorId,
        agentName: "failing-agent",
        task: "This will fail",
      },
      orchestrator,
      service
    );

    expect(report.ok).toBe(false);
    expect(report.execution).toBeDefined();
    expect(report.execution!.result.status).toBe("failed");
    expect(report.execution!.result.error).toBe("Agent crashed");

    // Context still present — operator can inspect what happened
    expect(report.context).toBeDefined();
    expect(report.context!.action.description).toContain("failed");
    expect(report.context!.intent.id).toBe(intentId);
  });

  // ---- Report uses plain numbers, no branded types ----

  it("report contains only plain numbers and strings, no branded types", async () => {
    const { intentId, interpId, actorId } = await seedState();

    const report = await executeAndInspect(
      {
        intentId,
        interpretationId: interpId,
        actorId,
        agentName: "health-agent",
        task: "Check",
      },
      orchestrator,
      service
    );

    // Verify JSON serialisation works cleanly (no __brand pollution)
    const json = JSON.stringify(report);
    expect(json).not.toContain("__brand");
    const parsed = JSON.parse(json);
    expect(typeof parsed.context.intent.id).toBe("number");
    expect(typeof parsed.context.interpretation.id).toBe("number");
    expect(typeof parsed.context.action.id).toBe("number");
    expect(typeof parsed.execution.actionId).toBe("number");
  });
});
