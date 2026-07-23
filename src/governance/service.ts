/**
 * Governance Service
 *
 * Transport-agnostic application service layer. Both CLI and (optional) MCP
 * adapter consume this — no feature may require a specific transport to exist.
 *
 * Each method:
 * - Accepts plain typed parameters (not transport-shaped)
 * - Calls GovernanceRepository
 * - Returns a structured { ok, data, meta } envelope matching governance response shape
 * - Handles errors uniformly
 *
 * ADR: CLI is the canonical control plane. MCP is optional adapter.
 * Transport-neutral application service for governed state.
 */

import { createHash } from "node:crypto";
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
  Contract,
  ContractKind,
  ContractStatus,
  Actor,
  ActorId,
  ActorRoleBinding,
  ActorRoleBindingStatus,
  ActorSession,
  ActorSessionStatus,
  ActorStatus,
  GovernanceRole,
  GovernanceRoleStatus,
  ExpertiseSignalRecord,
  ExpertiseSignal,
  Event,
  Report,
  intendId,
  actorId as toActorId,
  domainId as toDomainId,
  interpretationId as toInterpretationId,
  reportId as toReportId,
  contractId as toContractId,
} from "./domain.js";

import { GovernanceRepository, RepositoryError } from "./repository.js";

// ============================================================
// Response Envelope
// ============================================================

export interface ServiceResult<T> {
  ok: true;
  data: T;
  meta: { schema_version: number; count?: number; has_more?: boolean };
}

export interface ServiceError {
  ok: false;
  error: { code: string; message: string };
}

export type ServiceResponse<T> = ServiceResult<T> | ServiceError;

const SCHEMA_VERSION = 2;

function success<T>(data: T, extra?: { count?: number; has_more?: boolean }): ServiceResult<T> {
  return { ok: true, data, meta: { schema_version: SCHEMA_VERSION, ...extra } };
}

function listSuccess<T>(data: T[], has_more = false): ServiceResult<T[]> {
  return { ok: true, data, meta: { schema_version: SCHEMA_VERSION, count: data.length, has_more } };
}

function fail(code: string, message: string): ServiceError {
  return { ok: false, error: { code, message } };
}

function isError(result: unknown): result is RepositoryError {
  return typeof result === "object" && result !== null && "code" in result && "message" in result;
}

function hashContractBody(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function actorTypeContractKey(actorType: string): string {
  const slug = actorType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Actor type must contain at least one letter or number");
  return `actor-type:${slug}`;
}

// ============================================================
// GovernanceService
// ============================================================

export class GovernanceService {
  constructor(private readonly repo: GovernanceRepository) {}

  private async requireActiveActor(actorId: number, label = "Actor"): Promise<Actor | ServiceError> {
    const actor = await this.repo.getActor(toActorId(actorId));
    if (!actor) return fail("NOT_FOUND", `${label} ${actorId} not found`);
    if (actor.status !== "active") return fail("ACTOR_INACTIVE", `${label} ${actor.name} is ${actor.status}`);
    return actor;
  }

  private async requireActiveContractKey(key: string): Promise<ServiceError | undefined> {
    const contract = await this.repo.getContractByKey(key, "active");
    if (!contract) return fail("CONTRACT_NOT_FOUND", `Active contract '${key}' not found`);
    return undefined;
  }

  private async validateOptionalDomain(domainId: number | undefined): Promise<ServiceError | undefined> {
    if (domainId == null) return undefined;
    const domain = await this.repo.getDomain(toDomainId(domainId));
    if (!domain) return fail("DOMAIN_NOT_FOUND", `Domain ${domainId} not found`);
    return undefined;
  }

  private async validateOptionalGoverningContractKey(key: string | undefined): Promise<ServiceError | undefined> {
    if (key == null) return undefined;
    return this.requireActiveContractKey(key);
  }

  private async validateContractParent(kind: ContractKind, parentKey?: string): Promise<ServiceError | undefined> {
    if (kind === "root") {
      if (parentKey) return fail("INVALID_PARENT", "Root contracts must not declare a parentKey");
      return undefined;
    }
    if (!parentKey) return fail("PARENT_REQUIRED", `${kind} contracts require an active parentKey`);
    const parent = await this.repo.getContractByKey(parentKey, "active");
    if (!parent) return fail("PARENT_NOT_FOUND", `Active parent contract '${parentKey}' not found`);
    return undefined;
  }

  private validateContractWriteStatus(status: ContractStatus | undefined): ServiceError | undefined {
    if (status === "superseded" || status === "retired") {
      return fail("INVALID_STATUS", `Contract writes may create only active or draft revisions, not ${status}`);
    }
    return undefined;
  }

  // ----------------------------------------------------------
  // Intents
  // ----------------------------------------------------------

  async registerIntent(params: {
    description: string;
    source: string;
    scope?: string;
    addressedTo?: number;
    parentId?: number;
    status?: IntentStatus;
    actorId?: number;
  }): Promise<ServiceResponse<Intent>> {
    const intent = await this.repo.createIntent(
      {
        description: params.description,
        source: params.source,
        scope: params.scope ?? "default",
        addressedTo: params.addressedTo != null ? toActorId(params.addressedTo) : undefined,
        parentId: params.parentId != null ? intendId(params.parentId) : undefined,
        status: params.status,
      },
      // Actor attribution is the writer of the governance event, not the optional addressed recipient.
      params.actorId != null ? toActorId(params.actorId) : undefined
    );
    return success(intent);
  }

  async getIntent(id: number): Promise<ServiceResponse<IntentEnriched>> {
    const intent = await this.repo.getIntent(intendId(id));
    if (!intent) return fail("NOT_FOUND", `Intent ${id} not found`);
    return success(intent);
  }

  async updateIntent(params: {
    id: number;
    reason: string;
    status?: IntentStatus;
    description?: string;
    resolutionNotes?: string;
    addressedTo?: number;
    actorId?: number;
  }): Promise<ServiceResponse<Intent>> {
    const updates: Record<string, unknown> = {};
    if (params.status != null) updates.status = params.status;
    if (params.description != null) updates.description = params.description;
    if (params.resolutionNotes != null) updates.resolutionNotes = params.resolutionNotes;
    if (params.addressedTo != null) updates.addressedTo = toActorId(params.addressedTo);

    const result = await this.repo.updateIntent(
      intendId(params.id),
      updates,
      params.reason,
      params.actorId != null ? toActorId(params.actorId) : undefined
    );
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async listIntents(params?: {
    scope?: string;
    status?: IntentStatus;
    addressedTo?: number;
    parentId?: number | null;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Intent[]>> {
    // Build repo filters carefully: only include parentId key when the caller
    // explicitly passed it, because the repo uses key-existence to decide
    // whether to filter (parentId: null = top-level only, parentId: <id> = children).
    const repoFilters: Parameters<typeof this.repo.listIntents>[0] = {};
    if (params?.scope) repoFilters.scope = params.scope;
    if (params?.status) repoFilters.status = params.status;
    if (params && "parentId" in params) {
      repoFilters.parentId = params.parentId === null
        ? null
        : params.parentId != null ? intendId(params.parentId) : undefined;
    }
    let results = await this.repo.listIntents(repoFilters);

    // addressedTo filter (repository doesn't have it — filter in service)
    if (params?.addressedTo != null) {
      const target = toActorId(params.addressedTo);
      results = results.filter((i) => i.addressedTo === target);
    }

    // Pagination
    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;

    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Interpretations
  // ----------------------------------------------------------

  async registerInterpretation(params: {
    intentId: number;
    domainId: number;
    actorId: number;
    title: string;
    scopeAssumption?: string;
    status?: InterpretationStatus;
    alignment?: InterpretationAlignment;
    sourceRef?: string;
    resolverId?: number;
    resolveBy?: string; // ISO 8601
  }): Promise<ServiceResponse<Interpretation>> {
    const interp = await this.repo.createInterpretation({
      intentId: intendId(params.intentId),
      domainId: toDomainId(params.domainId),
      actorId: toActorId(params.actorId),
      title: params.title,
      scopeAssumption: params.scopeAssumption,
      status: params.status,
      alignment: params.alignment,
      sourceRef: params.sourceRef,
      resolverId: params.resolverId != null ? toActorId(params.resolverId) : undefined,
      resolveBy: params.resolveBy ? new Date(params.resolveBy) : undefined,
    });
    return success(interp);
  }

  async getInterpretation(id: number): Promise<ServiceResponse<InterpretationEnriched>> {
    const interp = await this.repo.getInterpretation(toInterpretationId(id));
    if (!interp) return fail("NOT_FOUND", `Interpretation ${id} not found`);
    return success(interp);
  }

  async updateInterpretation(params: {
    id: number;
    reason: string;
    status?: InterpretationStatus;
    alignment?: InterpretationAlignment;
    resolverId?: number;
    resolveBy?: string;
    scopeAssumption?: string;
    sourceRef?: string;
    actorId?: number;
  }): Promise<ServiceResponse<Interpretation>> {
    const updates: Record<string, unknown> = {};
    if (params.status != null) updates.status = params.status;
    if (params.alignment != null) updates.alignment = params.alignment;
    if (params.resolverId != null) updates.resolverId = toActorId(params.resolverId);
    if (params.resolveBy != null) updates.resolveBy = new Date(params.resolveBy);
    if (params.scopeAssumption != null) updates.scopeAssumption = params.scopeAssumption;
    if (params.sourceRef != null) updates.sourceRef = params.sourceRef;

    const result = await this.repo.updateInterpretation(
      toInterpretationId(params.id),
      updates,
      params.reason,
      params.actorId != null ? toActorId(params.actorId) : undefined
    );
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async supersedeInterpretation(params: {
    id: number;
    newTitle: string;
    reason: string;
    newScopeAssumption?: string;
    newStatus?: InterpretationStatus;
  }): Promise<ServiceResponse<{ old: Interpretation; replacement: Interpretation }>> {
    const result = await this.repo.supersedeInterpretation(
      toInterpretationId(params.id),
      params.newTitle,
      params.reason,
      params.newScopeAssumption,
      params.newStatus
    );
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async listInterpretations(params?: {
    intentId?: number;
    domainId?: number;
    actorId?: number;
    status?: InterpretationStatus;
    alignment?: InterpretationAlignment;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Interpretation[]>> {
    let results = await this.repo.listInterpretations({
      intentId: params?.intentId != null ? intendId(params.intentId) : undefined,
      domainId: params?.domainId != null ? toDomainId(params.domainId) : undefined,
      status: params?.status || undefined,
      alignment: params?.alignment || undefined,
    });

    // actorId filter (repository doesn't have it — filter in service)
    if (params?.actorId != null) {
      const target = toActorId(params.actorId);
      results = results.filter((i) => i.actorId === target);
    }

    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;

    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Actions
  // ----------------------------------------------------------

  async logAction(params: {
    intentId: number;
    actorId: number;
    description: string;
    interpretationId?: number;
    domainId?: number;
    governingContractKey?: string;
    outcome?: string;
    assumedRole?: string;
    invokedSkillRef?: string;
    policyRef?: string;
  }): Promise<ServiceResponse<Action>> {
    const domainError = await this.validateOptionalDomain(params.domainId);
    if (domainError) return domainError;
    const actor = await this.repo.getActor(toActorId(params.actorId));
    const inheritedGoverningContractKey = params.governingContractKey ?? actor?.contractKey ?? actor?.defaultContractKey;
    const governingContractError = await this.validateOptionalGoverningContractKey(inheritedGoverningContractKey);
    if (governingContractError) return governingContractError;

    const action = await this.repo.logAction({
      intentId: intendId(params.intentId),
      actorId: toActorId(params.actorId),
      description: params.description,
      domainId: params.domainId != null ? toDomainId(params.domainId) : undefined,
      governingContractKey: inheritedGoverningContractKey,
      assumedRole: params.assumedRole,
      invokedSkillRef: params.invokedSkillRef,
      policyRef: params.policyRef,
      interpretationId: params.interpretationId != null ? toInterpretationId(params.interpretationId) : undefined,
      outcome: params.outcome,
    });
    return success(action);
  }

  async listActions(params?: {
    intentId?: number;
    actorId?: number;
    domainId?: number;
    governingContractKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Action[]>> {
    let results = await this.repo.listActions({
      intentId: params?.intentId != null ? intendId(params.intentId) : undefined,
      actorId: params?.actorId != null ? toActorId(params.actorId) : undefined,
      domainId: params?.domainId != null ? toDomainId(params.domainId) : undefined,
      governingContractKey: params?.governingContractKey,
    });

    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;

    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Claims
  // ----------------------------------------------------------

  async claim(params: {
    entityTable: string;
    entityId: number;
    actorId: number;
    note?: string;
  }): Promise<ServiceResponse<Claim>> {
    const claim = await this.repo.acquireClaim(
      params.entityTable,
      params.entityId,
      toActorId(params.actorId),
      params.note
    );
    return success(claim);
  }

  async releaseClaim(params: {
    id: number;
    reason?: string;
  }): Promise<ServiceResponse<{ released: true }>> {
    const result = await this.repo.releaseClaim(params.id as ClaimId, params.reason);
    if (isError(result)) return fail(result.code, result.message);
    return success({ released: true });
  }

  async listClaims(params?: {
    entityTable?: string;
    entityId?: number;
    status?: ClaimStatus;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Claim[]>> {
    let results = await this.repo.listClaims({
      entityTable: params?.entityTable,
      entityId: params?.entityId,
      status: params?.status,
    });

    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;

    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Expertise
  // ----------------------------------------------------------

  async registerExpertise(params: {
    intentId: number;
    domainId: number;
    actorId: number;
    signal: ExpertiseSignal;
    note?: string;
  }): Promise<ServiceResponse<ExpertiseSignalRecord>> {
    const record = await this.repo.registerExpertiseSignal({
      intentId: intendId(params.intentId),
      domainId: toDomainId(params.domainId),
      actorId: toActorId(params.actorId),
      signal: params.signal,
      note: params.note,
    });
    return success(record);
  }

  async getExpertiseCoverage(params: {
    intentId: number;
  }): Promise<ServiceResponse<{
    intentId: number;
    signals: ExpertiseSignalRecord[];
    domainCount: number;
  }>> {
    const signals = await this.repo.listExpertiseSignals(intendId(params.intentId));
    const uniqueDomains = new Set(signals.map((s) => s.domainId));
    return success({
      intentId: params.intentId,
      signals,
      domainCount: uniqueDomains.size,
    });
  }

  // ----------------------------------------------------------
  // Events
  // ----------------------------------------------------------

  async listEvents(params?: {
    scope?: string;
    entityTable?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Event[]>> {
    let results = await this.repo.listEvents({
      scope: params?.scope,
      entityTable: params?.entityTable,
    });

    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 50;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;

    return listSuccess(paged, has_more);
  }

  async getEntityHistory(params: {
    entityTable: string;
    entityId: number;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Event[]>> {
    // Filter events by entity — computed from the full event list
    const all = await this.repo.listEvents({ entityTable: params.entityTable });
    const filtered = all.filter((e) => e.entityId === params.entityId);

    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 50;
    const paged = filtered.slice(offset, offset + limit);
    const has_more = offset + limit < filtered.length;

    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Contracts
  // ----------------------------------------------------------

  async registerContract(params: {
    key: string;
    kind: ContractKind;
    title: string;
    body: string;
    custodianActorId: number;
    scope?: string;
    domainId?: number;
    parentKey?: string;
    status?: ContractStatus;
    governingContractKey?: string;
    mandateRef?: string;
  }): Promise<ServiceResponse<Contract>> {
    const statusError = this.validateContractWriteStatus(params.status);
    if (statusError) return statusError;
    const custodian = await this.requireActiveActor(params.custodianActorId, "Custodian actor");
    if ("ok" in custodian) return custodian;
    const parentError = await this.validateContractParent(params.kind, params.parentKey);
    if (parentError) return parentError;
    const domainError = await this.validateOptionalDomain(params.domainId);
    if (domainError) return domainError;
    const governingContractError = await this.validateOptionalGoverningContractKey(params.governingContractKey);
    if (governingContractError) return governingContractError;

    const result = await this.repo.registerContract({
      key: params.key,
      kind: params.kind,
      scope: params.scope ?? custodian.defaultScope,
      domainId: params.domainId != null ? toDomainId(params.domainId) : undefined,
      parentKey: params.parentKey,
      title: params.title,
      body: params.body,
      status: params.status ?? "active",
      version: 1,
      custodianActorId: custodian.id,
      governingContractKey: params.governingContractKey,
      mandateRef: params.mandateRef,
      contentHash: hashContractBody(params.body),
    });
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async getContract(params: {
    id?: number;
    key?: string;
    status?: ContractStatus;
  }): Promise<ServiceResponse<Contract>> {
    const contract = params.id != null
      ? await this.repo.getContract(toContractId(params.id))
      : params.key != null ? await this.repo.getContractByKey(params.key, params.status ?? "active") : null;
    if (!contract) {
      return fail("NOT_FOUND", params.id != null ? `Contract ${params.id} not found` : `Contract '${params.key ?? ""}' not found`);
    }
    return success(contract);
  }

  async listContracts(params?: {
    key?: string;
    kind?: ContractKind;
    scope?: string;
    domainId?: number;
    status?: ContractStatus;
    parentKey?: string;
    governingContractKey?: string;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Contract[]>> {
    let results = await this.repo.listContracts({
      key: params?.key,
      kind: params?.kind,
      scope: params?.scope,
      domainId: params?.domainId != null ? toDomainId(params.domainId) : undefined,
      status: params?.status,
      parentKey: params?.parentKey,
      governingContractKey: params?.governingContractKey,
    });
    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;
    return listSuccess(paged, has_more);
  }

  async supersedeContract(params: {
    id: number;
    body: string;
    reason: string;
    custodianActorId: number;
    title?: string;
    status?: ContractStatus;
    domainId?: number;
    governingContractKey?: string;
    mandateRef?: string;
  }): Promise<ServiceResponse<{ old: Contract; replacement: Contract }>> {
    const statusError = this.validateContractWriteStatus(params.status);
    if (statusError) return statusError;
    const custodian = await this.requireActiveActor(params.custodianActorId, "Custodian actor");
    if ("ok" in custodian) return custodian;
    const domainError = await this.validateOptionalDomain(params.domainId);
    if (domainError) return domainError;
    const governingContractError = await this.validateOptionalGoverningContractKey(params.governingContractKey);
    if (governingContractError) return governingContractError;

    const result = await this.repo.supersedeContract(
      toContractId(params.id),
      {
        title: params.title,
        body: params.body,
        status: params.status ?? "active",
        domainId: params.domainId != null ? toDomainId(params.domainId) : undefined,
        custodianActorId: custodian.id,
        governingContractKey: params.governingContractKey,
        mandateRef: params.mandateRef,
        contentHash: hashContractBody(params.body),
      },
      params.reason
    );
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async registerActorTypeContract(params: {
    name: string;
    body: string;
    custodianActorId: number;
    title?: string;
    scope?: string;
    domainId?: number;
    parentKey?: string;
    status?: ContractStatus;
    governingContractKey?: string;
    mandateRef?: string;
  }): Promise<ServiceResponse<Contract>> {
    const key = actorTypeContractKey(params.name);
    return this.registerContract({
      key,
      kind: "actor_type",
      title: params.title ?? `${params.name} actor type`,
      body: params.body,
      custodianActorId: params.custodianActorId,
      scope: params.scope,
      domainId: params.domainId,
      parentKey: params.parentKey ?? "root:agent-bootstrap",
      status: params.status,
      governingContractKey: params.governingContractKey,
      mandateRef: params.mandateRef,
    });
  }

  // ----------------------------------------------------------
  // Actors
  // ----------------------------------------------------------

  async registerActor(params: {
    name: string;
    role: "human" | "agent";
    provider: string;
    actorType?: string;
    capabilityNamespace: string;
    defaultScope?: string;
    sessionId?: string;
    status?: ActorStatus;
    contractKey?: string;
    defaultContractKey?: string;
    contractRef?: string;
    contextRef?: string;
    contextPolicy?: string;
    description?: string;
  }): Promise<ServiceResponse<Actor>> {
    if (params.contractKey != null) {
      const contractError = await this.requireActiveContractKey(params.contractKey);
      if (contractError) return contractError;
    }
    const defaultContractKey = params.defaultContractKey ?? (params.actorType ? actorTypeContractKey(params.actorType) : undefined);
    if (defaultContractKey != null) {
      const contractError = await this.requireActiveContractKey(defaultContractKey);
      if (contractError) return contractError;
    }
    const actor = await this.repo.registerActor({
      name: params.name,
      role: params.role,
      provider: params.provider,
      actorType: params.actorType,
      capabilityNamespace: params.capabilityNamespace,
      defaultScope: params.defaultScope ?? "default",
      sessionId: params.sessionId,
      status: params.status,
      contractKey: params.contractKey,
      defaultContractKey,
      contractRef: params.contractRef,
      contextRef: params.contextRef,
      contextPolicy: params.contextPolicy,
      description: params.description,
    });
    return success(actor);
  }

  async updateActor(params: {
    id: number;
    name?: string;
    role?: "human" | "agent";
    provider?: string;
    actorType?: string;
    capabilityNamespace?: string;
    defaultScope?: string;
    sessionId?: string;
    status?: ActorStatus;
    contractKey?: string;
    defaultContractKey?: string;
    contractRef?: string | null;
    contextRef?: string | null;
    contextPolicy?: string | null;
    description?: string | null;
  }): Promise<ServiceResponse<Actor>> {
    if (params.contractKey != null) {
      const contractError = await this.requireActiveContractKey(params.contractKey);
      if (contractError) return contractError;
    }
    const defaultContractKey = params.defaultContractKey ?? (params.actorType ? actorTypeContractKey(params.actorType) : undefined);
    if (defaultContractKey != null) {
      const contractError = await this.requireActiveContractKey(defaultContractKey);
      if (contractError) return contractError;
    }
    const updates: Record<string, unknown> = {};
    if (params.name != null) updates.name = params.name;
    if (params.role != null) updates.role = params.role;
    if (params.provider != null) updates.provider = params.provider;
    if (params.actorType != null) updates.actorType = params.actorType;
    if (params.capabilityNamespace != null) updates.capabilityNamespace = params.capabilityNamespace;
    if (params.defaultScope != null) updates.defaultScope = params.defaultScope;
    if (params.sessionId != null) updates.sessionId = params.sessionId;
    if (params.status != null) updates.status = params.status;
    if (params.contractKey != null) updates.contractKey = params.contractKey;
    if (defaultContractKey != null) updates.defaultContractKey = defaultContractKey;
    if (params.contractRef !== undefined) updates.contractRef = params.contractRef;
    if (params.contextRef !== undefined) updates.contextRef = params.contextRef;
    if (params.contextPolicy !== undefined) updates.contextPolicy = params.contextPolicy;
    if (params.description !== undefined) updates.description = params.description;

    const result = await this.repo.updateActor(toActorId(params.id), updates);
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async getActor(params: { id?: number; name?: string }): Promise<ServiceResponse<Actor>> {
    const actor = params.id != null
      ? await this.repo.getActor(toActorId(params.id))
      : params.name != null ? await this.repo.getActorByName(params.name) : null;
    if (!actor) return fail("NOT_FOUND", params.id != null ? `Actor ${params.id} not found` : `Actor '${params.name ?? ""}' not found`);
    return success(actor);
  }

  async retireActor(params: { id: number; reason?: string }): Promise<ServiceResponse<Actor>> {
    const result = await this.repo.updateActor(toActorId(params.id), {
      status: "retired",
    });
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async listActors(params?: { status?: ActorStatus; provider?: string }): Promise<ServiceResponse<Actor[]>> {
    const actors = await this.repo.listActors(params);
    return listSuccess(actors);
  }

  // ----------------------------------------------------------
  // Roles and Actor-Role Bindings
  // ----------------------------------------------------------

  async registerRole(params: {
    name: string;
    status?: GovernanceRoleStatus;
    contractKey?: string;
    contractRef?: string;
    contextRef?: string;
    policyRef?: string;
    description?: string;
  }): Promise<ServiceResponse<GovernanceRole>> {
    if (params.contractKey != null) {
      const contractError = await this.requireActiveContractKey(params.contractKey);
      if (contractError) return contractError;
    }
    const role = await this.repo.registerRole(params);
    return success(role);
  }

  async getRole(params: { id?: number; name?: string }): Promise<ServiceResponse<GovernanceRole>> {
    const role = params.id != null
      ? await this.repo.getRole(params.id as any)
      : params.name != null ? await this.repo.getRoleByName(params.name) : null;
    if (!role) return fail("NOT_FOUND", params.id != null ? `Role ${params.id} not found` : `Role '${params.name ?? ""}' not found`);
    return success(role);
  }

  async listRoles(params?: { status?: GovernanceRoleStatus }): Promise<ServiceResponse<GovernanceRole[]>> {
    const roles = await this.repo.listRoles(params);
    return listSuccess(roles);
  }

  async bindActorRole(params: {
    actorId: number;
    roleId: number;
    surface: string;
    provider: string;
    credentialRef?: string;
    status?: ActorRoleBindingStatus;
  }): Promise<ServiceResponse<ActorRoleBinding>> {
    const actor = await this.repo.getActor(toActorId(params.actorId));
    if (!actor) return fail("NOT_FOUND", `Actor ${params.actorId} not found`);
    const role = await this.repo.getRole(params.roleId as any);
    if (!role) return fail("NOT_FOUND", `Role ${params.roleId} not found`);
    const binding = await this.repo.bindActorRole({
      actorId: actor.id,
      roleId: role.id,
      surface: params.surface,
      provider: params.provider,
      credentialRef: params.credentialRef,
      status: params.status,
    });
    return success(binding);
  }

  async listActorRoleBindings(params?: {
    actorId?: number;
    roleId?: number;
    surface?: string;
    status?: ActorRoleBindingStatus;
  }): Promise<ServiceResponse<ActorRoleBinding[]>> {
    const bindings = await this.repo.listActorRoleBindings({
      actorId: params?.actorId != null ? toActorId(params.actorId) : undefined,
      roleId: params?.roleId as any,
      surface: params?.surface,
      status: params?.status,
    });
    return listSuccess(bindings);
  }

  // ----------------------------------------------------------
  // Actor Sessions
  // ----------------------------------------------------------

  async openActorSession(params: {
    actorId: number;
    sessionRef: string;
    surface: string;
    provider?: string;
    transcriptRef?: string;
  }): Promise<ServiceResponse<ActorSession>> {
    const actor = await this.repo.getActor(toActorId(params.actorId));
    if (!actor) return fail("NOT_FOUND", `Actor ${params.actorId} not found`);
    if (actor.status !== "active") return fail("ACTOR_INACTIVE", `Actor ${actor.name} is ${actor.status}`);
    const session = await this.repo.openActorSession({
      actorId: actor.id,
      sessionRef: params.sessionRef,
      surface: params.surface,
      provider: params.provider ?? actor.provider,
      transcriptRef: params.transcriptRef,
    });
    return success(session);
  }

  async heartbeatActorSession(params: {
    actorId: number;
    sessionRef: string;
  }): Promise<ServiceResponse<ActorSession>> {
    const result = await this.repo.heartbeatActorSession(params.sessionRef, toActorId(params.actorId));
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async closeActorSession(params: {
    actorId: number;
    sessionRef: string;
  }): Promise<ServiceResponse<ActorSession>> {
    const result = await this.repo.closeActorSession(params.sessionRef, toActorId(params.actorId));
    if (isError(result)) return fail(result.code, result.message);
    return success(result);
  }

  async listActorSessions(params?: {
    actorId?: number;
    status?: ActorSessionStatus;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<ActorSession[]>> {
    let results = await this.repo.listActorSessions({
      actorId: params?.actorId != null ? toActorId(params.actorId) : undefined,
      status: params?.status,
    });
    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;
    return listSuccess(paged, has_more);
  }

  // ----------------------------------------------------------
  // Domains
  // ----------------------------------------------------------

  async getDomain(id: number): Promise<ServiceResponse<Domain>> {
    const domain = await this.repo.getDomain(toDomainId(id));
    if (!domain) return fail("NOT_FOUND", `Domain ${id} not found`);
    return success(domain);
  }

  async registerDomain(params: {
    scope?: string;
    name: string;
    concern: string;
    notionPageId?: string;
  }): Promise<ServiceResponse<Domain>> {
    const domain = await this.repo.registerDomain({
      scope: params.scope ?? "default",
      name: params.name,
      concern: params.concern,
      notionPageId: params.notionPageId,
    });
    return success(domain);
  }

  async listDomains(): Promise<ServiceResponse<Domain[]>> {
    const domains = await this.repo.listDomains();
    return listSuccess(domains);
  }

  // ----------------------------------------------------------
  // Scopes
  // ----------------------------------------------------------

  async registerScope(params: { scope: string }): Promise<ServiceResponse<{ scope: string }>> {
    const scope = await this.repo.registerScope(params.scope);
    return success({ scope });
  }

  async listScopes(): Promise<ServiceResponse<string[]>> {
    const scopes = await this.repo.listScopes();
    return listSuccess(scopes);
  }

  // ----------------------------------------------------------
  // Reports
  // ----------------------------------------------------------

  async registerReport(params: {
    kind: string;
    title: string;
    summary: string;
    actorId: number;
    scope?: string;
    bodyRef?: string;
    domainId?: number;
    intentId?: number;
    sourceRef?: string;
    assumedRole?: string;
    invokedSkillRef?: string;
    policyRef?: string;
  }): Promise<ServiceResponse<Report>> {
    const actor = await this.repo.getActor(toActorId(params.actorId));
    if (!actor) return fail("NOT_FOUND", `Actor ${params.actorId} not found`);
    if (actor.status !== "active") return fail("ACTOR_INACTIVE", `Actor ${actor.name} is ${actor.status}`);
    const report = await this.repo.registerReport({
      scope: params.scope ?? actor.defaultScope,
      kind: params.kind,
      title: params.title,
      summary: params.summary,
      actorId: actor.id,
      assumedRole: params.assumedRole,
      invokedSkillRef: params.invokedSkillRef,
      policyRef: params.policyRef,
      bodyRef: params.bodyRef,
      domainId: params.domainId != null ? toDomainId(params.domainId) : undefined,
      intentId: params.intentId != null ? intendId(params.intentId) : undefined,
      sourceRef: params.sourceRef,
    });
    return success(report);
  }

  async getReport(id: number): Promise<ServiceResponse<Report>> {
    const report = await this.repo.getReport(toReportId(id));
    if (!report) return fail("NOT_FOUND", `Report ${id} not found`);
    return success(report);
  }

  async listReports(params?: {
    scope?: string;
    kind?: string;
    intentId?: number;
    domainId?: number;
    actorId?: number;
    limit?: number;
    offset?: number;
  }): Promise<ServiceResponse<Report[]>> {
    let results = await this.repo.listReports({
      scope: params?.scope,
      kind: params?.kind,
      intentId: params?.intentId != null ? intendId(params.intentId) : undefined,
      domainId: params?.domainId != null ? toDomainId(params.domainId) : undefined,
      actorId: params?.actorId != null ? toActorId(params.actorId) : undefined,
    });
    const offset = params?.offset ?? 0;
    const limit = params?.limit && params.limit > 0 ? Math.min(params.limit, 100) : 20;
    const paged = results.slice(offset, offset + limit);
    const has_more = offset + limit < results.length;
    return listSuccess(paged, has_more);
  }
}
