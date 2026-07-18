import { AddressInfo } from "node:net";
import { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actorId, domainId, intendId } from "../../src/governance/domain.js";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { createCmlUiServer } from "../../src/ui/index.js";

describe("cml-ui HTTP surface", () => {
  let repo: InMemoryGovernanceRepository;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    repo = new InMemoryGovernanceRepository();
    await repo.registerScope("default");
    await repo.registerActor({
      name: "ui-operator",
      role: "operator",
      provider: "test",
      capabilityNamespace: "ui-test",
      defaultScope: "default",
    });
    await repo.registerDomain({
      name: "framework",
      scope: "default",
      concern: "operator legibility",
    });
    await repo.createIntent({
      scope: "default",
      description: "Build an operator surface",
      source: "test",
      status: "active",
    });
    await repo.createInterpretation({
      intentId: intendId(1),
      domainId: domainId(1),
      actorId: actorId(1),
      title: "Use existing inspection compositions",
      scopeAssumption: "The UI should project CML state without shadow state.",
      status: "proposed",
      alignment: "aligned",
      sourceRef: "test",
    });

    server = createCmlUiServer({
      repository: repo,
      defaultActor: "ui-operator",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("serves the operator shell", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Operator Surface");
  });

  it("serves the standalone mediation centre workbench", async () => {
    const response = await fetch(`${baseUrl}/mediation-centre`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Mediation Centre");
    expect(html).toContain("Needs Mediation");
    expect(html).toContain("Active Planning");
    expect(html).toContain("Draft / Intake");
    expect(html).toContain("Recently Closed");
    expect(html).toContain("Observed");
    expect(html).toContain("Divergence Composer");
    expect(html).toContain("id=\"intent-modal\"");
    expect(html).toContain("Headline");
    expect(html).toContain("Body");
    expect(html).toContain("data-act=\"open-create-intent\"");
    expect(html).toContain("class=\"header-menu\"");
    expect(html).toContain("id=\"header-menu\"");
    expect(html).toContain("class=\"brand-lockup\"");
    expect(html).toContain("id=\"live-stripe\"");
    expect(html).toContain("class=\"drawer-rail\"");
    expect(html).toContain("class=\"drawer-tabs\"");
    expect(html).toContain("Trail");
    expect(html).toContain("Headline required");
    expect(html).toContain("data-act=\"undo-write\"");
    expect(html).not.toContain("id=\"detail-toggle-button\"");
    expect(html).not.toContain("data-act=\"toggle-detail-drawer\"");
    expect(html).toContain("data-act=\"close-detail-drawer\"");
    expect(html).toContain("class=\"drawer-scrim\"");
    expect(html).not.toContain("class=\"sidebar\"");
    expect(html).toContain("Build an operator surface");
    expect(html).toContain('"name":"cml-mediation-centre"');
  });

  it("redirects the legacy human surface route to the mediation centre", async () => {
    const response = await fetch(`${baseUrl}/human-surface`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mediation-centre");
  });

  it("serves a setup-needed mediation centre when no DB is configured", async () => {
    const setupServer = createCmlUiServer();
    await new Promise<void>((resolve) => setupServer.listen(0, "127.0.0.1", resolve));
    const setupBaseUrl = `http://127.0.0.1:${(setupServer.address() as AddressInfo).port}`;

    const page = await fetch(`${setupBaseUrl}/mediation-centre`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Mediation Centre");
    expect(html).toContain("DB_PATH_REQUIRED");

    const state = await fetch(`${setupBaseUrl}/api/operator-state`);
    expect(state.status).toBe(503);
    await expect(state.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "DB_PATH_REQUIRED" },
    });

    setupServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => setupServer.close((error) => error ? reject(error) : resolve()));
  });

  it("lists intents and inspects an intent", async () => {
    const list = await fetch(`${baseUrl}/api/intents?status=active`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].description).toBe("Build an operator surface");

    const inspection = await fetch(`${baseUrl}/api/intents/1`);
    expect(inspection.status).toBe(200);
    const inspectionBody = await inspection.json();
    expect(inspectionBody.data.summary).toMatchObject({
      interpretationCount: 1,
      actionCount: 0,
    });
    expect(inspectionBody.data.interpretations[0]).toMatchObject({
      id: 1,
      title: "Use existing inspection compositions",
    });
  });

  it("serves an CML-native operator state composition", async () => {
    const response = await fetch(`${baseUrl}/api/operator-state`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.summary).toMatchObject({
      activeIntentCount: 1,
      interpretationCount: 1,
    });
    expect(body.data.divergenceGroups).toEqual([]);
    expect(body.data.supersessionChains).toEqual([]);
    expect(body.data.actor).toMatchObject({
      name: "ui-operator",
    });
    expect(body.data.interpretations[0]).toMatchObject({
      title: "Use existing inspection compositions",
      alignment: "aligned",
    });
    expect(body.data.attention).toHaveLength(0);
  });

  it("serves the operator UI manifest", async () => {
    const response = await fetch(`${baseUrl}/api/ui-manifest`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      name: "cml-operator-sidebar",
      mediaType: "text/html",
      publicMcpUrl: "https://mcp.example",
    });
    expect(body.data.requiredMcpTools).toEqual(expect.arrayContaining([
      "ui_runtime_get",
      "operator_state_get",
      "intent_create",
    ]));
  });

  it("inspects interpretation bodies", async () => {
    const response = await fetch(`${baseUrl}/api/interpretations/1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.interpretation).toMatchObject({
      id: 1,
      scopeAssumption: "The UI should project CML state without shadow state.",
    });
  });

  it("logs governed actions through the configured actor", async () => {
    const response = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentId: 1,
        description: "Recorded from UI",
        outcome: "Visible in intent inspection",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      intentId: 1,
      actorId: 1,
      description: "Recorded from UI",
      outcome: "Visible in intent inspection",
    });

    const inspection = await fetch(`${baseUrl}/api/intents/1`);
    const inspectionBody = await inspection.json();
    expect(inspectionBody.data.summary.actionCount).toBe(1);
  });

  it("registers interpretations through the configured actor", async () => {
    const response = await fetch(`${baseUrl}/api/interpretations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentId: 1,
        domainId: 1,
        title: "A second operator interpretation",
        scopeAssumption: "The UI can add native CML interpretation records.",
        alignment: "uncertain",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      intentId: 1,
      actorId: 1,
      domainId: 1,
      title: "A second operator interpretation",
      alignment: "uncertain",
    });
  });

  it("updates intents, writes focus events, and creates resolution intents", async () => {
    const focus = await fetch(`${baseUrl}/api/focus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: "intent",
        entityId: 1,
        pendingAction: "update",
        hasDraft: true,
      }),
    });
    expect(focus.status).toBe(201);
    const focusBody = await focus.json();
    expect(focusBody.data).toMatchObject({
      eventType: "operator_focus",
      entityTable: "intents",
      entityId: 1,
      actorId: 1,
    });

    const updated = await fetch(`${baseUrl}/api/intents/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Route to the UI operator",
        addressedTo: 1,
        resolutionNotes: "Still active.",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        id: 1,
        addressedTo: 1,
        resolutionNotes: "Still active.",
      },
    });

    const created = await fetch(`${baseUrl}/api/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Resolution intent for divergence group:1",
        parentId: 1,
        status: "draft",
      }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: {
        parentId: 1,
        status: "draft",
        source: "cml-ui:ui-operator",
      },
    });
  });

  it("updates and supersedes interpretations", async () => {
    const updated = await fetch(`${baseUrl}/api/interpretations/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Need clarification",
        status: "flagged",
        alignment: "divergent",
        scopeAssumption: "Updated by the operator sidebar.",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        id: 1,
        status: "flagged",
        alignment: "divergent",
        scopeAssumption: "Updated by the operator sidebar.",
      },
    });

    const superseded = await fetch(`${baseUrl}/api/interpretations/1/supersede`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "Append-only correction",
        newTitle: "Replacement operator interpretation",
        newScopeAssumption: "Corrected interpretation body.",
        newStatus: "proposed",
      }),
    });
    expect(superseded.status).toBe(201);
    await expect(superseded.json()).resolves.toMatchObject({
      data: {
        old: { id: 1, status: "superseded", supersededBy: 2 },
        replacement: { id: 2, title: "Replacement operator interpretation" },
      },
    });

    const state = await fetch(`${baseUrl}/api/operator-state`);
    const stateBody = await state.json();
    expect(stateBody.data.supersessionChains).toEqual([
      expect.objectContaining({ currentId: 2, predecessorIds: [1] }),
    ]);
  });

  it("creates and releases claims and registers expertise signals", async () => {
    const claim = await fetch(`${baseUrl}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityTable: "intents",
        entityId: 1,
        note: "Working this from the sidebar",
      }),
    });
    expect(claim.status).toBe(201);
    const claimBody = await claim.json();
    expect(claimBody.data).toMatchObject({
      entityTable: "intents",
      entityId: 1,
      actorId: 1,
      status: "active",
    });

    const expertise = await fetch(`${baseUrl}/api/expertise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentId: 1,
        domainId: 1,
        signal: "concerned",
        note: "Framework owns the interaction model.",
      }),
    });
    expect(expertise.status).toBe(201);
    await expect(expertise.json()).resolves.toMatchObject({
      data: {
        intentId: 1,
        domainId: 1,
        actorId: 1,
        signal: "concerned",
      },
    });

    const release = await fetch(`${baseUrl}/api/claims/${claimBody.data.id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Done" }),
    });
    expect(release.status).toBe(200);
    await expect(release.json()).resolves.toMatchObject({
      data: { released: true },
    });
  });

  it("registers governed reports through the configured actor", async () => {
    const response = await fetch(`${baseUrl}/api/reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentId: 1,
        kind: "operator-note",
        title: "Operator surface note",
        summary: "Reports are now writable from the UI.",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({
      intentId: 1,
      actorId: 1,
      kind: "operator-note",
      title: "Operator surface note",
    });
  });
});
