/**
 * Service → Orchestrator Lifecycle Integration Test
 *
 * Deepens the vertical slice by proving the two peer application services
 * (GovernanceService and ExecutionOrchestrator) work together through
 * a realistic governance lifecycle:
 *
 *   GovernanceService creates state → ExecutionOrchestrator executes →
 *   fold-back verified through GovernanceService reads
 *
 * This moves beyond seeded/demo execution to repository-backed governance
 * state created through the canonical service layer.
 *
 * No transport layer involved — both services consume GovernanceRepository
 * directly as peer services per the architecture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { GovernanceService } from "../../src/governance/service.js";
import { ExecutionOrchestrator } from "../../src/orchestration/execution-orchestrator.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import { FakeWorkspaceService } from "../fakes/fake-workspace-service.js";

describe("Service → Orchestrator Lifecycle", () => {
  let repo: InMemoryGovernanceRepository;
  let service: GovernanceService;
  let runtime: FakeAgentRuntime;
  let workspaces: FakeWorkspaceService;
  let orchestrator: ExecutionOrchestrator;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
    runtime = new FakeAgentRuntime();
    workspaces = new FakeWorkspaceService();
    orchestrator = new ExecutionOrchestrator(repo, runtime, workspaces);
  });

  // ---- Full lifecycle: register → interpret → execute → verify ----

  it("completes a full governance lifecycle through service and orchestrator", async () => {
    // 1. Register intent through GovernanceService
    const intentRes = await service.registerIntent({
      description: "Verify M2 mechiso run output on server",
      source: "seb",
      scope: "default",
      status: "active",
    });
    expect(intentRes.ok).toBe(true);
    if (!intentRes.ok) throw new Error("unreachable");
    const intentId = intentRes.data.id;

    // 2. Register actor and domain through GovernanceService
    const actorRes = await service.registerActor({
      name: "verification-agent",
      role: "agent",
      provider: "claude-code",
      capabilityNamespace: "runtime.invoke",
      defaultScope: "default",
    });
    expect(actorRes.ok).toBe(true);
    if (!actorRes.ok) throw new Error("unreachable");

    const domainRes = await service.listDomains();
    // Register a domain directly through repo (service doesn't expose registerDomain)
    const domain = await repo.registerDomain({
      scope: "default",
      name: "Runtime Operations",
      concern: "Execution of agent tasks against external systems",
    });

    // 3. File interpretation through GovernanceService
    const interpRes = await service.registerInterpretation({
      intentId: intentId as number,
      domainId: domain.id as number,
      actorId: actorRes.data.id as number,
      title: "Check sample workspace outbox for completion markers",
      status: "proposed",
      alignment: "aligned",
    });
    expect(interpRes.ok).toBe(true);
    if (!interpRes.ok) throw new Error("unreachable");
    const interpId = interpRes.data.id;

    // 4. Execute through ExecutionOrchestrator
    const execResult = await orchestrator.executeStep({
      intentId: intentId as number,
      interpretationId: interpId as number,
      actorId: actorRes.data.id as number,
      agentName: "ssh-check-agent",
      task: "Check sample workspace outbox for run completion files",
      context: { server: "example-host", path: "/workspace/outbox" },
    });

    expect(execResult.ok).toBe(true);
    expect(execResult.foldBack).toBeDefined();
    expect(execResult.foldBack!.result.status).toBe("completed");

    // 5. Verify fold-back through GovernanceService reads
    // Intent should still be active with enriched data
    const enrichedIntent = await service.getIntent(intentId as number);
    expect(enrichedIntent.ok).toBe(true);
    if (!enrichedIntent.ok) throw new Error("unreachable");
    expect(enrichedIntent.data.status).toBe("active");
    expect(enrichedIntent.data.interpretationCount).toBe(1);

    // Interpretation should have linked actions
    const enrichedInterp = await service.getInterpretation(interpId as number);
    expect(enrichedInterp.ok).toBe(true);
    if (!enrichedInterp.ok) throw new Error("unreachable");
    expect(enrichedInterp.data.actions).toHaveLength(1);
    expect(enrichedInterp.data.actions[0].description).toContain("Executed:");
    expect(enrichedInterp.data.actions[0].outcome).toBe("fake output");

    // Actions visible through service list
    const actionsRes = await service.listActions({ intentId: intentId as number });
    expect(actionsRes.ok).toBe(true);
    if (!actionsRes.ok) throw new Error("unreachable");
    expect(actionsRes.data).toHaveLength(1);

    // Event trail visible through service
    const eventsRes = await service.listEvents({ entityTable: "intents" });
    expect(eventsRes.ok).toBe(true);
    if (!eventsRes.ok) throw new Error("unreachable");
    const execEvents = eventsRes.data.filter((e) => e.eventType.startsWith("execution."));
    expect(execEvents.length).toBeGreaterThanOrEqual(3);
  });

  // ---- Sub-intent delegation lifecycle ----

  it("executes against a sub-intent created through service", async () => {
    // Parent intent (top-level directive)
    const parentRes = await service.registerIntent({
      description: "Complete M2 verification across all servers",
      source: "seb",
      scope: "default",
      status: "active",
    });
    expect(parentRes.ok).toBe(true);
    if (!parentRes.ok) throw new Error("unreachable");

    // Sub-intent (delegation)
    const subRes = await service.registerIntent({
      description: "Check server .52 for M2 run output",
      source: "seb",
      scope: "default",
      parentId: parentRes.data.id as number,
      status: "active",
    });
    expect(subRes.ok).toBe(true);
    if (!subRes.ok) throw new Error("unreachable");

    // Verify parent_id was set correctly
    const subIntent = await service.getIntent(subRes.data.id as number);
    expect(subIntent.ok).toBe(true);
    if (!subIntent.ok) throw new Error("unreachable");
    expect(subIntent.data.parentId).toBe(parentRes.data.id);

    // Execute against the sub-intent
    const execResult = await orchestrator.executeStep({
      intentId: subRes.data.id as number,
      actorId: 1,
      agentName: "ssh-agent",
      task: "List the sample workspace outbox",
    });

    expect(execResult.ok).toBe(true);
    expect(execResult.foldBack!.result.status).toBe("completed");

    // Parent intent is untouched — sub-intent got the action
    const parentActions = await service.listActions({ intentId: parentRes.data.id as number });
    expect(parentActions.ok).toBe(true);
    if (!parentActions.ok) throw new Error("unreachable");
    expect(parentActions.data).toHaveLength(0);

    const subActions = await service.listActions({ intentId: subRes.data.id as number });
    expect(subActions.ok).toBe(true);
    if (!subActions.ok) throw new Error("unreachable");
    expect(subActions.data).toHaveLength(1);
  });

  // ---- Superseded interpretation blocks execution ----

  it("blocks execution after interpretation is superseded through service", async () => {
    // Set up governance state
    const intentRes = await service.registerIntent({
      description: "Run diagnostic on server",
      source: "test",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const domain = await repo.registerDomain({
      scope: "default",
      name: "Diagnostics",
      concern: "System health checks",
    });

    const interpRes = await service.registerInterpretation({
      intentId: intentRes.data.id as number,
      domainId: domain.id as number,
      actorId: 1,
      title: "Run full diagnostic suite",
      status: "proposed",
      alignment: "aligned",
    });
    if (!interpRes.ok) throw new Error("unreachable");

    // Supersede through service — actor changed their understanding
    const supersedeRes = await service.supersedeInterpretation({
      id: interpRes.data.id as number,
      newTitle: "Run targeted disk check only",
      reason: "Full suite is overkill for this case",
    });
    expect(supersedeRes.ok).toBe(true);
    if (!supersedeRes.ok) throw new Error("unreachable");

    // Executing against old (superseded) interpretation should fail
    const execOld = await orchestrator.executeStep({
      intentId: intentRes.data.id as number,
      interpretationId: interpRes.data.id as number,
      actorId: 1,
      agentName: "diag-agent",
      task: "Run diagnostics",
    });
    expect(execOld.ok).toBe(false);
    expect(execOld.error).toContain("superseded");

    // Executing against replacement interpretation should succeed
    const execNew = await orchestrator.executeStep({
      intentId: intentRes.data.id as number,
      interpretationId: supersedeRes.data.replacement.id as number,
      actorId: 1,
      agentName: "diag-agent",
      task: "Run targeted disk check",
    });
    expect(execNew.ok).toBe(true);
    expect(execNew.foldBack!.result.status).toBe("completed");
  });

  // ---- Intent status lifecycle gates execution ----

  it("execution is gated by intent status transitions through service", async () => {
    // Create as draft
    const intentRes = await service.registerIntent({
      description: "Deploy new version",
      source: "test",
      // defaults to "draft"
    });
    if (!intentRes.ok) throw new Error("unreachable");
    const intentId = intentRes.data.id as number;

    // Draft → cannot execute
    const execDraft = await orchestrator.executeStep({
      intentId,
      actorId: 1,
      agentName: "deploy-agent",
      task: "Deploy v2",
    });
    expect(execDraft.ok).toBe(false);
    expect(execDraft.error).toContain("draft");

    // Activate through service
    const activateRes = await service.updateIntent({
      id: intentId,
      reason: "Approved for execution",
      status: "active",
      actorId: 1,
    });
    expect(activateRes.ok).toBe(true);

    // Active → can execute
    const execActive = await orchestrator.executeStep({
      intentId,
      actorId: 1,
      agentName: "deploy-agent",
      task: "Deploy v2",
    });
    expect(execActive.ok).toBe(true);

    // Close through service
    const closeRes = await service.updateIntent({
      id: intentId,
      reason: "Deployment complete",
      status: "closed",
      resolutionNotes: "v2 deployed successfully",
      actorId: 1,
    });
    expect(closeRes.ok).toBe(true);

    // Closed → cannot execute
    const execClosed = await orchestrator.executeStep({
      intentId,
      actorId: 1,
      agentName: "deploy-agent",
      task: "Deploy v2 again",
    });
    expect(execClosed.ok).toBe(false);
    expect(execClosed.error).toContain("closed");
  });

  // ---- Multiple executions accumulate in governance ----

  it("multiple execution steps accumulate actions and events correctly", async () => {
    const intentRes = await service.registerIntent({
      description: "Multi-step verification",
      source: "test",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");
    const intentId = intentRes.data.id as number;

    // Execute three steps
    for (const task of ["Check disk space", "Check memory", "Check network"]) {
      const result = await orchestrator.executeStep({
        intentId,
        actorId: 1,
        agentName: "check-agent",
        task,
      });
      expect(result.ok).toBe(true);
    }

    // All three actions recorded
    const actionsRes = await service.listActions({ intentId });
    expect(actionsRes.ok).toBe(true);
    if (!actionsRes.ok) throw new Error("unreachable");
    expect(actionsRes.data).toHaveLength(3);
    expect(actionsRes.data.map((a) => a.description)).toEqual([
      "Executed: Check disk space",
      "Executed: Check memory",
      "Executed: Check network",
    ]);

    // Events accumulated (at least 3 per step: requested, started, completed)
    const eventsRes = await service.listEvents({ entityTable: "intents" });
    expect(eventsRes.ok).toBe(true);
    if (!eventsRes.ok) throw new Error("unreachable");
    const execEvents = eventsRes.data.filter((e) => e.eventType.startsWith("execution."));
    expect(execEvents.length).toBeGreaterThanOrEqual(9);
  });

  // ---- Portability: alternate scope through service ----

  it("an alternate organisation uses identical service and orchestrator paths", async () => {
    // Register an alternate scope
    await service.registerScope({ scope: "consulting" });

    const intentRes = await service.registerIntent({
      description: "Prepare client deliverable for Q2 review",
      source: "ops-lead",
      scope: "consulting",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const domain = await repo.registerDomain({
      scope: "consulting",
      name: "Client Delivery",
      concern: "On-time client output",
    });

    const interpRes = await service.registerInterpretation({
      intentId: intentRes.data.id as number,
      domainId: domain.id as number,
      actorId: 1,
      title: "Generate PDF report from latest data",
      status: "proposed",
      alignment: "aligned",
    });
    if (!interpRes.ok) throw new Error("unreachable");

    const execResult = await orchestrator.executeStep({
      intentId: intentRes.data.id as number,
      interpretationId: interpRes.data.id as number,
      actorId: 1,
      agentName: "report-agent",
      task: "Generate Q2 client report",
    });

    expect(execResult.ok).toBe(true);

    // Verify through service — same read paths work for any scope
    const enriched = await service.getInterpretation(interpRes.data.id as number);
    expect(enriched.ok).toBe(true);
    if (!enriched.ok) throw new Error("unreachable");
    expect(enriched.data.intent.scope).toBe("consulting");
    expect(enriched.data.actions).toHaveLength(1);
    expect(enriched.data.actions[0].description).toContain("Generate Q2 client report");
  });
});
