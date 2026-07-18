import { Actor, Action, ActorRoleBindingStatus, ActorSessionStatus, ActorStatus, ClaimStatus, ContractKind, ContractStatus, ExpertiseSignal, GovernanceRoleStatus, IntentStatus, InterpretationAlignment, InterpretationStatus } from "../governance/domain.js";
import { GovernanceRepository } from "../governance/repository.js";
import { GovernanceService, ServiceResponse } from "../governance/service.js";
import { SqliteGovernanceRepository } from "../governance/sqlite-governance-repository.js";
import { ObsidianVaultService, VaultCommandResult } from "../vault/obsidian-vault-service.js";

export interface CmlClientOptions {
  dbPath?: string;
  actor?: string;
  actorId?: number;
  repository?: GovernanceRepository;
  obsidianBin?: string;
  vaultName?: string;
  vaultRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface VaultMutationResult {
  vault: VaultCommandResult;
  action: Action | ServiceResponse<never>;
}

type SearchFormat = "text" | "json";

const SCHEMA_VERSION = 2;

function success<T>(data: T, extra?: { count?: number; has_more?: boolean }): ServiceResponse<T> {
  return { ok: true, data, meta: { schema_version: SCHEMA_VERSION, ...extra } };
}

function fail<T = never>(code: string, message: string): ServiceResponse<T> {
  return { ok: false, error: { code, message } };
}

function parseEnvActorId(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.CML_ACTOR_ID) return undefined;
  const parsed = Number(env.CML_ACTOR_ID);
  if (!Number.isInteger(parsed)) throw new Error("CML_ACTOR_ID must be an integer");
  return parsed;
}

function toErrorResponse(error: unknown): ServiceResponse<never> {
  if (error instanceof CmlSdkError) return fail(error.code, error.message);
  return fail("SDK_ERROR", error instanceof Error ? error.message : String(error));
}

export class CmlSdkError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CmlSdkError";
  }
}

export class CmlClient {
  private readonly repo: GovernanceRepository;
  private readonly service: GovernanceService;
  private readonly vaultService: ObsidianVaultService;
  private readonly actorId?: number;
  private readonly actorName?: string;
  private readonly ownsRepo: boolean;

  constructor(options: CmlClientOptions = {}) {
    const env = options.env ?? process.env;
    this.actorId = options.actorId ?? (options.actor ? undefined : parseEnvActorId(env));
    this.actorName = this.actorId != null ? undefined : options.actor ?? env.CML_ACTOR;
    if (this.actorId == null && !this.actorName) {
      throw new CmlSdkError("ACTOR_REQUIRED", "Set actor/actorId or CML_ACTOR/CML_ACTOR_ID");
    }

    if (options.repository) {
      this.repo = options.repository;
      this.ownsRepo = false;
    } else {
      const dbPath = options.dbPath ?? env.CML_DB_PATH;
      if (!dbPath) throw new CmlSdkError("DB_PATH_REQUIRED", "Set dbPath or CML_DB_PATH");
      this.repo = new SqliteGovernanceRepository(dbPath);
      this.ownsRepo = true;
    }

    this.service = new GovernanceService(this.repo);
    this.vaultService = new ObsidianVaultService({
      obsidianBin: options.obsidianBin ?? env.CML_OBSIDIAN_BIN,
      vaultName: options.vaultName ?? env.CML_OBSIDIAN_VAULT,
      vaultRoot: options.vaultRoot ?? env.CML_VAULT_ROOT,
      env,
    });
  }

  close(): void {
    if (this.ownsRepo && "close" in this.repo && typeof this.repo.close === "function") {
      this.repo.close();
    }
  }

  get intent() {
    return {
      create: (params: { description: string; source?: string; scope?: string; addressedTo?: number; parentId?: number; status?: IntentStatus }) =>
        this.withActor((actor) => this.service.registerIntent({
          ...params,
          source: params.source ?? `cml-sdk:${actor.name}`,
          scope: params.scope ?? actor.defaultScope,
          actorId: actor.id,
        })),
      get: (id: number) => this.withActor(() => this.service.getIntent(id)),
      list: (params?: { scope?: string; status?: IntentStatus; addressedTo?: number; parentId?: number | null; limit?: number; offset?: number }) =>
        this.withActor((actor) => this.service.listIntents({ scope: params?.scope ?? actor.defaultScope, ...params })),
      update: (params: { id: number; reason: string; status?: IntentStatus; description?: string; resolutionNotes?: string; addressedTo?: number }) =>
        this.withActor((actor) => this.service.updateIntent({ ...params, actorId: actor.id })),
    };
  }

  get interpret() {
    return {
      create: (params: { intentId: number; domainId: number; title: string; scopeAssumption?: string; status?: InterpretationStatus; alignment?: InterpretationAlignment; sourceRef?: string; resolverId?: number; resolveBy?: string }) =>
        this.withActor((actor) => this.service.registerInterpretation({
          ...params,
          actorId: actor.id,
          sourceRef: params.sourceRef ?? `cml-sdk:${actor.name}`,
        })),
      file: (params: { intentId: number; domainId: number; title: string; scopeAssumption?: string; status?: InterpretationStatus; alignment?: InterpretationAlignment; sourceRef?: string; resolverId?: number; resolveBy?: string }) =>
        this.withActor((actor) => this.service.registerInterpretation({
          ...params,
          actorId: actor.id,
          sourceRef: params.sourceRef ?? `cml-sdk:${actor.name}`,
        })),
      get: (id: number) => this.withActor(() => this.service.getInterpretation(id)),
      list: (params?: { intentId?: number; domainId?: number; actorId?: number; status?: InterpretationStatus; alignment?: InterpretationAlignment; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listInterpretations(params)),
      update: (params: { id: number; reason: string; status?: InterpretationStatus; alignment?: InterpretationAlignment; resolverId?: number; resolveBy?: string; scopeAssumption?: string; sourceRef?: string }) =>
        this.withActor((actor) => this.service.updateInterpretation({ ...params, actorId: actor.id })),
      supersede: (params: { id: number; newTitle: string; reason: string; newScopeAssumption?: string; newStatus?: InterpretationStatus }) =>
        this.withActor(() => this.service.supersedeInterpretation(params)),
    };
  }

  get action() {
    return {
      log: (params: { intentId: number; description: string; interpretationId?: number; domainId?: number; governingContractKey?: string; outcome?: string; assumedRole?: string; invokedSkillRef?: string; policyRef?: string }) =>
        this.withActor((actor) => this.service.logAction({ ...params, actorId: actor.id })),
      list: (params?: { intentId?: number; actorId?: number; domainId?: number; governingContractKey?: string; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listActions(params)),
    };
  }

  get claim() {
    return {
      create: (params: { entityTable?: string; entityId: number; note?: string }) =>
        this.withActor((actor) => this.service.claim({
          entityTable: params.entityTable ?? "intents",
          entityId: params.entityId,
          actorId: actor.id,
          note: params.note,
        })),
      release: (params: { id: number; reason?: string }) => this.withActor(() => this.service.releaseClaim(params)),
      list: (params?: { entityTable?: string; entityId?: number; status?: ClaimStatus; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listClaims(params)),
    };
  }

  get actor() {
    return {
      current: () => this.withActor((actor) => Promise.resolve(success(actor))),
      get: (params: { id?: number; name?: string }) => this.withActor(() => this.service.getActor(params)),
      list: (params?: { status?: ActorStatus; provider?: string }) => this.withActor(() => this.service.listActors(params)),
      provision: (params: { name: string; role: "human" | "agent"; provider: string; actorType?: string; capabilityNamespace: string; defaultScope?: string; sessionId?: string; status?: ActorStatus; contractKey?: string; defaultContractKey?: string; contractRef?: string; contextRef?: string; contextPolicy?: string; description?: string }) =>
        this.withActor(() => this.service.registerActor(params)),
      update: (params: { id: number; name?: string; role?: "human" | "agent"; provider?: string; actorType?: string; capabilityNamespace?: string; defaultScope?: string; sessionId?: string; status?: ActorStatus; contractKey?: string; defaultContractKey?: string; contractRef?: string; contextRef?: string; contextPolicy?: string; description?: string }) =>
        this.withActor(() => this.service.updateActor(params)),
      retire: (params: { id: number; reason?: string }) => this.withActor(() => this.service.retireActor(params)),
    };
  }

  get role() {
    return {
      get: (params: { id?: number; name?: string }) => this.withActor(() => this.service.getRole(params)),
      list: (params?: { status?: GovernanceRoleStatus }) => this.withActor(() => this.service.listRoles(params)),
      bindings: (params?: { actorId?: number; roleId?: number; surface?: string; status?: ActorRoleBindingStatus; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listActorRoleBindings(params)),
    };
  }

  get session() {
    return {
      open: (params: { sessionRef: string; surface: string; provider?: string; transcriptRef?: string }) =>
        this.withActor((actor) => this.service.openActorSession({ ...params, actorId: actor.id })),
      heartbeat: (params: { sessionRef: string }) =>
        this.withActor((actor) => this.service.heartbeatActorSession({ ...params, actorId: actor.id })),
      close: (params: { sessionRef: string }) =>
        this.withActor((actor) => this.service.closeActorSession({ ...params, actorId: actor.id })),
      list: (params?: { actorId?: number; status?: ActorSessionStatus; limit?: number; offset?: number }) =>
        this.withActor((actor) => this.service.listActorSessions({ ...params, actorId: params?.actorId ?? actor.id })),
    };
  }

  get report() {
    return {
      create: (params: { kind: string; title: string; summary: string; scope?: string; bodyRef?: string; domainId?: number; intentId?: number; sourceRef?: string; assumedRole?: string; invokedSkillRef?: string; policyRef?: string }) =>
        this.withActor((actor) => this.service.registerReport({
          ...params,
          actorId: actor.id,
          scope: params.scope ?? actor.defaultScope,
        })),
      get: (id: number) => this.withActor(() => this.service.getReport(id)),
      list: (params?: { scope?: string; kind?: string; intentId?: number; domainId?: number; actorId?: number; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listReports(params)),
    };
  }

  get contract() {
    return {
      register: (params: { key: string; kind: ContractKind; title: string; body: string; scope?: string; domainId?: number; parentKey?: string; status?: ContractStatus; governingContractKey?: string; mandateRef?: string }) =>
        this.withActor((actor) => this.service.registerContract({
          ...params,
          scope: params.scope ?? actor.defaultScope,
          custodianActorId: actor.id,
        })),
      get: (params: { id?: number; key?: string; status?: ContractStatus }) =>
        this.withActor(() => this.service.getContract(params)),
      list: (params?: { key?: string; kind?: ContractKind; scope?: string; domainId?: number; status?: ContractStatus; parentKey?: string; governingContractKey?: string; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listContracts(params)),
      supersede: (params: { id: number; body: string; reason: string; title?: string; status?: ContractStatus; domainId?: number; governingContractKey?: string; mandateRef?: string }) =>
        this.withActor((actor) => this.service.supersedeContract({
          ...params,
          custodianActorId: actor.id,
        })),
    };
  }

  get actorType() {
    return {
      register: (params: { name: string; body: string; title?: string; scope?: string; domainId?: number; parentKey?: string; status?: ContractStatus; governingContractKey?: string; mandateRef?: string }) =>
        this.withActor((actor) => this.service.registerActorTypeContract({
          ...params,
          scope: params.scope ?? actor.defaultScope,
          custodianActorId: actor.id,
        })),
      get: (params: { name: string; status?: ContractStatus }) => {
        const key = `actor-type:${params.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
        return this.withActor(() => this.service.getContract({ key, status: params.status }));
      },
      list: (params?: { scope?: string; domainId?: number; status?: ContractStatus; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listContracts({ ...params, kind: "actor_type" })),
    };
  }

  get domain() {
    return {
      register: (params: { scope?: string; name: string; concern: string; notionPageId?: string }) =>
        this.withActor((actor) => this.service.registerDomain({ ...params, scope: params.scope ?? actor.defaultScope })),
      get: (id: number) => this.withActor(() => this.service.getDomain(id)),
      list: () => this.withActor(() => this.service.listDomains()),
    };
  }

  get scope() {
    return {
      register: (params: { scope: string }) => this.withActor(() => this.service.registerScope(params)),
      list: () => this.withActor(() => this.service.listScopes()),
    };
  }

  get expertise() {
    return {
      register: (params: { intentId: number; domainId: number; signal: ExpertiseSignal; note?: string }) =>
        this.withActor((actor) => this.service.registerExpertise({ ...params, actorId: actor.id })),
      coverage: (params: { intentId: number }) => this.withActor(() => this.service.getExpertiseCoverage(params)),
    };
  }

  get event() {
    return {
      list: (params?: { scope?: string; entityTable?: string; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.listEvents(params)),
      history: (params: { entityTable: string; entityId: number; limit?: number; offset?: number }) =>
        this.withActor(() => this.service.getEntityHistory(params)),
    };
  }

  get vault() {
    return {
      read: (params: { path: string }) => this.withActor(async () => success(await this.vaultService.read(params.path))),
      search: (params: { query: string; path?: string; limit?: number; format?: SearchFormat }) =>
        this.withActor(async () => success(await this.vaultService.search(params.query, params))),
      write: (params: { intent: number; path: string; content: string; governingContractKey?: string; assumedRole?: string; invokedSkillRef?: string; policyRef?: string }) =>
        this.vaultMutation(params.intent, "write", params.path, () => this.vaultService.write(params.path, params.content), undefined, params),
      append: (params: { intent: number; path: string; content: string; governingContractKey?: string; assumedRole?: string; invokedSkillRef?: string; policyRef?: string }) =>
        this.vaultMutation(params.intent, "append", params.path, () => this.vaultService.append(params.path, params.content), undefined, params),
      move: (params: { intent: number; path: string; to: string }) =>
        this.vaultMutation(params.intent, "move", params.path, () => this.vaultService.move(params.path, params.to), params.to),
      delete: (params: { intent: number; path: string; confirm: true }) =>
        this.vaultMutation(params.intent, "delete", params.path, () => this.vaultService.delete(params.path)),
    };
  }

  async status(): Promise<ServiceResponse<{ actor: Actor; activeIntents: unknown[]; activeClaims: unknown[] }>> {
    return this.withActor(async (actor) => {
      const [intents, claims] = await Promise.all([
        this.service.listIntents({ scope: actor.defaultScope, status: "active", limit: 100 }),
        this.service.listClaims({ status: "active", limit: 100 }),
      ]);
      return success({
        actor,
        activeIntents: intents.ok ? intents.data : [],
        activeClaims: claims.ok ? claims.data : [],
      });
    });
  }

  private async vaultMutation(
    intentId: number,
    operation: string,
    path: string,
    mutate: () => Promise<VaultCommandResult>,
    destination?: string,
    invocation?: { governingContractKey?: string; assumedRole?: string; invokedSkillRef?: string; policyRef?: string }
  ): Promise<ServiceResponse<VaultMutationResult>> {
    return this.withActor(async (actor) => {
      const intent = await this.service.getIntent(intentId);
      if (!intent.ok) return intent;
      const result = await mutate();
      const action = await this.service.logAction({
        intentId,
        actorId: actor.id,
        governingContractKey: invocation?.governingContractKey,
        assumedRole: invocation?.assumedRole,
        invokedSkillRef: invocation?.invokedSkillRef,
        policyRef: invocation?.policyRef,
        description: `Vault ${operation}: ${path}${destination ? ` -> ${destination}` : ""}`,
        outcome: result.data,
      });
      return success({ vault: result, action: action.ok ? action.data : action });
    });
  }

  private async withActor<T>(fn: (actor: Actor) => Promise<ServiceResponse<T>>): Promise<ServiceResponse<T>> {
    try {
      const actor = await this.resolveActiveActor();
      return await fn(actor);
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  private async resolveActiveActor(): Promise<Actor> {
    const actor = this.actorId != null
      ? await this.repo.getActor(this.actorId as Actor["id"])
      : this.actorName != null ? await this.repo.getActorByName(this.actorName) : null;
    if (!actor) {
      throw new CmlSdkError(
        "ACTOR_NOT_FOUND",
        this.actorId != null ? `Actor ${this.actorId} not found` : `Actor '${this.actorName ?? ""}' not found`
      );
    }
    if (actor.status !== "active") {
      throw new CmlSdkError("ACTOR_INACTIVE", `Actor ${actor.name} is ${actor.status}`);
    }
    return actor;
  }
}
