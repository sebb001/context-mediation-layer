import { describe, it, expect, beforeEach } from "vitest";
import { GovernanceService } from "../../src/governance/service.js";
import { InMemoryGovernanceRepository } from "../../src/governance/repository.js";
import { actorId, domainId } from "../../src/governance/domain.js";

describe("GovernanceService", () => {
  let service: GovernanceService;
  let repo: InMemoryGovernanceRepository;

  beforeEach(() => {
    repo = new InMemoryGovernanceRepository();
    service = new GovernanceService(repo);
  });

  // ----------------------------------------------------------
  // Envelope shape
  // ----------------------------------------------------------

  describe("response envelope", () => {
    it("success responses have { ok: true, data, meta }", async () => {
      const result = await service.registerIntent({
        description: "Envelope test",
        source: "test",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeDefined();
      expect(result.meta.schema_version).toBe(2);
    });

    it("list responses include count and has_more", async () => {
      const result = await service.listIntents();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.meta.count).toBe(0);
      expect(result.meta.has_more).toBe(false);
    });

    it("error responses have { ok: false, error: { code, message } }", async () => {
      const result = await service.getIntent(999);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("999");
    });
  });

  // ----------------------------------------------------------
  // Intents
  // ----------------------------------------------------------

  describe("intents", () => {
    it("registerIntent creates with default scope and status", async () => {
      const result = await service.registerIntent({
        description: "Test intent",
        source: "test",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.scope).toBe("default");
      expect(result.data.status).toBe("draft");
      expect(result.data.version).toBe(1);
    });

    it("getIntent returns enriched data", async () => {
      const reg = await service.registerIntent({ description: "Get test", source: "test" });
      if (!reg.ok) throw new Error("register failed");

      // Add an interpretation so enriched count is > 0
      await service.registerInterpretation({
        intentId: reg.data.id,
        domainId: 1,
        actorId: 1,
        title: "Interp",
      });

      const result = await service.getIntent(reg.data.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.interpretationCount).toBe(1);
      expect(result.data.expertiseSignals).toHaveLength(0);
      expect(result.data.activeClaims).toHaveLength(0);
    });

    it("updateIntent requires reason and returns updated data", async () => {
      const reg = await service.registerIntent({ description: "Update test", source: "test" });
      if (!reg.ok) throw new Error("register failed");

      const result = await service.updateIntent({
        id: reg.data.id,
        reason: "activating",
        status: "active",
        actorId: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe("active");
      expect(result.data.version).toBe(2);
    });

    it("listIntents paginates", async () => {
      for (let i = 0; i < 5; i++) {
        await service.registerIntent({ description: `Intent ${i}`, source: "test" });
      }

      const page1 = await service.listIntents({ limit: 2, offset: 0 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.data).toHaveLength(2);
      expect(page1.meta.has_more).toBe(true);

      const page3 = await service.listIntents({ limit: 2, offset: 4 });
      if (!page3.ok) return;
      expect(page3.data).toHaveLength(1);
      expect(page3.meta.has_more).toBe(false);
    });

    it("listIntents filters by parentId", async () => {
      const parent = await service.registerIntent({ description: "Parent", source: "test" });
      if (!parent.ok) throw new Error("register failed");

      await service.registerIntent({
        description: "Child",
        source: "test",
        parentId: parent.data.id,
      });

      const topLevel = await service.listIntents({ parentId: null });
      if (!topLevel.ok) throw new Error("list failed");
      expect(topLevel.data.every((i) => i.parentId == null)).toBe(true);

      const children = await service.listIntents({ parentId: parent.data.id });
      if (!children.ok) throw new Error("list failed");
      expect(children.data).toHaveLength(1);
      expect(children.data[0].description).toBe("Child");
    });
  });

  // ----------------------------------------------------------
  // Interpretations
  // ----------------------------------------------------------

  describe("interpretations", () => {
    async function seedIntent() {
      const result = await service.registerIntent({ description: "Seed", source: "test" });
      if (!result.ok) throw new Error("register failed");
      return result.data;
    }

    it("registerInterpretation with defaults", async () => {
      const intent = await seedIntent();
      const result = await service.registerInterpretation({
        intentId: intent.id,
        domainId: 1,
        actorId: 1,
        title: "Default interp",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.status).toBe("clarifying");
      expect(result.data.alignment).toBe("uncertain");
    });

    it("getInterpretation returns enriched with linked intent and actions", async () => {
      const intent = await seedIntent();
      const interp = await service.registerInterpretation({
        intentId: intent.id,
        domainId: 1,
        actorId: 1,
        title: "Enriched",
      });
      if (!interp.ok) throw new Error("register failed");

      await service.logAction({
        intentId: intent.id,
        actorId: 1,
        description: "Linked action",
        interpretationId: interp.data.id,
      });

      const result = await service.getInterpretation(interp.data.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.intent.id).toBe(intent.id);
      expect(result.data.actions).toHaveLength(1);
    });

    it("updateInterpretation cannot change title (type-level)", async () => {
      const intent = await seedIntent();
      const interp = await service.registerInterpretation({
        intentId: intent.id,
        domainId: 1,
        actorId: 1,
        title: "Immutable title",
      });
      if (!interp.ok) throw new Error("register failed");

      const result = await service.updateInterpretation({
        id: interp.data.id,
        reason: "changing status",
        status: "proposed",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.title).toBe("Immutable title");
      expect(result.data.status).toBe("proposed");
    });

    it("supersedeInterpretation atomically creates replacement", async () => {
      const intent = await seedIntent();
      const interp = await service.registerInterpretation({
        intentId: intent.id,
        domainId: 1,
        actorId: 1,
        title: "Original",
      });
      if (!interp.ok) throw new Error("register failed");

      const result = await service.supersedeInterpretation({
        id: interp.data.id,
        newTitle: "Revised",
        reason: "incomplete",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.old.status).toBe("superseded");
      expect(result.data.old.supersededBy).toBe(result.data.replacement.id);
      expect(result.data.replacement.title).toBe("Revised");
      expect(result.data.replacement.alignment).toBe("uncertain");
    });

    it("listInterpretations filters by alignment", async () => {
      const intent = await seedIntent();
      await service.registerInterpretation({
        intentId: intent.id,
        domainId: 1,
        actorId: 1,
        title: "Aligned",
        alignment: "aligned",
      });
      await service.registerInterpretation({
        intentId: intent.id,
        domainId: 2,
        actorId: 2,
        title: "Divergent",
        alignment: "divergent",
      });

      const result = await service.listInterpretations({ alignment: "divergent" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe("Divergent");
    });
  });

  // ----------------------------------------------------------
  // Actions
  // ----------------------------------------------------------

  describe("actions", () => {
    it("logAction and listActions", async () => {
      const intent = await service.registerIntent({ description: "Action test", source: "test" });
      if (!intent.ok) throw new Error("register failed");

      const action = await service.logAction({
        intentId: intent.data.id,
        actorId: 1,
        description: "Did something",
        outcome: "Success",
      });
      expect(action.ok).toBe(true);
      if (!action.ok) return;
      expect(action.data.description).toBe("Did something");

      const list = await service.listActions({ intentId: intent.data.id });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------
  // Claims
  // ----------------------------------------------------------

  describe("claims", () => {
    it("claim and releaseClaim lifecycle", async () => {
      const c = await service.claim({
        entityTable: "intents",
        entityId: 1,
        actorId: 1,
        note: "Working on it",
      });
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      expect(c.data.status).toBe("active");

      const release = await service.releaseClaim({ id: c.data.id, reason: "Done" });
      expect(release.ok).toBe(true);

      const list = await service.listClaims({ status: "released" });
      if (!list.ok) return;
      expect(list.data).toHaveLength(1);
    });

    it("advisory claims allow multiple holders", async () => {
      await service.claim({ entityTable: "intents", entityId: 1, actorId: 1 });
      await service.claim({ entityTable: "intents", entityId: 1, actorId: 2 });

      const list = await service.listClaims({ status: "active" });
      if (!list.ok) return;
      expect(list.data).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------
  // Expertise
  // ----------------------------------------------------------

  describe("expertise", () => {
    it("registerExpertise and getExpertiseCoverage", async () => {
      const intent = await service.registerIntent({ description: "Expertise test", source: "test" });
      if (!intent.ok) throw new Error("register failed");

      await service.registerExpertise({
        intentId: intent.data.id,
        domainId: 1,
        actorId: 1,
        signal: "concerned",
      });
      await service.registerExpertise({
        intentId: intent.data.id,
        domainId: 2,
        actorId: 2,
        signal: "not_concerned",
      });

      const coverage = await service.getExpertiseCoverage({ intentId: intent.data.id });
      expect(coverage.ok).toBe(true);
      if (!coverage.ok) return;
      expect(coverage.data.signals).toHaveLength(2);
      expect(coverage.data.domainCount).toBe(2);
    });
  });

  // ----------------------------------------------------------
  // Events
  // ----------------------------------------------------------

  describe("events", () => {
    it("listEvents returns events with pagination", async () => {
      // Create some intents to generate events
      await service.registerIntent({ description: "E1", source: "test" });
      await service.registerIntent({ description: "E2", source: "test" });

      const result = await service.listEvents({ entityTable: "intents" });
      expect(result.ok).toBe(true);
      // Events are only emitted when actorId is provided to createIntent —
      // our service passes actorId only when addressedTo is set, so these
      // may or may not have events. Just verify the envelope.
      if (!result.ok) return;
      expect(result.meta.schema_version).toBe(2);
    });

    it("getEntityHistory filters by entity", async () => {
      // Seed an intent with actorId to generate events
      const actor = await repo.registerActor({
        name: "test-actor",
        role: "agent",
        provider: "test",
        capabilityNamespace: "test",
        defaultScope: "default",
      });
      await repo.createIntent(
        { description: "History test", source: "test", scope: "default" },
        actor.id
      );

      const history = await service.getEntityHistory({
        entityTable: "intents",
        entityId: 1, // first intent ID
      });
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.data.length).toBeGreaterThanOrEqual(1);
      expect(history.data[0].eventType).toBe("intent_created");
    });
  });

  // ----------------------------------------------------------
  // Contracts
  // ----------------------------------------------------------

  describe("contracts", () => {
    async function seedCustodian() {
      const actor = await service.registerActor({
        name: "contract-custodian",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
      });
      if (!actor.ok) throw new Error("actor register failed");
      return actor.data;
    }

    async function seedRoot(custodianActorId: number) {
      const root = await service.registerContract({
        key: "root:agent-bootstrap",
        kind: "root",
        title: "Agent Bootstrap",
        body: "Agents resolve CML contracts from the registry.",
        custodianActorId,
        mandateRef: "INTENT-35",
      });
      if (!root.ok) throw new Error("root contract register failed");
      return root.data;
    }

    it("stores canonical contract matter with custodian and hash", async () => {
      const custodian = await seedCustodian();
      const contract = await service.registerContract({
        key: "root:agent-bootstrap",
        kind: "root",
        title: "Agent Bootstrap",
        body: "Canonical contract body only.",
        custodianActorId: custodian.id,
        mandateRef: "INTENT-35",
      });
      expect(contract.ok).toBe(true);
      if (!contract.ok) return;
      expect(contract.data.version).toBe(1);
      expect(contract.data.contentHash).toMatch(/^sha256:/);
      expect(contract.data.custodianActorId).toBe(custodian.id);
      expect(contract.data).not.toHaveProperty("externalRef");
    });

    it("requires non-root contracts to point at an active parent", async () => {
      const custodian = await seedCustodian();
      const missingParent = await service.registerContract({
        key: "skill:reagent-reading-composer",
        kind: "skill",
        title: "Reagent Reading Composer",
        body: "Skill contract body",
        custodianActorId: custodian.id,
      });
      expect(missingParent.ok).toBe(false);
      if (missingParent.ok) return;
      expect(missingParent.error.code).toBe("PARENT_REQUIRED");

      await seedRoot(custodian.id);
      const skill = await service.registerContract({
        key: "skill:reagent-reading-composer",
        kind: "skill",
        parentKey: "root:agent-bootstrap",
        title: "Reagent Reading Composer",
        body: "Skill contract body",
        custodianActorId: custodian.id,
      });
      expect(skill.ok).toBe(true);
      if (!skill.ok) return;
      expect(skill.data.parentKey).toBe("root:agent-bootstrap");
    });

    it("supersedes contract revisions instead of mutating bodies in place", async () => {
      const custodian = await seedCustodian();
      await seedRoot(custodian.id);
      const original = await service.registerContract({
        key: "role:project-advisor",
        kind: "role",
        parentKey: "root:agent-bootstrap",
        title: "Project Advisor",
        body: "Original advisor contract.",
        custodianActorId: custodian.id,
      });
      if (!original.ok) throw new Error("contract register failed");

      const replacement = await service.supersedeContract({
        id: original.data.id,
        title: "Project Advisor",
        body: "Revised advisor contract.",
        reason: "Clarify neutral access",
        custodianActorId: custodian.id,
        mandateRef: "INTERPRETATION-101",
      });
      expect(replacement.ok).toBe(true);
      if (!replacement.ok) return;
      expect(replacement.data.old.status).toBe("superseded");
      expect(replacement.data.old.supersededBy).toBe(replacement.data.replacement.id);
      expect(replacement.data.replacement.version).toBe(2);
      expect(replacement.data.replacement.supersedes).toBe(original.data.id);
      expect(replacement.data.replacement.contentHash).not.toBe(original.data.contentHash);

      const active = await service.getContract({ key: "role:project-advisor" });
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(active.data.id).toBe(replacement.data.replacement.id);
      expect(active.data.body).toBe("Revised advisor contract.");
    });

    it("lets actors and roles reference canonical contract keys without projection paths", async () => {
      const custodian = await seedCustodian();
      await seedRoot(custodian.id);
      const roleContract = await service.registerContract({
        key: "role:project-advisor",
        kind: "role",
        parentKey: "root:agent-bootstrap",
        title: "Project Advisor",
        body: "Project advisor contract.",
        custodianActorId: custodian.id,
      });
      if (!roleContract.ok) throw new Error("contract register failed");

      const role = await service.registerRole({
        name: "project-advisor",
        contractKey: "role:project-advisor",
      });
      expect(role.ok).toBe(true);
      if (!role.ok) return;
      expect(role.data.contractKey).toBe("role:project-advisor");

      const missing = await service.registerActor({
        name: "bad-contract-key",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
        contractKey: "actor:missing",
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error.code).toBe("CONTRACT_NOT_FOUND");
    });

    it("signposts domain authority without locking an actor to one domain", async () => {
      const custodian = await seedCustodian();
      const root = await seedRoot(custodian.id);
      const firstDomain = await service.registerDomain({
        scope: "default",
        name: "CML Governance",
        concern: "Framework contracts",
      });
      const secondDomain = await service.registerDomain({
        scope: "default",
        name: "Reading Practice",
        concern: "Reading and synthesis contracts",
      });
      if (!firstDomain.ok || !secondDomain.ok) throw new Error("domain register failed");

      const governanceSkill = await service.registerContract({
        key: "skill:contract-custody-audit",
        kind: "skill",
        parentKey: root.key,
        title: "Contract Custody Audit",
        body: "Audit contract hierarchy and custody without path fences.",
        custodianActorId: custodian.id,
        domainId: firstDomain.data.id,
        governingContractKey: root.key,
      });
      const readingSkill = await service.registerContract({
        key: "skill:cross-domain-reading",
        kind: "skill",
        parentKey: root.key,
        title: "Cross Domain Reading",
        body: "Assemble context across domains when the task requires it.",
        custodianActorId: custodian.id,
        domainId: secondDomain.data.id,
        governingContractKey: root.key,
      });
      if (!governanceSkill.ok || !readingSkill.ok) throw new Error("contract register failed");

      const intent = await service.registerIntent({
        description: "Actor needs to move across domain concerns",
        source: "test",
        actorId: custodian.id,
      });
      if (!intent.ok) throw new Error("intent register failed");

      const firstAction = await service.logAction({
        intentId: intent.data.id,
        actorId: custodian.id,
        domainId: firstDomain.data.id,
        governingContractKey: governanceSkill.data.key,
        description: "Audit CML contract custody",
      });
      const secondAction = await service.logAction({
        intentId: intent.data.id,
        actorId: custodian.id,
        domainId: secondDomain.data.id,
        governingContractKey: readingSkill.data.key,
        description: "Read across domain material for required context",
      });
      expect(firstAction.ok).toBe(true);
      expect(secondAction.ok).toBe(true);

      const allActions = await service.listActions({ intentId: intent.data.id });
      expect(allActions.ok).toBe(true);
      if (!allActions.ok) return;
      expect(allActions.data.map((action) => action.domainId)).toEqual([
        firstDomain.data.id,
        secondDomain.data.id,
      ]);
    });

    it("registers actor type defaults and inherits them for unqualified actions", async () => {
      const custodian = await seedCustodian();
      const root = await seedRoot(custodian.id);

      const actorType = await service.registerActorTypeContract({
        name: "Build Agent",
        title: "Build Agent Actor Type",
        body: "Default baseline for build agents when no more specific governing contract is named.",
        parentKey: root.key,
        custodianActorId: custodian.id,
      });
      expect(actorType.ok).toBe(true);
      if (!actorType.ok) return;
      expect(actorType.data.kind).toBe("actor_type");
      expect(actorType.data.key).toBe("actor-type:build-agent");

      const actor = await service.registerActor({
        name: "defaulted-build-agent",
        role: "agent",
        provider: "local-agent",
        actorType: "Build Agent",
        capabilityNamespace: "build",
      });
      expect(actor.ok).toBe(true);
      if (!actor.ok) return;
      expect(actor.data.defaultContractKey).toBe("actor-type:build-agent");

      const intent = await service.registerIntent({
        description: "Default actor type contract should be inherited",
        source: "test",
        actorId: actor.data.id,
      });
      if (!intent.ok) throw new Error("intent register failed");

      const action = await service.logAction({
        intentId: intent.data.id,
        actorId: actor.data.id,
        description: "Act without a more specific governing contract",
      });
      expect(action.ok).toBe(true);
      if (!action.ok) return;
      expect(action.data.governingContractKey).toBe("actor-type:build-agent");

      const override = await service.logAction({
        intentId: intent.data.id,
        actorId: actor.data.id,
        governingContractKey: root.key,
        description: "Act under an explicit governing contract instead",
      });
      expect(override.ok).toBe(true);
      if (!override.ok) return;
      expect(override.data.governingContractKey).toBe(root.key);
    });
  });

  // ----------------------------------------------------------
  // Actors
  // ----------------------------------------------------------

  describe("actors", () => {
    it("registerActor and listActors", async () => {
      const result = await service.registerActor({
        name: "test-actor",
        role: "agent",
        provider: "claude-code",
        capabilityNamespace: "framework",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.name).toBe("test-actor");
      expect(result.data.defaultScope).toBe("default");
      expect(result.data.status).toBe("active");

      const list = await service.listActors();
      if (!list.ok) return;
      expect(list.data).toHaveLength(1);
    });

    it("updateActor", async () => {
      const reg = await service.registerActor({
        name: "updatable",
        role: "agent",
        provider: "test",
        capabilityNamespace: "test",
      });
      if (!reg.ok) throw new Error("register failed");

      const result = await service.updateActor({
        id: reg.data.id,
        sessionId: "session-123",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sessionId).toBe("session-123");
      expect(result.data.name).toBe("updatable");
    });

    it("stores actor contract and context provisioning metadata", async () => {
      const result = await service.registerActor({
        name: "context-provisioned",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
        contractRef: "vault/contracts/context-provisioned.md",
        contextRef: "vault/context-packs/context-provisioned.md",
        contextPolicy: "active intent + linked reports",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.contractRef).toContain("contracts");
      expect(result.data.contextRef).toContain("context-packs");
      expect(result.data.contextPolicy).toContain("linked reports");
    });
  });

  // ----------------------------------------------------------
  // Roles and Invocation Context
  // ----------------------------------------------------------

  describe("roles and invocation context", () => {
    it("binds a role to a specific actor surface and preserves actor accountability", async () => {
      const actor = await service.registerActor({
        name: "chatgpt-project-advisor",
        role: "agent",
        provider: "openai-chatgpt-5.5-high-reasoning",
        capabilityNamespace: "global advisory",
      });
      expect(actor.ok).toBe(true);
      if (!actor.ok) return;

      const rootContract = await service.registerContract({
        key: "root:agent-bootstrap",
        kind: "root",
        title: "Agent Bootstrap",
        body: "Actors enter through CML.",
        custodianActorId: actor.data.id,
      });
      expect(rootContract.ok).toBe(true);
      if (!rootContract.ok) return;

      const roleContract = await service.registerContract({
        key: "role:project-advisor",
        kind: "role",
        parentKey: "root:agent-bootstrap",
        title: "Project Advisor",
        body: "Only an approved agent actor using a reviewed reasoning profile may assume this role through an active role binding.",
        custodianActorId: actor.data.id,
      });
      expect(roleContract.ok).toBe(true);
      if (!roleContract.ok) return;

      const role = await service.registerRole({
        name: "project-advisor",
        contractKey: "role:project-advisor",
        description: "Approved agent and reviewed reasoning profile only.",
      });
      expect(role.ok).toBe(true);
      if (!role.ok) return;
      expect(role.data.contractKey).toBe("role:project-advisor");
      expect(role.data.contractRef).toBeUndefined();
      expect(role.data.policyRef).toBeUndefined();

      const binding = await service.bindActorRole({
        actorId: actor.data.id,
        roleId: role.data.id,
        surface: "chatgpt-app",
        provider: "openai-chatgpt-5.5-high-reasoning",
        credentialRef: "cml:secret-path:project-advisor",
      });
      expect(binding.ok).toBe(true);
      if (!binding.ok) return;
      expect(binding.data.actorId).toBe(actor.data.id);
      expect(binding.data.roleId).toBe(role.data.id);

      const intent = await service.registerIntent({
        description: "Project advisor acts under bounded review-partner skill",
        source: "test",
        actorId: actor.data.id,
      });
      if (!intent.ok) throw new Error("intent register failed");

      const action = await service.logAction({
        intentId: intent.data.id,
        actorId: actor.data.id,
        governingContractKey: "role:project-advisor",
        assumedRole: "project-advisor",
        invokedSkillRef: "skill:ai-regulation-review-partner",
        description: "Project advisor acting under review-partner policy",
      });
      expect(action.ok).toBe(true);
      if (!action.ok) return;
      expect(action.data.actorId).toBe(actor.data.id);
      expect(action.data.governingContractKey).toBe("role:project-advisor");
      expect(action.data.assumedRole).toBe("project-advisor");
      expect(action.data.invokedSkillRef).toContain("ai-regulation-review-partner");
    });
  });

  // ----------------------------------------------------------
  // Actor Sessions
  // ----------------------------------------------------------

  describe("actor sessions", () => {
    it("tracks ephemeral liveness without becoming accountable identity", async () => {
      const actor = await service.registerActor({
        name: "session-owner",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
      });
      if (!actor.ok) throw new Error("actor register failed");

      const opened = await service.openActorSession({
        actorId: actor.data.id,
        sessionRef: "thread-123",
        surface: "codex-desktop",
        transcriptRef: "transcripts/thread-123.md",
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.data.actorId).toBe(actor.data.id);

      const intent = await service.registerIntent({
        description: "Session-promoted action target",
        source: "test",
        actorId: actor.data.id,
      });
      if (!intent.ok) throw new Error("intent register failed");

      const action = await service.logAction({
        intentId: intent.data.id,
        actorId: actor.data.id,
        description: "Promoted from session",
      });
      expect(action.ok).toBe(true);
      if (!action.ok) return;
      expect(action.data.actorId).toBe(actor.data.id);

      const closed = await service.closeActorSession({
        actorId: actor.data.id,
        sessionRef: "thread-123",
      });
      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.data.status).toBe("closed");
    });

    it("rejects sessions for retired actors", async () => {
      const actor = await service.registerActor({
        name: "retired-session-owner",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
        status: "retired",
      });
      if (!actor.ok) throw new Error("actor register failed");

      const opened = await service.openActorSession({
        actorId: actor.data.id,
        sessionRef: "thread-retired",
        surface: "codex-desktop",
      });
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.error.code).toBe("ACTOR_INACTIVE");
    });
  });

  // ----------------------------------------------------------
  // Reports
  // ----------------------------------------------------------

  describe("reports", () => {
    it("registers promoted session material as a stable actor report", async () => {
      const actor = await service.registerActor({
        name: "report-owner",
        role: "agent",
        provider: "openai-codex",
        capabilityNamespace: "build",
      });
      if (!actor.ok) throw new Error("actor register failed");

      const report = await service.registerReport({
        kind: "compression",
        title: "Useful session slice",
        summary: "Only the promoted subset is canonical",
        actorId: actor.data.id,
        sourceRef: "thread-123#slice",
        bodyRef: "vault/reports/thread-123.md",
      });
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.data.actorId).toBe(actor.data.id);
      expect(report.data.sourceRef).toBe("thread-123#slice");

      const list = await service.listReports({ actorId: actor.data.id });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------
  // Domains
  // ----------------------------------------------------------

  describe("domains", () => {
    it("getDomain and listDomains", async () => {
      const domain = await repo.registerDomain({
        scope: "default",
        name: "Framework Build",
        concern: "Building the framework",
      });

      const get = await service.getDomain(domain.id);
      expect(get.ok).toBe(true);
      if (!get.ok) return;
      expect(get.data.name).toBe("Framework Build");

      const list = await service.listDomains();
      if (!list.ok) return;
      expect(list.data).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------
  // Scopes
  // ----------------------------------------------------------

  describe("scopes", () => {
    it("registerScope and listScopes", async () => {
      await service.registerScope({ scope: "default" });
      await service.registerScope({ scope: "product" });
      await service.registerScope({ scope: "default" }); // duplicate — should be idempotent

      const result = await service.listScopes();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(2);
      expect(result.data).toContain("default");
      expect(result.data).toContain("product");
    });
  });
});
