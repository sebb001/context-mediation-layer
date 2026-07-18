/**
 * Vertical Slice Integration Test
 *
 * Proves the vertical-slice thesis:
 * A governance-owned execution request flows through runtime handoff,
 * produces operational events, and is folded back into canonical governance
 * state, with zero tenant-specific code in the engine layer.
 *
 * Uses:
 * - InMemoryGovernanceRepository (real governance)
 * - FakeAgentRuntime (fake runtime)
 * - FakeWorkspaceService (fake runtime)
 * - No EventAuditBus subscription (optional, tested separately)
 *
 * Success criteria:
 * (a) Governance engine handled the full loop
 * (b) No tenant-specific code in governance or runtime interface layers
 * (c) Default-specific knowledge entered only through plain-language intent
 * (d) Same engine code could run another coordination task without modification
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { ExecutionOrchestrator } from "../../src/orchestration/execution-orchestrator.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import { FakeWorkspaceService } from "../fakes/fake-workspace-service.js";
import { actorId, domainId } from "../../src/governance/domain.js";

describe("Vertical Slice: Governance → Runtime → Fold-back", () => {
  let repo: InMemoryGovernanceRepository;
  let runtime: FakeAgentRuntime;
  let workspaces: FakeWorkspaceService;
  let orchestrator: ExecutionOrchestrator;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    runtime = new FakeAgentRuntime();
    workspaces = new FakeWorkspaceService();
    orchestrator = new ExecutionOrchestrator(repo, runtime, workspaces);
  });

  // Helper: seed an intent + interpretation to justify execution
  async function seedGovernanceState() {
    const intent = await repo.createIntent(
      {
        scope: "default",
        description: "Verify M2 mechiso runs completed on server",
        source: "test",
        status: "active",
      },
      actorId(1)
    );

    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "SSH to server, check outbox for completed run files",
      status: "proposed",
      alignment: "aligned",
    });

    return { intent, interp };
  }

  // ---- Happy path: execution completes ----

  it("executes a step and folds result back into governance", async () => {
    const { intent, interp } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: interp.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Check server outbox for M2 run results",
    });

    // Execution succeeded
    expect(result.ok).toBe(true);
    expect(result.foldBack).toBeDefined();
    expect(result.foldBack!.result.status).toBe("completed");
    expect(result.foldBack!.result.output).toBe("fake output");

    // Action was recorded in governance
    const actions = await repo.listActions({ intentId: intent.id });
    expect(actions).toHaveLength(1);
    expect(actions[0].description).toContain("Executed:");
    expect(actions[0].interpretationId).toBe(interp.id);

    // Events were recorded in governance (at least: requested + started + completed)
    const events = await repo.listEvents({ entityTable: "intents" });
    const executionEvents = events.filter((e) => e.eventType.startsWith("execution."));
    expect(executionEvents.length).toBeGreaterThanOrEqual(3);

    const eventTypes = executionEvents.map((e) => e.eventType);
    expect(eventTypes).toContain("execution.requested");
    expect(eventTypes).toContain("execution.invocation_started");
    expect(eventTypes).toContain("execution.invocation_completed");
  });

  // ---- Runtime records the invocation correctly ----

  it("passes task and context to runtime", async () => {
    const { intent } = await seedGovernanceState();

    await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Run diagnostic script",
      context: { server: "example-host", path: "/workspace/outbox" },
    });

    expect(runtime.invocations).toHaveLength(1);
    expect(runtime.invocations[0].agent).toBe("fake-agent");
    expect(runtime.invocations[0].task).toBe("Run diagnostic script");
    expect(runtime.invocations[0].context).toEqual({
      server: "example-host",
      path: "/workspace/outbox",
    });
  });

  // ---- With workspace ----

  it("acquires and releases workspace when workspaceRef is provided", async () => {
    const { intent } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Build in isolated workspace",
      workspaceRef: "m2-verification",
    });

    expect(result.ok).toBe(true);

    // Workspace was created and released
    const allWorkspaces = await workspaces.list();
    expect(allWorkspaces).toHaveLength(1);
    expect(allWorkspaces[0].status).toBe("archived"); // released = archived
    expect(allWorkspaces[0].label).toBe("m2-verification");

    // Events include workspace lifecycle
    const events = await repo.listEvents({ entityTable: "intents" });
    const wsEvents = events.filter((e) => e.eventType.includes("workspace"));
    expect(wsEvents.length).toBeGreaterThanOrEqual(2); // acquired + released
  });

  // ---- Without workspace ----

  it("works without workspace when workspaceRef is not provided", async () => {
    const { intent } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Simple check, no workspace needed",
    });

    expect(result.ok).toBe(true);

    // No workspaces created
    const allWorkspaces = await workspaces.list();
    expect(allWorkspaces).toHaveLength(0);
  });

  // ---- Agent failure ----

  it("records failure when agent fails", async () => {
    runtime.setBehaviour("failing-agent", {
      status: "failed",
      error: "Connection refused",
    });

    const { intent, interp } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: interp.id,
      actorId: 1,
      agentName: "failing-agent",
      task: "Attempt connection to unreachable server",
    });

    // Execution failed but fold-back still happened
    expect(result.ok).toBe(false);
    expect(result.foldBack).toBeDefined();
    expect(result.foldBack!.result.status).toBe("failed");

    // Action was still recorded
    const actions = await repo.listActions({ intentId: intent.id });
    expect(actions).toHaveLength(1);
    expect(actions[0].description).toContain("failed");
    expect(actions[0].outcome).toContain("Connection refused");
  });

  // ---- Intent not found ----

  it("returns error when intent does not exist", async () => {
    const result = await orchestrator.executeStep({
      intentId: 999,
      actorId: 1,
      agentName: "fake-agent",
      task: "This should fail",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  // ---- Intent must be active ----

  it("rejects execution against a non-active intent", async () => {
    const intent = await repo.createIntent(
      {
        scope: "default",
        description: "Already closed intent",
        source: "test",
        status: "closed",
      },
      actorId(1)
    );

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Should not execute",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("closed");
    expect(result.error).toContain("must be 'active'");

    // No runtime invocations occurred
    expect(runtime.invocations).toHaveLength(0);
  });

  it("rejects execution against a draft intent", async () => {
    const intent = await repo.createIntent(
      {
        scope: "default",
        description: "Still in draft",
        source: "test",
        // status defaults to "draft"
      },
      actorId(1)
    );

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Should not execute",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("draft");
  });

  // ---- Interpretation validation ----

  it("rejects when interpretation does not exist", async () => {
    const { intent } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: 999,
      actorId: 1,
      agentName: "fake-agent",
      task: "Should not execute",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Interpretation 999 not found");
  });

  it("rejects when interpretation belongs to a different intent", async () => {
    const { intent } = await seedGovernanceState();

    // Create a second intent with its own interpretation
    const otherIntent = await repo.createIntent(
      { scope: "default", description: "Other intent", source: "test", status: "active" },
      actorId(1)
    );
    const otherInterp = await repo.createInterpretation({
      intentId: otherIntent.id,
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Belongs to other intent",
      status: "proposed",
      alignment: "aligned",
    });

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: otherInterp.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Should not execute",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("belongs to intent");
    expect(result.error).toContain(String(otherIntent.id));
  });

  it("rejects when interpretation is superseded", async () => {
    const { intent, interp } = await seedGovernanceState();

    // Supersede the interpretation
    await repo.supersedeInterpretation(
      interp.id,
      "Updated understanding",
      "Original was wrong"
    );

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: interp.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Should not execute against superseded interp",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("superseded");
  });

  // ---- Workspace failure is non-fatal ----

  it("continues execution when workspace acquisition fails", async () => {
    workspaces.shouldFail = true;
    const { intent } = await seedGovernanceState();

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Task with workspace that fails to create",
      workspaceRef: "broken-workspace",
    });

    // Execution still succeeded — workspace failure was non-fatal
    expect(result.ok).toBe(true);
    expect(result.foldBack!.result.status).toBe("completed");

    // Event trail includes workspace failure
    const events = await repo.listEvents({ entityTable: "intents" });
    const wsFail = events.find((e) => e.eventType === "execution.workspace_failed");
    expect(wsFail).toBeDefined();
  });

  // ---- No Local ontology leak ----

  it("governance records contain no Local-native terms", async () => {
    const { intent } = await seedGovernanceState();

    await orchestrator.executeStep({
      intentId: intent.id,
      actorId: 1,
      agentName: "fake-agent",
      task: "Verify output files",
      workspaceRef: "verification-ws",
    });

    // Check all events for forbidden terms
    const events = await repo.listEvents({});
    const forbidden = ["company", "goal", "project", "issue", "board", "org_chart", "approval", "budget_policy"];
    for (const event of events) {
      const eventStr = JSON.stringify(event);
      for (const term of forbidden) {
        expect(eventStr).not.toContain(term);
      }
    }

    // Check all actions
    const actions = await repo.listActions({});
    for (const action of actions) {
      const actionStr = JSON.stringify(action);
      for (const term of forbidden) {
        expect(actionStr).not.toContain(term);
      }
    }
  });

  // ---- Portability: alternate task uses same code ----

  it("handles another coordination task with identical code paths", async () => {
    // This proves success criterion (d): same engine code works across tasks.
    const intent = await repo.createIntent(
      {
        scope: "product",
        description: "Deploy staging environment for client demo",
        source: "ops-team",
        status: "active",
      },
      actorId(1)
    );

    const interp = await repo.createInterpretation({
      intentId: intent.id,
      domainId: domainId(2),
      actorId: actorId(2),
      title: "Run deploy script against staging cluster",
      status: "proposed",
      alignment: "aligned",
    });

    const result = await orchestrator.executeStep({
      intentId: intent.id,
      interpretationId: interp.id,
      actorId: 2,
      agentName: "deploy-agent",
      task: "Deploy latest build to staging",
      context: { cluster: "staging-us-east-1" },
    });

    // Same code, different organisation's data
    expect(result.ok).toBe(true);
    expect(result.foldBack!.result.status).toBe("completed");

    const actions = await repo.listActions({ intentId: intent.id });
    expect(actions).toHaveLength(1);
    expect(actions[0].description).toContain("Deploy latest build");
  });
});
