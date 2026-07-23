import { describe, expect, it } from "vitest";
import { actorId, domainId, intendId, interpretationId } from "../../src/governance/domain.js";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { GovernanceService } from "../../src/governance/service.js";
import {
  buildOperatorSurfaceState,
  buildOperatorUiManifest,
  renderHumanSurfaceRuntime,
  renderOperatorRuntime,
} from "../../src/ui/runtime.js";

describe("operator UI runtime", () => {
  it("renders a self-contained 380px sidebar runtime with embedded snapshot state", async () => {
    const { repo, service } = await fixture();
    const state = await buildOperatorSurfaceState({
      repo,
      service,
      defaultActor: "runtime-agent",
      publicMcpBaseUrl: "https://mcp.example?token=do-not-keep",
    });
    const runtime = renderOperatorRuntime(state, {
      mode: "mcp-sandbox",
      includeState: true,
      publicMcpBaseUrl: "https://mcp.example?token=do-not-keep",
    });

    expect(runtime.mediaType).toBe("text/html");
    expect(runtime.sha256).toHaveLength(64);
    expect(runtime.html).toContain("width: min(380px, 100vw)");
    expect(runtime.html).toContain("grid-template-rows: auto auto auto auto minmax(0, 1fr) auto auto");
    expect(runtime.html).toContain("const plural");
    expect(runtime.html).toContain('"mode":"mcp-sandbox"');
    expect(runtime.html).toContain("Divergent reading A");
    expect(runtime.html).not.toContain("do-not-keep");
  });

  it("computes divergence groups and supersession chain projections", async () => {
    const { repo, service } = await fixture();
    const state = await buildOperatorSurfaceState({ repo, service, defaultActor: "runtime-agent" });

    expect(state.divergenceGroups).toEqual([
      expect.objectContaining({
        id: "group:1",
        intentId: 1,
        count: 2,
        interpretationIds: expect.arrayContaining([1, 2]),
      }),
    ]);
    expect(state.supersessionChains).toEqual([
      expect.objectContaining({
        currentId: 4,
        predecessorIds: [3],
        depth: 1,
      }),
    ]);
  });

  it("generates stable shell hashes and action descriptors for MCP clients", () => {
    const first = renderOperatorRuntime(undefined, { mode: "mcp-sandbox", includeState: false });
    const second = renderOperatorRuntime(undefined, { mode: "mcp-sandbox", includeState: false });
    const manifest = buildOperatorUiManifest({ runtime: first });

    expect(first.sha256).toBe(second.sha256);
    expect(manifest.sha256).toBe(first.sha256);
    expect(manifest.requiredMcpTools).toEqual(expect.arrayContaining([
      "ui_manifest",
      "ui_runtime_get",
      "operator_state_get",
      "intent_create",
      "interpretation_supersede",
    ]));
    expect(manifest.actionDescriptors.intent_create).toMatchObject({
      tool: "intent_create",
    });
  });

  it("renders the mediation centre workbench shell with embedded live state", async () => {
    const { repo, service } = await fixture();
    const state = await buildOperatorSurfaceState({ repo, service, defaultActor: "runtime-agent" });
    const runtime = renderHumanSurfaceRuntime(state);

    expect(runtime.mediaType).toBe("text/html");
    expect(runtime.version).toBe("0.1.0");
    expect(runtime.sha256).toHaveLength(64);
    expect(runtime.html).toContain("Mediation Centre");
    expect(runtime.html).toContain("Needs Mediation");
    expect(runtime.html).toContain("Active Planning");
    expect(runtime.html).toContain("Draft / Intake");
    expect(runtime.html).toContain("Recently Closed");
    expect(runtime.html).toContain("Observed");
    expect(runtime.html).toContain("Divergence Composer");
    expect(runtime.html).toContain("id=\"intent-modal\"");
    expect(runtime.html).toContain("Headline");
    expect(runtime.html).toContain("Body");
    expect(runtime.html).toContain("data-act=\"open-create-intent\"");
    expect(runtime.html).toContain("data-act=\"toggle-group\"");
    expect(runtime.html).toContain("data-act=\"nav-view\"");
    expect(runtime.html).toContain("class=\"header-menu\"");
    expect(runtime.html).toContain("id=\"header-menu\"");
    expect(runtime.html).toContain("class=\"brand-lockup\"");
    expect(runtime.html).toContain("id=\"live-stripe\"");
    expect(runtime.html).toContain("class=\"drawer-rail\"");
    expect(runtime.html).toContain("class=\"drawer-tabs\"");
    expect(runtime.html).toContain("Trail");
    expect(runtime.html).toContain("Headline required");
    expect(runtime.html).toContain("data-act=\"undo-write\"");
    expect(runtime.html).not.toContain("id=\"detail-toggle-button\"");
    expect(runtime.html).not.toContain("data-act=\"toggle-detail-drawer\"");
    expect(runtime.html).toContain("data-act=\"close-detail-drawer\"");
    expect(runtime.html).toContain("class=\"drawer-scrim\"");
    expect(runtime.html).toContain("body.detail-open .drawer");
    expect(runtime.html).not.toContain("class=\"sidebar\"");
    expect(runtime.html).toContain("Divergent reading A");
    expect(runtime.html).toContain(".board-wrap { min-height: 0; overflow: visible;");
    expect(runtime.html).toContain("animation-timeline: view()");
    expect(runtime.html).toContain("transition-behavior: allow-discrete");
    expect(runtime.html).toContain(".toolbar-actions { width: 100%; min-width: 0; flex-wrap: wrap;");
    expect(runtime.html).toContain(".table-head div:nth-child(n+6), .table-row .cell:nth-child(n+6) { display: none; }");
    expect(runtime.html).toContain('"name":"cml-mediation-centre"');
    expect(runtime.html).toContain('data-act="submit-supersede"');
    expect(runtime.html).toContain("Supersede Interpretation");
    expect(runtime.html).toContain("Replacement headline");
    expect(runtime.html).toContain('event.entityTable === "actions"');
    expect(runtime.html).toContain('event.entityTable === "reports"');
    expect(runtime.html).toContain(".live-stripe.warn::before");
    expect(runtime.html).toContain("const plural");
    expect(runtime.html).not.toContain("rail-footer");
  });
});

async function fixture() {
  const repo = new InMemoryGovernanceRepository();
  await repo.registerScope("default");
  await repo.registerActor({
    name: "runtime-agent",
    role: "agent",
    provider: "openai-codex",
    capabilityNamespace: "runtime-test",
    defaultScope: "default",
  });
  await repo.registerDomain({
    name: "framework",
    scope: "default",
    concern: "runtime projection",
  });
  await repo.createIntent({
    scope: "default",
    description: "Resolve operator sidebar divergence",
    source: "test",
    status: "active",
  }, actorId(1));
  await repo.createInterpretation({
    intentId: intendId(1),
    domainId: domainId(1),
    actorId: actorId(1),
    title: "Divergent reading A",
    status: "flagged",
    alignment: "divergent",
  });
  await repo.createInterpretation({
    intentId: intendId(1),
    domainId: domainId(1),
    actorId: actorId(1),
    title: "Divergent reading B",
    status: "proposed",
    alignment: "divergent",
  });
  await repo.createInterpretation({
    intentId: intendId(1),
    domainId: domainId(1),
    actorId: actorId(1),
    title: "Old reading",
    status: "proposed",
    alignment: "uncertain",
  });
  await repo.supersedeInterpretation(interpretationId(3), "Replacement reading", "Runtime test");
  return { repo, service: new GovernanceService(repo) };
}
