/**
 * Governance Inspection Integration Tests
 *
 * Proves the read-composition functions return operator-legible views
 * of governance state for pre-execution inspection and general browsing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { GovernanceService } from "../../src/governance/service.js";
import { inspectIntent, inspectInterpretation, inspectIntentTree } from "../../src/orchestration/inspect.js";
import { actorId, domainId } from "../../src/governance/domain.js";

describe("inspectIntent", () => {
  let repo: InMemoryGovernanceRepository;
  let service: GovernanceService;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
  });

  async function seedRichIntent() {
    // Intent
    const intentRes = await service.registerIntent({
      description: "Verify M2 output across servers",
      source: "seb",
      scope: "default",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");
    const intentId = intentRes.data.id as number;

    // Domain + Actor
    const domain = await repo.registerDomain({
      scope: "default",
      name: "Runtime Ops",
      concern: "Server operations",
    });
    const actor = await repo.registerActor({
      name: "ops-agent",
      role: "agent",
      provider: "claude-code",
      capabilityNamespace: "runtime.invoke",
      defaultScope: "default",
    });

    // Two interpretations
    const interp1 = await service.registerInterpretation({
      intentId,
      domainId: domain.id as number,
      actorId: actor.id as number,
      title: "SSH to .52 and check outbox",
      status: "proposed",
      alignment: "aligned",
    });

    const interp2 = await service.registerInterpretation({
      intentId,
      domainId: domain.id as number,
      actorId: actor.id as number,
      title: "Also verify .57 LXC logs",
      status: "clarifying",
      alignment: "uncertain",
    });

    // An action
    await service.logAction({
      intentId,
      actorId: actor.id as number,
      description: "Checked .52 outbox — M2 files present",
      interpretationId: interp1.ok ? interp1.data.id as number : undefined,
      outcome: "3 JSONL files found",
    });

    // Expertise signal
    await service.registerExpertise({
      intentId,
      domainId: domain.id as number,
      actorId: actor.id as number,
      signal: "concerned",
      note: "Runtime ops owns server access",
    });

    // Claim
    await service.claim({
      entityTable: "intents",
      entityId: intentId,
      actorId: actor.id as number,
      note: "Working on verification",
    });

    return { intentId, domain, actor };
  }

  it("returns a complete inspection with all sections populated", async () => {
    const { intentId } = await seedRichIntent();
    const result = await inspectIntent(intentId, service);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data;

    // Intent
    expect(data.intent.id).toBe(intentId);
    expect(data.intent.description).toContain("M2");
    expect(data.intent.status).toBe("active");
    expect(data.intent.scope).toBe("default");

    // Interpretations
    expect(data.interpretations).toHaveLength(2);
    expect(data.interpretations[0].title).toContain(".52");
    expect(data.interpretations[1].title).toContain(".57");

    // Actions
    expect(data.actions).toHaveLength(1);
    expect(data.actions[0].description).toContain("Checked .52");
    expect(data.actions[0].outcome).toBe("3 JSONL files found");

    // Claims
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0].status).toBe("active");

    // Expertise signals
    expect(data.expertiseSignals).toHaveLength(1);
    expect(data.expertiseSignals[0].signal).toBe("concerned");

    // Events (intent_created + interpretation_filed x2 + action_logged + expertise + claim)
    expect(data.recentEvents.length).toBeGreaterThanOrEqual(1);

    // Summary
    expect(data.summary.interpretationCount).toBe(2);
    expect(data.summary.activeClaimCount).toBe(1);
    expect(data.summary.actionCount).toBe(1);
    expect(data.summary.domainsCovered).toBe(1);
  });

  it("returns error for non-existent intent", async () => {
    const result = await inspectIntent(999, service);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("not found");
  });

  it("handles intent with no interpretations or actions", async () => {
    const intentRes = await service.registerIntent({
      description: "Empty intent for inspection",
      source: "test",
      status: "draft",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const result = await inspectIntent(intentRes.data.id as number, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.data.interpretations).toHaveLength(0);
    expect(result.data.actions).toHaveLength(0);
    expect(result.data.claims).toHaveLength(0);
    expect(result.data.summary.interpretationCount).toBe(0);
    expect(result.data.summary.actionCount).toBe(0);
  });

  it("serialises to clean JSON with ISO dates and plain numbers", async () => {
    const { intentId } = await seedRichIntent();
    const result = await inspectIntent(intentId, service);
    if (!result.ok) throw new Error("unreachable");

    const json = JSON.stringify(result.data);
    expect(json).not.toContain("__brand");
    const parsed = JSON.parse(json);
    // Dates are ISO strings
    expect(parsed.intent.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // IDs are plain numbers
    expect(typeof parsed.intent.id).toBe("number");
    expect(typeof parsed.interpretations[0].id).toBe("number");
  });
});

describe("inspectInterpretation", () => {
  let repo: InMemoryGovernanceRepository;
  let service: GovernanceService;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
  });

  it("returns interpretation with linked intent, actions, and summary", async () => {
    const intentRes = await service.registerIntent({
      description: "Run diagnostics",
      source: "seb",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const domain = await repo.registerDomain({
      scope: "default",
      name: "Diagnostics",
      concern: "Health checks",
    });

    const interpRes = await service.registerInterpretation({
      intentId: intentRes.data.id as number,
      domainId: domain.id as number,
      actorId: 1,
      title: "Run disk and memory checks",
      scopeAssumption: "Server .52 only",
      status: "proposed",
      alignment: "aligned",
      sourceRef: "test-session",
    });
    if (!interpRes.ok) throw new Error("unreachable");
    const interpId = interpRes.data.id as number;

    // Log an action against this interpretation
    await service.logAction({
      intentId: intentRes.data.id as number,
      actorId: 1,
      description: "Ran disk check",
      interpretationId: interpId,
      outcome: "85% used",
    });

    const result = await inspectInterpretation(interpId, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data;

    // Interpretation
    expect(data.interpretation.id).toBe(interpId);
    expect(data.interpretation.title).toBe("Run disk and memory checks");
    expect(data.interpretation.scopeAssumption).toBe("Server .52 only");
    expect(data.interpretation.sourceRef).toBe("test-session");

    // Linked intent
    expect(data.intent.id).toBe(intentRes.data.id as number);
    expect(data.intent.description).toContain("diagnostics");

    // Actions
    expect(data.actions).toHaveLength(1);
    expect(data.actions[0].description).toBe("Ran disk check");

    // Summary
    expect(data.summary.actionCount).toBe(1);
    expect(data.summary.isSuperseded).toBe(false);
    expect(data.summary.isActionable).toBe(true);
  });

  it("marks superseded interpretation correctly in summary", async () => {
    const intentRes = await service.registerIntent({
      description: "Test intent",
      source: "test",
      status: "active",
    });
    if (!intentRes.ok) throw new Error("unreachable");

    const domain = await repo.registerDomain({
      scope: "default",
      name: "Test",
      concern: "Testing",
    });

    const interpRes = await service.registerInterpretation({
      intentId: intentRes.data.id as number,
      domainId: domain.id as number,
      actorId: 1,
      title: "Original understanding",
      status: "proposed",
    });
    if (!interpRes.ok) throw new Error("unreachable");

    // Supersede it
    await service.supersedeInterpretation({
      id: interpRes.data.id as number,
      newTitle: "Revised understanding",
      reason: "Original was incomplete",
    });

    const result = await inspectInterpretation(interpRes.data.id as number, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.data.summary.isSuperseded).toBe(true);
    expect(result.data.summary.isActionable).toBe(false);
    expect(result.data.interpretation.status).toBe("superseded");
    expect(result.data.interpretation.supersededBy).toBeDefined();
  });

  it("returns error for non-existent interpretation", async () => {
    const result = await inspectInterpretation(999, service);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("not found");
  });
});

describe("inspectIntentTree", () => {
  let repo: InMemoryGovernanceRepository;
  let service: GovernanceService;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
  });

  it("builds a tree with parent and sub-intents", async () => {
    // Parent directive with delegation sub-intents
    const parentRes = await service.registerIntent({
      description: "Build CML-native operating framework",
      source: "seb",
      scope: "default",
      status: "active",
    });
    if (!parentRes.ok) throw new Error("unreachable");
    const parentId = parentRes.data.id as number;

    const sub1Res = await service.registerIntent({
      description: "Node.js + scaffold verify",
      source: "seb",
      scope: "default",
      parentId,
      status: "closed",
    });

    const sub2Res = await service.registerIntent({
      description: "Governance store update",
      source: "seb",
      scope: "default",
      parentId,
      status: "closed",
    });

    const sub3Res = await service.registerIntent({
      description: "First vertical slice",
      source: "seb",
      scope: "default",
      parentId,
      status: "active",
    });

    const result = await inspectIntentTree(parentId, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const tree = result.data;

    expect(tree.root.id).toBe(parentId);
    expect(tree.root.description).toContain("operating framework");
    expect(tree.root.children).toHaveLength(3);
    expect(tree.totalIntents).toBe(4);
    expect(tree.statusCounts["active"]).toBe(2);
    expect(tree.statusCounts["closed"]).toBe(2);
  });

  it("builds nested delegation (grandchildren)", async () => {
    const rootRes = await service.registerIntent({
      description: "Top-level directive",
      source: "seb",
      scope: "default",
      status: "active",
    });
    if (!rootRes.ok) throw new Error("unreachable");
    const rootId = rootRes.data.id as number;

    const childRes = await service.registerIntent({
      description: "First delegation",
      source: "seb",
      scope: "default",
      parentId: rootId,
      status: "active",
    });
    if (!childRes.ok) throw new Error("unreachable");
    const childId = childRes.data.id as number;

    await service.registerIntent({
      description: "Sub-delegation (grandchild)",
      source: "seb",
      scope: "default",
      parentId: childId,
      status: "draft",
    });

    const result = await inspectIntentTree(rootId, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.data.root.children).toHaveLength(1);
    expect(result.data.root.children[0].children).toHaveLength(1);
    expect(result.data.root.children[0].children[0].description).toContain("grandchild");
    expect(result.data.totalIntents).toBe(3);
  });

  it("includes interpretation and action counts per node", async () => {
    const parentRes = await service.registerIntent({
      description: "Parent",
      source: "seb",
      scope: "default",
      status: "active",
    });
    if (!parentRes.ok) throw new Error("unreachable");
    const parentId = parentRes.data.id as number;

    const childRes = await service.registerIntent({
      description: "Child with activity",
      source: "seb",
      scope: "default",
      parentId,
      status: "active",
    });
    if (!childRes.ok) throw new Error("unreachable");
    const childId = childRes.data.id as number;

    const domain = await repo.registerDomain({
      scope: "default",
      name: "Ops",
      concern: "Operations",
    });

    // File interpretation on child
    await service.registerInterpretation({
      intentId: childId,
      domainId: domain.id as number,
      actorId: 1,
      title: "Plan for child",
      status: "proposed",
    });

    // Log action on child
    await service.logAction({
      intentId: childId,
      actorId: 1,
      description: "Did something on child",
    });

    const result = await inspectIntentTree(parentId, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    // Parent has no interpretations/actions
    expect(result.data.root.interpretationCount).toBe(0);
    expect(result.data.root.actionCount).toBe(0);

    // Child has both
    expect(result.data.root.children[0].interpretationCount).toBe(1);
    expect(result.data.root.children[0].actionCount).toBe(1);
  });

  it("handles leaf intent with no children", async () => {
    const leafRes = await service.registerIntent({
      description: "Standalone leaf",
      source: "seb",
      scope: "default",
      status: "active",
    });
    if (!leafRes.ok) throw new Error("unreachable");

    const result = await inspectIntentTree(leafRes.data.id as number, service);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.data.root.children).toHaveLength(0);
    expect(result.data.totalIntents).toBe(1);
  });

  it("returns error for non-existent root", async () => {
    const result = await inspectIntentTree(999, service);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("not found");
  });
});
