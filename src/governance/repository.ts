/**
 * Governance Repository
 *
 * In-memory store for governance primitives. No runtime or Local dependencies.
 * Phase 1: later versions will back this with SQLite or connect to governance store MCP.
 */

import {
  Intent,
  IntentId,
  IntentStatus,
  IntentEnriched,
  Interpretation,
  InterpretationId,
  InterpretationStatus,
  InterpretationAlignment,
  InterpretationEnriched,
  Action,
  ActionId,
  Claim,
  ClaimId,
  ClaimStatus,
  Domain,
  DomainId,
  Actor,
  ActorId,
  ActorRoleBinding,
  ActorRoleBindingId,
  ActorSession,
  ActorSessionId,
  ActorSessionStatus,
  ActorStatus,
  ActorRoleBindingStatus,
  GovernanceRole,
  GovernanceRoleStatus,
  ExpertiseSignalRecord,
  ExpertiseSignalId,
  Event,
  EventId,
  EventType,
  Contract,
  ContractId,
  ContractKind,
  ContractStatus,
  Report,
  ReportId,
  isValidClaimTransition,
  intendId,
  interpretationId,
  actionId,
  claimId,
  domainId,
  actorId,
  actorRoleBindingId,
  actorSessionId,
  eventId,
  expertiseSignalId,
  reportId,
  contractId,
  roleId,
} from "./domain.js";

export interface RepositoryError {
  code: "NOT_FOUND" | "CONFLICT" | "INVALID_TRANSITION" | "INVALID_STATE";
  message: string;
}

export type ActorCreate = Omit<Actor, "id" | "status" | "createdAt" | "updatedAt"> & {
  status?: ActorStatus;
};

export type GovernanceRoleCreate = Omit<GovernanceRole, "id" | "status" | "createdAt" | "updatedAt"> & {
  status?: GovernanceRoleStatus;
};

export type ActorRoleBindingCreate = Omit<ActorRoleBinding, "id" | "status" | "createdAt" | "updatedAt"> & {
  status?: ActorRoleBindingStatus;
};

export type ActorSessionCreate = Omit<ActorSession, "id" | "status" | "startedAt" | "lastSeenAt" | "endedAt"> & {
  status?: ActorSessionStatus;
};

export type ReportCreate = Omit<Report, "id" | "createdAt">;

export type ContractCreate = Omit<Contract, "id" | "status" | "version" | "createdAt" | "updatedAt" | "supersededBy"> & {
  status?: ContractStatus;
  version?: number;
  supersededBy?: ContractId;
};

export interface ContractSupersedeInput {
  title?: string;
  body: string;
  status?: ContractStatus;
  domainId?: DomainId;
  custodianActorId: ActorId;
  governingContractKey?: string;
  mandateRef?: string;
  contentHash: string;
}

export interface GovernanceRepository {
  // Intents
  createIntent(
    intent: Omit<Intent, "id" | "version" | "createdAt" | "updatedAt" | "status"> & { status?: IntentStatus },
    actorId?: ActorId
  ): Promise<Intent>;
  getIntent(id: IntentId): Promise<IntentEnriched | null>;
  updateIntent(
    id: IntentId,
    updates: Partial<Omit<Intent, "id" | "createdAt">>,
    reason: string,
    actorId?: ActorId
  ): Promise<Intent | RepositoryError>;
  listIntents(filters?: { scope?: string; status?: IntentStatus; parentId?: IntentId | null }): Promise<Intent[]>;

  // Interpretations
  createInterpretation(
    interpretation: Omit<Interpretation, "id" | "createdAt" | "updatedAt" | "status" | "alignment"> & {
      status?: InterpretationStatus;
      alignment?: InterpretationAlignment;
    }
  ): Promise<Interpretation>;
  getInterpretation(id: InterpretationId): Promise<InterpretationEnriched | null>;
  updateInterpretation(
    id: InterpretationId,
    updates: Partial<Omit<Interpretation, "id" | "createdAt" | "title">>,
    reason: string,
    actorId?: ActorId
  ): Promise<Interpretation | RepositoryError>;
  supersedeInterpretation(
    id: InterpretationId,
    newTitle: string,
    reason: string,
    newScopeAssumption?: string,
    newStatus?: InterpretationStatus
  ): Promise<{ old: Interpretation; replacement: Interpretation } | RepositoryError>;
  listInterpretations(filters?: {
    intentId?: IntentId;
    domainId?: DomainId;
    status?: InterpretationStatus;
    alignment?: string;
  }): Promise<Interpretation[]>;

  // Actions
  logAction(action: Omit<Action, "id" | "createdAt">): Promise<Action>;
  getAction(id: ActionId): Promise<Action | null>;
  listActions(filters?: {
    intentId?: IntentId;
    actorId?: ActorId;
    domainId?: DomainId;
    governingContractKey?: string;
  }): Promise<Action[]>;

  // Claims
  acquireClaim(entityTable: string, entityId: number, actor: ActorId, note?: string): Promise<Claim>;
  releaseClaim(id: ClaimId, reason?: string): Promise<void | RepositoryError>;
  getClaim(id: ClaimId): Promise<Claim | null>;
  listClaims(filters?: { entityTable?: string; entityId?: number; status?: ClaimStatus }): Promise<Claim[]>;

  // Domains
  registerDomain(domain: Omit<Domain, "id">): Promise<Domain>;
  getDomain(id: DomainId): Promise<Domain | null>;
  listDomains(): Promise<Domain[]>;

  // Contracts (canonical contract matter; no projection writes)
  registerContract(contract: ContractCreate): Promise<Contract | RepositoryError>;
  getContract(id: ContractId): Promise<Contract | null>;
  getContractByKey(key: string, status?: ContractStatus): Promise<Contract | null>;
  listContracts(filters?: {
    key?: string;
    kind?: ContractKind;
    scope?: string;
    domainId?: DomainId;
    status?: ContractStatus;
    parentKey?: string;
    governingContractKey?: string;
  }): Promise<Contract[]>;
  supersedeContract(
    id: ContractId,
    replacement: ContractSupersedeInput,
    reason: string
  ): Promise<{ old: Contract; replacement: Contract } | RepositoryError>;

  // Actors
  registerActor(actor: ActorCreate): Promise<Actor>;
  updateActor(id: ActorId, updates: Partial<Omit<Actor, "id" | "createdAt">>): Promise<Actor | RepositoryError>;
  getActor(id: ActorId): Promise<Actor | null>;
  getActorByName(name: string): Promise<Actor | null>;
  listActors(filters?: { status?: ActorStatus; provider?: string }): Promise<Actor[]>;

  // Roles and actor-role bindings (who may assume which trust envelope through which surface)
  registerRole(role: GovernanceRoleCreate): Promise<GovernanceRole>;
  getRole(id: import("./domain.js").RoleId): Promise<GovernanceRole | null>;
  getRoleByName(name: string): Promise<GovernanceRole | null>;
  listRoles(filters?: { status?: GovernanceRoleStatus }): Promise<GovernanceRole[]>;
  bindActorRole(binding: ActorRoleBindingCreate): Promise<ActorRoleBinding>;
  listActorRoleBindings(filters?: {
    actorId?: ActorId;
    roleId?: import("./domain.js").RoleId;
    surface?: string;
    status?: ActorRoleBindingStatus;
  }): Promise<ActorRoleBinding[]>;

  // Actor Sessions (ephemeral liveness, never accountability)
  openActorSession(session: ActorSessionCreate): Promise<ActorSession>;
  heartbeatActorSession(sessionRef: string, actorId: ActorId): Promise<ActorSession | RepositoryError>;
  closeActorSession(sessionRef: string, actorId: ActorId): Promise<ActorSession | RepositoryError>;
  listActorSessions(filters?: { actorId?: ActorId; status?: ActorSessionStatus }): Promise<ActorSession[]>;

  // Scopes
  registerScope(scope: string): Promise<string>;
  listScopes(): Promise<string[]>;

  // Expertise Signals
  registerExpertiseSignal(signal: Omit<ExpertiseSignalRecord, "id" | "createdAt">): Promise<ExpertiseSignalRecord>;
  listExpertiseSignals(intentId: IntentId): Promise<ExpertiseSignalRecord[]>;

  // Reports
  registerReport(report: ReportCreate): Promise<Report>;
  getReport(id: ReportId): Promise<Report | null>;
  listReports(filters?: {
    scope?: string;
    kind?: string;
    intentId?: IntentId;
    domainId?: DomainId;
    actorId?: ActorId;
  }): Promise<Report[]>;

  // Events (append-only)
  emitEvent(
    eventType: EventType,
    entityTable: string,
    entityId: number,
    actorId: ActorId,
    context?: { scope?: string; reason?: string; snapshot?: Record<string, unknown> }
  ): Promise<Event>;
  listEvents(filters?: { scope?: string; entityTable?: string }): Promise<Event[]>;
}

/**
 * In-memory implementation of GovernanceRepository.
 * Used for Phase 1 prototyping. No external dependencies.
 */
export class InMemoryGovernanceRepository implements GovernanceRepository {
  private intents = new Map<IntentId, Intent>();
  private interpretations = new Map<InterpretationId, Interpretation>();
  private actions = new Map<ActionId, Action>();
  private claims = new Map<ClaimId, Claim>();
  private domains = new Map<DomainId, Domain>();
  private contracts = new Map<ContractId, Contract>();
  private actors = new Map<ActorId, Actor>();
  private roles = new Map<import("./domain.js").RoleId, GovernanceRole>();
  private actorRoleBindings = new Map<ActorRoleBindingId, ActorRoleBinding>();
  private actorSessions = new Map<ActorSessionId, ActorSession>();
  private expertiseSignals = new Map<ExpertiseSignalId, ExpertiseSignalRecord>();
  private reports = new Map<ReportId, Report>();
  private events: Event[] = [];

  private nextIntentId = 1;
  private nextInterpretationId = 1;
  private nextActionId = 1;
  private nextClaimId = 1;
  private nextDomainId = 1;
  private nextContractId = 1;
  private nextActorId = 1;
  private nextRoleId = 1;
  private nextActorRoleBindingId = 1;
  private nextActorSessionId = 1;
  private nextEventId = 1;
  private nextExpertiseSignalId = 1;
  private nextReportId = 1;

  // ============================================================
  // Intents
  // ============================================================

  async createIntent(
    intent: Omit<Intent, "id" | "version" | "createdAt" | "updatedAt" | "status"> & { status?: IntentStatus },
    actorId?: ActorId
  ): Promise<Intent> {
    const now = new Date();
    const id = intendId(this.nextIntentId++);
    const record: Intent = {
      ...intent,
      status: intent.status ?? "draft",
      id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(id, record);
    if (actorId != null) {
      await this.emitEvent("intent_created", "intents", id, actorId);
    }
    return record;
  }

  async getIntent(id: IntentId): Promise<IntentEnriched | null> {
    const intent = this.intents.get(id);
    if (!intent) return null;

    const interpretationCount = Array.from(this.interpretations.values())
      .filter((i) => i.intentId === id).length;
    const expertiseSignals = Array.from(this.expertiseSignals.values())
      .filter((s) => s.intentId === id);
    const activeClaims = Array.from(this.claims.values())
      .filter((c) => c.entityTable === "intents" && c.entityId === id && c.status === "active");

    return { ...intent, interpretationCount, expertiseSignals, activeClaims };
  }

  async updateIntent(
    id: IntentId,
    updates: Partial<Omit<Intent, "id" | "createdAt">>,
    reason: string,
    actorId?: ActorId
  ): Promise<Intent | RepositoryError> {
    const intent = this.intents.get(id);
    if (!intent) return { code: "NOT_FOUND", message: `Intent ${id} not found` };

    const updated: Intent = {
      ...intent,
      ...updates,
      id,
      version: intent.version + 1,
      updatedAt: new Date(),
    };

    this.intents.set(id, updated);
    if (actorId != null) {
      await this.emitEvent("intent_updated", "intents", id, actorId, { reason });
    }
    return updated;
  }

  async listIntents(filters?: { scope?: string; status?: IntentStatus; parentId?: IntentId | null }): Promise<Intent[]> {
    let result = Array.from(this.intents.values());
    if (filters?.scope) result = result.filter((i) => i.scope === filters.scope);
    if (filters?.status) result = result.filter((i) => i.status === filters.status);
    // parentId: pass null to get top-level only, pass an ID to get sub-intents of that parent
    if (filters && "parentId" in filters) {
      if (filters.parentId === null) {
        result = result.filter((i) => i.parentId == null);
      } else {
        result = result.filter((i) => i.parentId === filters.parentId);
      }
    }
    return result;
  }

  // ============================================================
  // Interpretations
  // ============================================================

  async createInterpretation(
    interpretation: Omit<Interpretation, "id" | "createdAt" | "updatedAt" | "status" | "alignment"> & {
      status?: InterpretationStatus;
      alignment?: InterpretationAlignment;
    }
  ): Promise<Interpretation> {
    const now = new Date();
    const id = interpretationId(this.nextInterpretationId++);
    const record: Interpretation = {
      ...interpretation,
      status: interpretation.status ?? "clarifying",
      alignment: interpretation.alignment ?? "uncertain",
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.interpretations.set(id, record);
    await this.emitEvent("interpretation_filed", "interpretations", id, interpretation.actorId);
    return record;
  }

  async getInterpretation(id: InterpretationId): Promise<InterpretationEnriched | null> {
    const interp = this.interpretations.get(id);
    if (!interp) return null;

    const intent = this.intents.get(interp.intentId);
    if (!intent) return null;

    const actions = Array.from(this.actions.values())
      .filter((a) => a.interpretationId === id);

    return { ...interp, intent, actions };
  }

  async updateInterpretation(
    id: InterpretationId,
    updates: Partial<Omit<Interpretation, "id" | "createdAt" | "title">>,
    reason: string,
    actorId?: ActorId
  ): Promise<Interpretation | RepositoryError> {
    const interp = this.interpretations.get(id);
    if (!interp) return { code: "NOT_FOUND", message: `Interpretation ${id} not found` };

    // No transition enforcement — the governance schema validates status values
    // but does not constrain transitions. Process governance is social, not mechanical.
    const updated: Interpretation = {
      ...interp,
      ...updates,
      id,
      updatedAt: new Date(),
    };

    this.interpretations.set(id, updated);
    if (actorId != null) {
      await this.emitEvent("interpretation_updated", "interpretations", id, actorId, { reason });
    }
    return updated;
  }

  async supersedeInterpretation(
    id: InterpretationId,
    newTitle: string,
    reason: string,
    newScopeAssumption?: string,
    newStatus?: InterpretationStatus
  ): Promise<{ old: Interpretation; replacement: Interpretation } | RepositoryError> {
    const interp = this.interpretations.get(id);
    if (!interp) return { code: "NOT_FOUND", message: `Interpretation ${id} not found` };

    // Create replacement with same actor/domain/intent, reset alignment
    const replacementId = interpretationId(this.nextInterpretationId++);
    const now = new Date();
    const replacement: Interpretation = {
      id: replacementId,
      intentId: interp.intentId,
      domainId: interp.domainId,
      actorId: interp.actorId,
      title: newTitle,
      scopeAssumption: newScopeAssumption,
      alignment: "uncertain",
      status: newStatus ?? "clarifying",
      createdAt: now,
      updatedAt: now,
    };
    this.interpretations.set(replacementId, replacement);

    // Mark old as superseded
    const old: Interpretation = {
      ...interp,
      status: "superseded",
      alignment: "superseded",
      supersededBy: replacementId,
      updatedAt: now,
    };
    this.interpretations.set(id, old);

    await this.emitEvent("interpretation_superseded", "interpretations", id, interp.actorId, { reason });
    await this.emitEvent("interpretation_filed", "interpretations", replacementId, interp.actorId);

    return { old, replacement };
  }

  async listInterpretations(filters?: {
    intentId?: IntentId;
    domainId?: DomainId;
    status?: InterpretationStatus;
    alignment?: string;
  }): Promise<Interpretation[]> {
    let result = Array.from(this.interpretations.values());
    if (filters?.intentId) result = result.filter((i) => i.intentId === filters.intentId);
    if (filters?.domainId) result = result.filter((i) => i.domainId === filters.domainId);
    if (filters?.status) result = result.filter((i) => i.status === filters.status);
    if (filters?.alignment) result = result.filter((i) => i.alignment === filters.alignment);
    return result;
  }

  // ============================================================
  // Actions
  // ============================================================

  async logAction(action: Omit<Action, "id" | "createdAt">): Promise<Action> {
    const id = actionId(this.nextActionId++);
    const record: Action = {
      ...action,
      id,
      createdAt: new Date(),
    };
    this.actions.set(id, record);
    await this.emitEvent("action_logged", "actions", id, action.actorId);
    return record;
  }

  async getAction(id: ActionId): Promise<Action | null> {
    return this.actions.get(id) ?? null;
  }

  async listActions(filters?: {
    intentId?: IntentId;
    actorId?: ActorId;
    domainId?: DomainId;
    governingContractKey?: string;
  }): Promise<Action[]> {
    let result = Array.from(this.actions.values());
    if (filters?.intentId) result = result.filter((a) => a.intentId === filters.intentId);
    if (filters?.actorId) result = result.filter((a) => a.actorId === filters.actorId);
    if (filters?.domainId) result = result.filter((a) => a.domainId === filters.domainId);
    if (filters?.governingContractKey) {
      result = result.filter((a) => a.governingContractKey === filters.governingContractKey);
    }
    return result;
  }

  // ============================================================
  // Claims
  // ============================================================

  async acquireClaim(
    entityTable: string,
    entityId: number,
    actor: ActorId,
    note?: string
  ): Promise<Claim> {
    // Claims are advisory signals, not exclusive locks.
    // Multiple actors can claim the same entity; claims are advisory, not locks.
    const id = claimId(this.nextClaimId++);
    const record: Claim = {
      id,
      entityTable,
      entityId,
      actorId: actor,
      status: "active",
      note,
      createdAt: new Date(),
    };
    this.claims.set(id, record);
    await this.emitEvent("claim_acquired", entityTable, entityId, actor, { reason: note });
    return record;
  }

  async releaseClaim(id: ClaimId, reason?: string): Promise<void | RepositoryError> {
    const claim = this.claims.get(id);
    if (!claim) return { code: "NOT_FOUND", message: `Claim ${id} not found` };

    if (!isValidClaimTransition(claim.status, "released")) {
      return { code: "INVALID_TRANSITION", message: `Cannot release claim in status ${claim.status}` };
    }

    const released: Claim = {
      ...claim,
      status: "released",
      releasedAt: new Date(),
    };
    this.claims.set(id, released);
    await this.emitEvent("claim_released", claim.entityTable, claim.entityId, claim.actorId, {
      reason,
    });
  }

  async getClaim(id: ClaimId): Promise<Claim | null> {
    return this.claims.get(id) ?? null;
  }

  async listClaims(filters?: { entityTable?: string; entityId?: number; status?: ClaimStatus }): Promise<Claim[]> {
    let result = Array.from(this.claims.values());
    if (filters?.entityTable) result = result.filter((c) => c.entityTable === filters.entityTable);
    if (filters?.entityId != null) result = result.filter((c) => c.entityId === filters.entityId);
    if (filters?.status) result = result.filter((c) => c.status === filters.status);
    return result;
  }

  // ============================================================
  // Domains
  // ============================================================

  async registerDomain(domain: Omit<Domain, "id">): Promise<Domain> {
    const id = domainId(this.nextDomainId++);
    const record: Domain = { ...domain, id };
    this.domains.set(id, record);
    return record;
  }

  async getDomain(id: DomainId): Promise<Domain | null> {
    return this.domains.get(id) ?? null;
  }

  async listDomains(): Promise<Domain[]> {
    return Array.from(this.domains.values());
  }

  // ============================================================
  // Contracts
  // ============================================================

  async registerContract(contract: ContractCreate): Promise<Contract | RepositoryError> {
    const existingOpen = Array.from(this.contracts.values()).find((candidate) =>
      candidate.key === contract.key && (candidate.status === "active" || candidate.status === "draft")
    );
    if (existingOpen) {
      return {
        code: "CONFLICT",
        message: `Contract '${contract.key}' already has an open ${existingOpen.status} revision`,
      };
    }

    const now = new Date();
    const id = contractId(this.nextContractId++);
    const record: Contract = {
      ...contract,
      id,
      status: contract.status ?? "active",
      version: contract.version ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    this.contracts.set(id, record);
    await this.emitEvent("contract_registered", "contracts", id, record.custodianActorId, {
      scope: record.scope,
      snapshot: { ...record, body: undefined, bodyLength: record.body.length } as Record<string, unknown>,
    });
    return record;
  }

  async getContract(id: ContractId): Promise<Contract | null> {
    return this.contracts.get(id) ?? null;
  }

  async getContractByKey(key: string, status?: ContractStatus): Promise<Contract | null> {
    const candidates = Array.from(this.contracts.values())
      .filter((contract) => contract.key === key && (status ? contract.status === status : contract.status === "active"))
      .sort((a, b) => b.version - a.version);
    return candidates[0] ?? null;
  }

  async listContracts(filters?: {
    key?: string;
    kind?: ContractKind;
    scope?: string;
    domainId?: DomainId;
    status?: ContractStatus;
    parentKey?: string;
    governingContractKey?: string;
  }): Promise<Contract[]> {
    let result = Array.from(this.contracts.values());
    if (filters?.key) result = result.filter((contract) => contract.key === filters.key);
    if (filters?.kind) result = result.filter((contract) => contract.kind === filters.kind);
    if (filters?.scope) result = result.filter((contract) => contract.scope === filters.scope);
    if (filters?.domainId) result = result.filter((contract) => contract.domainId === filters.domainId);
    if (filters?.status) result = result.filter((contract) => contract.status === filters.status);
    if (filters?.parentKey) result = result.filter((contract) => contract.parentKey === filters.parentKey);
    if (filters?.governingContractKey) {
      result = result.filter((contract) => contract.governingContractKey === filters.governingContractKey);
    }
    return result.sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version);
  }

  async supersedeContract(
    id: ContractId,
    replacement: ContractSupersedeInput,
    reason: string
  ): Promise<{ old: Contract; replacement: Contract } | RepositoryError> {
    const current = this.contracts.get(id);
    if (!current) return { code: "NOT_FOUND", message: `Contract ${id} not found` };
    if (current.status === "superseded" || current.status === "retired") {
      return { code: "INVALID_TRANSITION", message: `Cannot supersede contract in status ${current.status}` };
    }

    const replacementStatus = replacement.status ?? "active";
    if (replacementStatus === "active" || replacementStatus === "draft") {
      const conflictingOpen = Array.from(this.contracts.values()).find((candidate) =>
        candidate.id !== id &&
        candidate.key === current.key &&
        (candidate.status === "active" || candidate.status === "draft")
      );
      if (conflictingOpen) {
        return {
          code: "CONFLICT",
          message: `Contract '${current.key}' already has an open ${conflictingOpen.status} revision`,
        };
      }
    }

    const now = new Date();
    const replacementId = contractId(this.nextContractId++);
    const replacementRecord: Contract = {
      id: replacementId,
      key: current.key,
      kind: current.kind,
      scope: current.scope,
      domainId: replacement.domainId ?? current.domainId,
      parentKey: current.parentKey,
      title: replacement.title ?? current.title,
      body: replacement.body,
      status: replacementStatus,
      version: current.version + 1,
      custodianActorId: replacement.custodianActorId,
      governingContractKey: replacement.governingContractKey ?? current.governingContractKey,
      mandateRef: replacement.mandateRef,
      contentHash: replacement.contentHash,
      supersedes: id,
      createdAt: now,
      updatedAt: now,
    };
    const old: Contract = {
      ...current,
      status: "superseded",
      supersededBy: replacementId,
      updatedAt: now,
    };
    this.contracts.set(id, old);
    this.contracts.set(replacementId, replacementRecord);
    await this.emitEvent("contract_superseded", "contracts", id, replacement.custodianActorId, {
      scope: current.scope,
      reason,
      snapshot: { ...old, body: undefined, bodyLength: old.body.length } as Record<string, unknown>,
    });
    await this.emitEvent("contract_registered", "contracts", replacementId, replacement.custodianActorId, {
      scope: replacementRecord.scope,
      snapshot: { ...replacementRecord, body: undefined, bodyLength: replacementRecord.body.length } as Record<string, unknown>,
    });
    return { old, replacement: replacementRecord };
  }

  // ============================================================
  // Actors
  // ============================================================

  async registerActor(actor: ActorCreate): Promise<Actor> {
    const now = new Date();
    const id = actorId(this.nextActorId++);
    const record: Actor = {
      ...actor,
      status: actor.status ?? "active",
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.actors.set(id, record);
    return record;
  }

  async updateActor(id: ActorId, updates: Partial<Omit<Actor, "id" | "createdAt">>): Promise<Actor | RepositoryError> {
    const actor = this.actors.get(id);
    if (!actor) return { code: "NOT_FOUND", message: `Actor ${id} not found` };
    const updated: Actor = { ...actor, ...updates, id, updatedAt: new Date() };
    this.actors.set(id, updated);
    return updated;
  }

  async getActor(id: ActorId): Promise<Actor | null> {
    return this.actors.get(id) ?? null;
  }

  async getActorByName(name: string): Promise<Actor | null> {
    return Array.from(this.actors.values()).find((a) => a.name === name) ?? null;
  }

  async listActors(filters?: { status?: ActorStatus; provider?: string }): Promise<Actor[]> {
    let result = Array.from(this.actors.values());
    if (filters?.status) result = result.filter((a) => a.status === filters.status);
    if (filters?.provider) result = result.filter((a) => a.provider === filters.provider);
    return result;
  }

  async registerRole(role: GovernanceRoleCreate): Promise<GovernanceRole> {
    const now = new Date();
    const id = roleId(this.nextRoleId++);
    const record: GovernanceRole = {
      ...role,
      id,
      status: role.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    this.roles.set(id, record);
    return record;
  }

  async getRole(id: import("./domain.js").RoleId): Promise<GovernanceRole | null> {
    return this.roles.get(id) ?? null;
  }

  async getRoleByName(name: string): Promise<GovernanceRole | null> {
    return Array.from(this.roles.values()).find((role) => role.name === name) ?? null;
  }

  async listRoles(filters?: { status?: GovernanceRoleStatus }): Promise<GovernanceRole[]> {
    let result = Array.from(this.roles.values());
    if (filters?.status) result = result.filter((role) => role.status === filters.status);
    return result;
  }

  async bindActorRole(binding: ActorRoleBindingCreate): Promise<ActorRoleBinding> {
    const now = new Date();
    const existing = Array.from(this.actorRoleBindings.values()).find((candidate) =>
      candidate.actorId === binding.actorId &&
      candidate.roleId === binding.roleId &&
      candidate.surface === binding.surface &&
      candidate.credentialRef === binding.credentialRef
    );
    if (existing) {
      const updated: ActorRoleBinding = { ...existing, ...binding, status: binding.status ?? "active", updatedAt: now };
      this.actorRoleBindings.set(existing.id, updated);
      return updated;
    }
    const id = actorRoleBindingId(this.nextActorRoleBindingId++);
    const record: ActorRoleBinding = {
      ...binding,
      id,
      status: binding.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    this.actorRoleBindings.set(id, record);
    return record;
  }

  async listActorRoleBindings(filters?: {
    actorId?: ActorId;
    roleId?: import("./domain.js").RoleId;
    surface?: string;
    status?: ActorRoleBindingStatus;
  }): Promise<ActorRoleBinding[]> {
    let result = Array.from(this.actorRoleBindings.values());
    if (filters?.actorId) result = result.filter((binding) => binding.actorId === filters.actorId);
    if (filters?.roleId) result = result.filter((binding) => binding.roleId === filters.roleId);
    if (filters?.surface) result = result.filter((binding) => binding.surface === filters.surface);
    if (filters?.status) result = result.filter((binding) => binding.status === filters.status);
    return result;
  }

  async openActorSession(session: ActorSessionCreate): Promise<ActorSession> {
    const now = new Date();
    const existing = Array.from(this.actorSessions.values())
      .find((s) => s.actorId === session.actorId && s.sessionRef === session.sessionRef && s.status === "active");
    if (existing) {
      const refreshed: ActorSession = { ...existing, lastSeenAt: now };
      this.actorSessions.set(existing.id, refreshed);
      return refreshed;
    }
    const id = actorSessionId(this.nextActorSessionId++);
    const record: ActorSession = {
      ...session,
      id,
      status: session.status ?? "active",
      startedAt: now,
      lastSeenAt: now,
    };
    this.actorSessions.set(id, record);
    return record;
  }

  async heartbeatActorSession(sessionRef: string, actor: ActorId): Promise<ActorSession | RepositoryError> {
    const session = Array.from(this.actorSessions.values())
      .find((s) => s.actorId === actor && s.sessionRef === sessionRef && s.status === "active");
    if (!session) return { code: "NOT_FOUND", message: `Active session '${sessionRef}' not found for actor ${actor}` };
    const updated: ActorSession = { ...session, lastSeenAt: new Date() };
    this.actorSessions.set(session.id, updated);
    return updated;
  }

  async closeActorSession(sessionRef: string, actor: ActorId): Promise<ActorSession | RepositoryError> {
    const session = Array.from(this.actorSessions.values())
      .find((s) => s.actorId === actor && s.sessionRef === sessionRef && s.status === "active");
    if (!session) return { code: "NOT_FOUND", message: `Active session '${sessionRef}' not found for actor ${actor}` };
    const now = new Date();
    const updated: ActorSession = { ...session, status: "closed", lastSeenAt: now, endedAt: now };
    this.actorSessions.set(session.id, updated);
    return updated;
  }

  async listActorSessions(filters?: { actorId?: ActorId; status?: ActorSessionStatus }): Promise<ActorSession[]> {
    let result = Array.from(this.actorSessions.values());
    if (filters?.actorId) result = result.filter((s) => s.actorId === filters.actorId);
    if (filters?.status) result = result.filter((s) => s.status === filters.status);
    return result;
  }

  // ============================================================
  // Scopes
  // ============================================================

  private scopes = new Set<string>();

  async registerScope(scope: string): Promise<string> {
    this.scopes.add(scope);
    return scope;
  }

  async listScopes(): Promise<string[]> {
    return Array.from(this.scopes);
  }

  // ============================================================
  // Expertise Signals
  // ============================================================

  async registerExpertiseSignal(signal: Omit<ExpertiseSignalRecord, "id" | "createdAt">): Promise<ExpertiseSignalRecord> {
    const id = expertiseSignalId(this.nextExpertiseSignalId++);
    const record: ExpertiseSignalRecord = {
      ...signal,
      id,
      createdAt: new Date(),
    };
    this.expertiseSignals.set(id, record);
    await this.emitEvent("expertise_signal_registered", "expertise_signals", id, signal.actorId);
    return record;
  }

  async listExpertiseSignals(intentId: IntentId): Promise<ExpertiseSignalRecord[]> {
    return Array.from(this.expertiseSignals.values()).filter((s) => s.intentId === intentId);
  }

  // ============================================================
  // Reports
  // ============================================================

  async registerReport(report: ReportCreate): Promise<Report> {
    const id = reportId(this.nextReportId++);
    const record: Report = { ...report, id, createdAt: new Date() };
    this.reports.set(id, record);
    await this.emitEvent("report_created", "reports", id, report.actorId, {
      scope: report.scope,
      snapshot: record as unknown as Record<string, unknown>,
    });
    return record;
  }

  async getReport(id: ReportId): Promise<Report | null> {
    return this.reports.get(id) ?? null;
  }

  async listReports(filters?: {
    scope?: string;
    kind?: string;
    intentId?: IntentId;
    domainId?: DomainId;
    actorId?: ActorId;
  }): Promise<Report[]> {
    let result = Array.from(this.reports.values());
    if (filters?.scope) result = result.filter((r) => r.scope === filters.scope);
    if (filters?.kind) result = result.filter((r) => r.kind === filters.kind);
    if (filters?.intentId) result = result.filter((r) => r.intentId === filters.intentId);
    if (filters?.domainId) result = result.filter((r) => r.domainId === filters.domainId);
    if (filters?.actorId) result = result.filter((r) => r.actorId === filters.actorId);
    return result;
  }

  // ============================================================
  // Events
  // ============================================================

  async emitEvent(
    eventType: EventType,
    entityTable: string,
    entityId: number,
    actorId: ActorId,
    context?: { scope?: string; reason?: string; snapshot?: Record<string, unknown> }
  ): Promise<Event> {
    const id = eventId(this.nextEventId++);
    const record: Event = {
      id,
      scope: context?.scope ?? "default",
      eventType,
      entityTable,
      entityId,
      actorId,
      reason: context?.reason,
      snapshot: context?.snapshot,
      createdAt: new Date(),
    };
    this.events.push(record);
    return record;
  }

  async listEvents(filters?: { scope?: string; entityTable?: string }): Promise<Event[]> {
    let result = this.events;
    if (filters?.scope) result = result.filter((e) => e.scope === filters.scope);
    if (filters?.entityTable) result = result.filter((e) => e.entityTable === filters.entityTable);
    return result;
  }
}
