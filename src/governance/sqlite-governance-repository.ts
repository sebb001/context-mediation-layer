import { DatabaseSync } from "node:sqlite";

import {
  Action,
  ActionId,
  Actor,
  ActorId,
  ActorRoleBinding,
  ActorRoleBindingStatus,
  ActorSession,
  ActorSessionId,
  ActorSessionStatus,
  ActorStatus,
  Claim,
  ClaimId,
  ClaimStatus,
  Contract,
  ContractId,
  ContractKind,
  ContractStatus,
  Domain,
  DomainId,
  Event,
  EventType,
  ExpertiseSignalRecord,
  Intent,
  IntentEnriched,
  IntentId,
  IntentStatus,
  Interpretation,
  InterpretationAlignment,
  InterpretationEnriched,
  InterpretationId,
  InterpretationStatus,
  Report,
  ReportId,
  GovernanceRole,
  GovernanceRoleStatus,
  RoleId,
  actionId,
  actorId,
  actorRoleBindingId,
  actorSessionId,
  claimId,
  contractId,
  domainId,
  eventId,
  expertiseSignalId,
  intendId,
  interpretationId,
  reportId,
  roleId,
} from "./domain.js";
import { ActorCreate, ActorRoleBindingCreate, ActorSessionCreate, ContractCreate, ContractSupersedeInput, GovernanceRepository, GovernanceRoleCreate, ReportCreate, RepositoryError } from "./repository.js";
import { CORE_SCHEMA_SQL } from "./schema.js";

type Row = Record<string, unknown>;
type SqlParam = string | number | bigint | null;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asDate(value: unknown): Date {
  return new Date(String(value));
}

function asDateOrNow(value: unknown): Date {
  return value == null ? new Date() : asDate(value);
}

function nullable<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function requireActor(actor: ActorId | undefined, operation: string): ActorId {
  if (actor == null) {
    throw new Error(`${operation} requires actorId for event attribution`);
  }
  return actor;
}

function toDbDate(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

function parseSnapshot(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function intentFromRow(row: Row): Intent {
  return {
    id: intendId(Number(row.id)),
    scope: String(row.scope),
    description: String(row.description),
    status: String(row.status) as IntentStatus,
    version: Number(row.version),
    source: String(row.source),
    addressedTo: row.addressed_to == null ? undefined : actorId(Number(row.addressed_to)),
    parentId: row.parent_id == null ? undefined : intendId(Number(row.parent_id)),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    resolutionNotes: asString(row.resolution_notes),
  };
}

function interpretationFromRow(row: Row): Interpretation {
  return {
    id: interpretationId(Number(row.id)),
    intentId: intendId(Number(row.intent_id)),
    domainId: domainId(Number(row.domain_id)),
    actorId: actorId(Number(row.actor_id)),
    title: String(row.title),
    scopeAssumption: asString(row.scope_assumption),
    alignment: String(row.alignment) as InterpretationAlignment,
    status: String(row.status) as InterpretationStatus,
    resolverId: row.resolver_id == null ? undefined : actorId(Number(row.resolver_id)),
    resolveBy: row.resolve_by == null ? undefined : asDate(row.resolve_by),
    supersededBy: row.superseded_by == null ? undefined : interpretationId(Number(row.superseded_by)),
    sourceRef: asString(row.source_ref),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function actionFromRow(row: Row): Action {
  return {
    id: actionId(Number(row.id)),
    intentId: intendId(Number(row.intent_id)),
    interpretationId: row.interpretation_id == null ? undefined : interpretationId(Number(row.interpretation_id)),
    actorId: actorId(Number(row.actor_id)),
    domainId: row.domain_id == null ? undefined : domainId(Number(row.domain_id)),
    governingContractKey: asString(row.governing_contract_key),
    assumedRole: asString(row.assumed_role),
    invokedSkillRef: asString(row.invoked_skill_ref),
    policyRef: asString(row.policy_ref),
    description: String(row.description),
    outcome: asString(row.outcome),
    createdAt: asDate(row.created_at),
  };
}

function roleFromRow(row: Row): GovernanceRole {
  return {
    id: roleId(Number(row.id)),
    name: String(row.name),
    status: String(row.status) as GovernanceRoleStatus,
    contractKey: asString(row.contract_key),
    contractRef: asString(row.contract_ref),
    contextRef: asString(row.context_ref),
    policyRef: asString(row.policy_ref),
    description: asString(row.description),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function actorRoleBindingFromRow(row: Row): ActorRoleBinding {
  return {
    id: actorRoleBindingId(Number(row.id)),
    actorId: actorId(Number(row.actor_id)),
    roleId: roleId(Number(row.role_id)),
    surface: String(row.surface),
    provider: String(row.provider),
    credentialRef: asString(row.credential_ref),
    status: String(row.status) as ActorRoleBindingStatus,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function claimFromRow(row: Row): Claim {
  return {
    id: claimId(Number(row.id)),
    entityTable: String(row.entity_table),
    entityId: Number(row.entity_id),
    actorId: actorId(Number(row.actor_id)),
    status: String(row.status) as ClaimStatus,
    note: asString(row.note),
    createdAt: asDate(row.created_at),
    releasedAt: row.released_at == null ? undefined : asDate(row.released_at),
  };
}

function domainFromRow(row: Row): Domain {
  return {
    id: domainId(Number(row.id)),
    scope: String(row.scope),
    name: String(row.name),
    concern: String(row.concern),
    notionPageId: asString(row.notion_page_id),
  };
}

function contractFromRow(row: Row): Contract {
  return {
    id: contractId(Number(row.id)),
    key: String(row.key),
    kind: String(row.kind) as ContractKind,
    scope: String(row.scope),
    domainId: row.domain_id == null ? undefined : domainId(Number(row.domain_id)),
    parentKey: asString(row.parent_key),
    title: String(row.title),
    body: String(row.body),
    status: String(row.status) as ContractStatus,
    version: Number(row.version),
    custodianActorId: actorId(Number(row.custodian_actor_id)),
    governingContractKey: asString(row.governing_contract_key),
    mandateRef: asString(row.mandate_ref),
    contentHash: String(row.content_hash),
    supersedes: row.supersedes == null ? undefined : contractId(Number(row.supersedes)),
    supersededBy: row.superseded_by == null ? undefined : contractId(Number(row.superseded_by)),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function contractEventSnapshot(contract: Contract): Record<string, unknown> {
  const snapshot = { ...contract, bodyLength: contract.body.length } as Record<string, unknown>;
  delete snapshot.body;
  return snapshot;
}

function actorFromRow(row: Row): Actor {
  return {
    id: actorId(Number(row.id)),
    name: String(row.name),
    role: String(row.role) as Actor["role"],
    provider: String(row.provider),
    actorType: asString(row.actor_type),
    capabilityNamespace: String(row.capability_namespace),
    defaultScope: String(row.default_scope),
    status: (asString(row.status) ?? "active") as ActorStatus,
    contractKey: asString(row.contract_key),
    defaultContractKey: asString(row.default_contract_key),
    contractRef: asString(row.contract_ref),
    contextRef: asString(row.context_ref),
    contextPolicy: asString(row.context_policy),
    description: asString(row.description),
    sessionId: asString(row.session_id),
    createdAt: asDateOrNow(row.created_at),
    updatedAt: asDateOrNow(row.updated_at),
  };
}

function actorSessionFromRow(row: Row): ActorSession {
  return {
    id: actorSessionId(Number(row.id)),
    actorId: actorId(Number(row.actor_id)),
    sessionRef: String(row.session_ref),
    surface: String(row.surface),
    provider: String(row.provider),
    status: String(row.status) as ActorSessionStatus,
    transcriptRef: asString(row.transcript_ref),
    startedAt: asDate(row.started_at),
    lastSeenAt: asDate(row.last_seen_at),
    endedAt: row.ended_at == null ? undefined : asDate(row.ended_at),
  };
}

function expertiseFromRow(row: Row): ExpertiseSignalRecord {
  return {
    id: expertiseSignalId(Number(row.id)),
    intentId: intendId(Number(row.intent_id)),
    domainId: domainId(Number(row.domain_id)),
    actorId: actorId(Number(row.actor_id)),
    signal: String(row.signal) as ExpertiseSignalRecord["signal"],
    note: asString(row.note),
    createdAt: asDate(row.created_at),
  };
}

function eventFromRow(row: Row): Event {
  return {
    id: eventId(Number(row.id)),
    scope: String(row.scope),
    eventType: String(row.event_type),
    entityTable: String(row.entity_table),
    entityId: Number(row.entity_id),
    actorId: actorId(Number(row.actor_id)),
    reason: asString(row.reason),
    snapshot: parseSnapshot(row.snapshot),
    createdAt: asDate(row.created_at),
  };
}

function reportFromRow(row: Row): Report {
  return {
    id: reportId(Number(row.id)),
    scope: String(row.scope),
    kind: String(row.kind),
    title: String(row.title),
    summary: String(row.summary),
    bodyRef: asString(row.body_ref),
    actorId: actorId(Number(row.actor_id)),
    assumedRole: asString(row.assumed_role),
    invokedSkillRef: asString(row.invoked_skill_ref),
    policyRef: asString(row.policy_ref),
    domainId: row.domain_id == null ? undefined : domainId(Number(row.domain_id)),
    intentId: row.intent_id == null ? undefined : intendId(Number(row.intent_id)),
    sourceRef: asString(row.source_ref),
    createdAt: asDate(row.created_at),
  };
}

export class SqliteGovernanceRepository implements GovernanceRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.ensureCoreSchema();
    this.ensureProvisionedIdentitySchema();
  }

  close(): void {
    this.db.close();
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return new Set(rows.map((row) => String(row.name)));
  }

  private hasTable(table: string): boolean {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) != null;
  }

  private ensureCoreSchema(): void {
    if (!this.hasTable("actors")) {
      this.db.exec(CORE_SCHEMA_SQL);
      this.db.prepare(
        "INSERT OR IGNORE INTO scopes (name, description) VALUES (?, ?)"
      ).run("default", "Default coordination scope.");
    }
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    if (!this.tableColumns(table).has(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  private ensureProvisionedIdentitySchema(): void {
    const actorColumns = this.tableColumns("actors");
    const actorSchemaCurrent = ["status", "actor_type", "contract_key", "default_contract_key", "contract_ref", "context_ref", "context_policy", "description", "created_at", "updated_at"]
      .every((column) => actorColumns.has(column));
    const hasActorSessions = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actor_sessions'").get() != null;
    const hasReports = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reports'").get() != null;
    const hasRoles = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'roles'").get() != null;
    const hasActorRoleBindings = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actor_role_bindings'").get() != null;
    const hasContracts = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contracts'").get() != null;
    const roleColumns = hasRoles ? this.tableColumns("roles") : new Set<string>();
    const roleSchemaCurrent = hasRoles && roleColumns.has("contract_key");
    const actionColumns = this.tableColumns("actions");
    const actionAuthoritySchemaCurrent = ["domain_id", "governing_contract_key"]
      .every((column) => actionColumns.has(column));
    const contractColumns = hasContracts ? this.tableColumns("contracts") : new Set<string>();
    const contractAuthoritySchemaCurrent = hasContracts && ["domain_id", "governing_contract_key"]
      .every((column) => contractColumns.has(column));
    const reportColumns = hasReports ? this.tableColumns("reports") : new Set<string>();
    const invocationSchemaCurrent = ["assumed_role", "invoked_skill_ref", "policy_ref"]
      .every((column) => actionColumns.has(column) && reportColumns.has(column));
    if (
      actorSchemaCurrent &&
      hasActorSessions &&
      hasReports &&
      hasRoles &&
      roleSchemaCurrent &&
      hasActorRoleBindings &&
      hasContracts &&
      contractAuthoritySchemaCurrent &&
      actionAuthoritySchemaCurrent &&
      invocationSchemaCurrent
    ) return;

    try {
      this.db.exec("BEGIN");
      this.addColumnIfMissing("actors", "status", "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired'))");
      this.addColumnIfMissing("actors", "actor_type", "actor_type TEXT");
      this.addColumnIfMissing("actors", "contract_key", "contract_key TEXT");
      this.addColumnIfMissing("actors", "default_contract_key", "default_contract_key TEXT");
      this.addColumnIfMissing("actors", "contract_ref", "contract_ref TEXT");
      this.addColumnIfMissing("actors", "context_ref", "context_ref TEXT");
      this.addColumnIfMissing("actors", "context_policy", "context_policy TEXT");
      this.addColumnIfMissing("actors", "description", "description TEXT");
      this.addColumnIfMissing("actors", "created_at", "created_at TEXT");
      this.addColumnIfMissing("actors", "updated_at", "updated_at TEXT");
      this.addColumnIfMissing("actions", "assumed_role", "assumed_role TEXT");
      this.addColumnIfMissing("actions", "invoked_skill_ref", "invoked_skill_ref TEXT");
      this.addColumnIfMissing("actions", "policy_ref", "policy_ref TEXT");
      this.addColumnIfMissing("actions", "domain_id", "domain_id INTEGER REFERENCES domains(id)");
      this.addColumnIfMissing("actions", "governing_contract_key", "governing_contract_key TEXT");
      this.db.exec("UPDATE actors SET created_at = COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), updated_at = COALESCE(updated_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          name         TEXT NOT NULL UNIQUE,
          status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
          contract_key TEXT,
          contract_ref TEXT,
          context_ref  TEXT,
          policy_ref   TEXT,
          description  TEXT,
          created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        );
        CREATE TABLE IF NOT EXISTS actor_role_bindings (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id       INTEGER NOT NULL,
          role_id        INTEGER NOT NULL,
          surface        TEXT NOT NULL,
          provider       TEXT NOT NULL,
          credential_ref TEXT,
          status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
          created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          UNIQUE(actor_id, role_id, surface, credential_ref),
          FOREIGN KEY (actor_id) REFERENCES actors(id),
          FOREIGN KEY (role_id) REFERENCES roles(id)
        );
        CREATE INDEX IF NOT EXISTS idx_actor_role_bindings_actor ON actor_role_bindings(actor_id, status);
        CREATE INDEX IF NOT EXISTS idx_actor_role_bindings_role ON actor_role_bindings(role_id, status);
        CREATE TABLE IF NOT EXISTS contracts (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          key                TEXT NOT NULL,
          kind               TEXT NOT NULL CHECK (kind IN ('root', 'system', 'role', 'actor', 'actor_type', 'skill', 'policy', 'process')),
          scope              TEXT NOT NULL DEFAULT 'default',
          domain_id          INTEGER,
          parent_key         TEXT,
          title              TEXT NOT NULL,
          body               TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
          version            INTEGER NOT NULL DEFAULT 1,
          custodian_actor_id INTEGER NOT NULL,
          governing_contract_key TEXT,
          mandate_ref        TEXT,
          content_hash       TEXT NOT NULL,
          supersedes         INTEGER,
          superseded_by      INTEGER,
          created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          UNIQUE(key, version),
          FOREIGN KEY (scope) REFERENCES scopes(name),
          FOREIGN KEY (domain_id) REFERENCES domains(id),
          FOREIGN KEY (custodian_actor_id) REFERENCES actors(id),
          FOREIGN KEY (supersedes) REFERENCES contracts(id),
          FOREIGN KEY (superseded_by) REFERENCES contracts(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_open_key ON contracts(key) WHERE status IN ('draft', 'active');
        CREATE INDEX IF NOT EXISTS idx_contracts_kind_status ON contracts(kind, status);
        CREATE INDEX IF NOT EXISTS idx_contracts_scope_status ON contracts(scope, status);
        CREATE INDEX IF NOT EXISTS idx_contracts_parent ON contracts(parent_key, status);
        CREATE INDEX IF NOT EXISTS idx_actions_domain ON actions(domain_id);
        CREATE INDEX IF NOT EXISTS idx_actions_governing_contract ON actions(governing_contract_key);
        CREATE TABLE IF NOT EXISTS actor_sessions (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id       INTEGER NOT NULL,
          session_ref    TEXT NOT NULL,
          surface        TEXT NOT NULL,
          provider       TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
          transcript_ref TEXT,
          started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          ended_at       TEXT,
          UNIQUE(actor_id, session_ref),
          FOREIGN KEY (actor_id) REFERENCES actors(id)
        );
        CREATE INDEX IF NOT EXISTS idx_actor_sessions_actor_status ON actor_sessions(actor_id, status);
        CREATE INDEX IF NOT EXISTS idx_actor_sessions_ref ON actor_sessions(session_ref);
        CREATE TABLE IF NOT EXISTS reports (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          scope       TEXT NOT NULL DEFAULT 'default',
          kind        TEXT NOT NULL,
          title       TEXT NOT NULL,
          summary     TEXT NOT NULL,
          body_ref    TEXT,
          actor_id    INTEGER NOT NULL,
          domain_id   INTEGER,
          intent_id   INTEGER,
          source_ref  TEXT,
          created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          FOREIGN KEY (scope) REFERENCES scopes(name),
          FOREIGN KEY (actor_id) REFERENCES actors(id),
          FOREIGN KEY (domain_id) REFERENCES domains(id),
          FOREIGN KEY (intent_id) REFERENCES intents(id)
        );
        CREATE INDEX IF NOT EXISTS idx_reports_scope_kind ON reports(scope, kind);
        CREATE INDEX IF NOT EXISTS idx_reports_intent ON reports(intent_id);
        CREATE INDEX IF NOT EXISTS idx_reports_actor ON reports(actor_id);
      `);
      this.addColumnIfMissing("roles", "contract_key", "contract_key TEXT");
      this.addColumnIfMissing("contracts", "domain_id", "domain_id INTEGER REFERENCES domains(id)");
      this.addColumnIfMissing("contracts", "governing_contract_key", "governing_contract_key TEXT");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_contracts_domain_status ON contracts(domain_id, status);
        CREATE INDEX IF NOT EXISTS idx_contracts_governing_contract ON contracts(governing_contract_key);
      `);
      this.addColumnIfMissing("reports", "assumed_role", "assumed_role TEXT");
      this.addColumnIfMissing("reports", "invoked_skill_ref", "invoked_skill_ref TEXT");
      this.addColumnIfMissing("reports", "policy_ref", "policy_ref TEXT");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async createIntent(
    intent: Omit<Intent, "id" | "version" | "createdAt" | "updatedAt" | "status"> & { status?: IntentStatus },
    actor?: ActorId
  ): Promise<Intent> {
    const result = this.db.prepare(
      `INSERT INTO intents (scope, description, status, source, addressed_to, parent_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      intent.scope,
      intent.description,
      intent.status ?? "draft",
      intent.source,
      intent.addressedTo ?? null,
      intent.parentId ?? null
    );
    const created = await this.getIntent(intendId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted intent could not be read back");
    await this.emitEvent("intent_created", "intents", created.id, requireActor(actor, "createIntent"), {
      scope: created.scope,
      snapshot: created as unknown as Record<string, unknown>,
    });
    return created;
  }

  async getIntent(id: IntentId): Promise<IntentEnriched | null> {
    const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const intent = intentFromRow(row);
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM interpretations WHERE intent_id = ?").get(id) as Row;
    const expertiseSignals = await this.listExpertiseSignals(id);
    const activeClaims = await this.listClaims({ entityTable: "intents", entityId: id, status: "active" });
    return {
      ...intent,
      interpretationCount: Number(count.c),
      expertiseSignals,
      activeClaims,
    };
  }

  async updateIntent(
    id: IntentId,
    updates: Partial<Omit<Intent, "id" | "createdAt">>,
    reason: string,
    actor?: ActorId
  ): Promise<Intent | RepositoryError> {
    const current = await this.getIntent(id);
    if (!current) return { code: "NOT_FOUND", message: `Intent ${id} not found` };

    const next = {
      status: updates.status ?? current.status,
      description: updates.description ?? current.description,
      source: updates.source ?? current.source,
      addressedTo: "addressedTo" in updates ? nullable(updates.addressedTo) : current.addressedTo,
      parentId: "parentId" in updates ? nullable(updates.parentId) : current.parentId,
      resolutionNotes: "resolutionNotes" in updates ? nullable(updates.resolutionNotes) : current.resolutionNotes,
    };

    this.db.prepare(
      `UPDATE intents
       SET status = ?, description = ?, source = ?, addressed_to = ?, parent_id = ?,
           resolution_notes = ?, version = version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      next.status,
      next.description,
      next.source,
      next.addressedTo ?? null,
      next.parentId ?? null,
      next.resolutionNotes ?? null,
      id
    );

    const updated = await this.getIntent(id);
    if (!updated) return { code: "NOT_FOUND", message: `Intent ${id} not found after update` };
    await this.emitEvent("intent_updated", "intents", id, requireActor(actor, "updateIntent"), {
      scope: updated.scope,
      reason,
      snapshot: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async listIntents(filters?: { scope?: string; status?: IntentStatus; parentId?: IntentId | null }): Promise<Intent[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters && "parentId" in filters) {
      if (filters.parentId === null) {
        clauses.push("parent_id IS NULL");
      } else if (filters.parentId != null) {
        clauses.push("parent_id = ?");
        params.push(filters.parentId);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM intents ${where} ORDER BY updated_at DESC`).all(...params) as Row[];
    return rows.map(intentFromRow);
  }

  async createInterpretation(
    interpretation: Omit<Interpretation, "id" | "createdAt" | "updatedAt" | "status" | "alignment"> & {
      status?: InterpretationStatus;
      alignment?: InterpretationAlignment;
    }
  ): Promise<Interpretation> {
    const result = this.db.prepare(
      `INSERT INTO interpretations
       (intent_id, domain_id, actor_id, title, scope_assumption, alignment, status, resolver_id, resolve_by, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      interpretation.intentId,
      interpretation.domainId,
      interpretation.actorId,
      interpretation.title,
      interpretation.scopeAssumption ?? null,
      interpretation.alignment ?? "uncertain",
      interpretation.status ?? "clarifying",
      interpretation.resolverId ?? null,
      toDbDate(interpretation.resolveBy),
      interpretation.sourceRef ?? null
    );
    const created = await this.getInterpretation(interpretationId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted interpretation could not be read back");
    await this.emitEvent("interpretation_filed", "interpretations", created.id, created.actorId);
    return created;
  }

  async getInterpretation(id: InterpretationId): Promise<InterpretationEnriched | null> {
    const row = this.db.prepare("SELECT * FROM interpretations WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const interpretation = interpretationFromRow(row);
    const intent = await this.getIntent(interpretation.intentId);
    if (!intent) return null;
    const actions = await this.listActions({ intentId: interpretation.intentId });
    return {
      ...interpretation,
      intent,
      actions: actions.filter((action) => action.interpretationId === id),
    };
  }

  async updateInterpretation(
    id: InterpretationId,
    updates: Partial<Omit<Interpretation, "id" | "createdAt" | "title">>,
    reason: string,
    actor?: ActorId
  ): Promise<Interpretation | RepositoryError> {
    const current = await this.getInterpretation(id);
    if (!current) return { code: "NOT_FOUND", message: `Interpretation ${id} not found` };
    this.db.prepare(
      `UPDATE interpretations
       SET status = ?, alignment = ?, resolver_id = ?, resolve_by = ?, superseded_by = ?,
           scope_assumption = ?, source_ref = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      updates.status ?? current.status,
      updates.alignment ?? current.alignment,
      "resolverId" in updates ? updates.resolverId ?? null : current.resolverId ?? null,
      "resolveBy" in updates ? toDbDate(updates.resolveBy) : toDbDate(current.resolveBy),
      "supersededBy" in updates ? updates.supersededBy ?? null : current.supersededBy ?? null,
      "scopeAssumption" in updates ? updates.scopeAssumption ?? null : current.scopeAssumption ?? null,
      "sourceRef" in updates ? updates.sourceRef ?? null : current.sourceRef ?? null,
      id
    );
    const updated = await this.getInterpretation(id);
    if (!updated) return { code: "NOT_FOUND", message: `Interpretation ${id} not found after update` };
    await this.emitEvent("interpretation_updated", "interpretations", id, actor ?? current.actorId, {
      reason,
      snapshot: updated as unknown as Record<string, unknown>,
    });
    return updated;
  }

  async supersedeInterpretation(
    id: InterpretationId,
    newTitle: string,
    reason: string,
    newScopeAssumption?: string,
    newStatus?: InterpretationStatus
  ): Promise<{ old: Interpretation; replacement: Interpretation } | RepositoryError> {
    const current = await this.getInterpretation(id);
    if (!current) return { code: "NOT_FOUND", message: `Interpretation ${id} not found` };

    try {
      this.db.exec("BEGIN");
      const result = this.db.prepare(
        `INSERT INTO interpretations
         (intent_id, domain_id, actor_id, title, scope_assumption, alignment, status, source_ref)
         VALUES (?, ?, ?, ?, ?, 'uncertain', ?, ?)`
      ).run(
        current.intentId,
        current.domainId,
        current.actorId,
        newTitle,
        newScopeAssumption ?? null,
        newStatus ?? "clarifying",
        current.sourceRef ?? null
      );
      const replacementId = interpretationId(Number(result.lastInsertRowid));
      this.db.prepare(
        `UPDATE interpretations
         SET status = 'superseded', alignment = 'superseded', superseded_by = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?`
      ).run(replacementId, id);
      this.db.exec("COMMIT");

      await this.emitEvent("interpretation_superseded", "interpretations", id, current.actorId, { reason });
      await this.emitEvent("interpretation_filed", "interpretations", replacementId, current.actorId);

      const old = await this.getInterpretation(id);
      const replacement = await this.getInterpretation(replacementId);
      if (!old || !replacement) return { code: "INVALID_STATE", message: "Supersession readback failed" };
      return { old, replacement };
    } catch (error) {
      this.db.exec("ROLLBACK");
      return { code: "INVALID_STATE", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listInterpretations(filters?: {
    intentId?: IntentId;
    domainId?: DomainId;
    status?: InterpretationStatus;
    alignment?: string;
  }): Promise<Interpretation[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.intentId) {
      clauses.push("intent_id = ?");
      params.push(filters.intentId);
    }
    if (filters?.domainId) {
      clauses.push("domain_id = ?");
      params.push(filters.domainId);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.alignment) {
      clauses.push("alignment = ?");
      params.push(filters.alignment);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM interpretations ${where} ORDER BY updated_at DESC`).all(...params) as Row[];
    return rows.map(interpretationFromRow);
  }

  async logAction(action: Omit<Action, "id" | "createdAt">): Promise<Action> {
    const result = this.db.prepare(
      `INSERT INTO actions
       (intent_id, interpretation_id, actor_id, domain_id, governing_contract_key,
        assumed_role, invoked_skill_ref, policy_ref, description, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      action.intentId,
      action.interpretationId ?? null,
      action.actorId,
      action.domainId ?? null,
      action.governingContractKey ?? null,
      action.assumedRole ?? null,
      action.invokedSkillRef ?? null,
      action.policyRef ?? null,
      action.description,
      action.outcome ?? null
    );
    const created = await this.getAction(actionId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted action could not be read back");
    await this.emitEvent("action_logged", "actions", created.id, created.actorId);
    return created;
  }

  async getAction(id: ActionId): Promise<Action | null> {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    return row ? actionFromRow(row) : null;
  }

  async listActions(filters?: {
    intentId?: IntentId;
    actorId?: ActorId;
    domainId?: DomainId;
    governingContractKey?: string;
  }): Promise<Action[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.intentId) {
      clauses.push("intent_id = ?");
      params.push(filters.intentId);
    }
    if (filters?.actorId) {
      clauses.push("actor_id = ?");
      params.push(filters.actorId);
    }
    if (filters?.domainId) {
      clauses.push("domain_id = ?");
      params.push(filters.domainId);
    }
    if (filters?.governingContractKey) {
      clauses.push("governing_contract_key = ?");
      params.push(filters.governingContractKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM actions ${where} ORDER BY created_at DESC`).all(...params) as Row[];
    return rows.map(actionFromRow);
  }

  async acquireClaim(entityTable: string, entityId: number, actor: ActorId, note?: string): Promise<Claim> {
    const result = this.db.prepare(
      "INSERT INTO claims (entity_table, entity_id, actor_id, note) VALUES (?, ?, ?, ?)"
    ).run(entityTable, entityId, actor, note ?? null);
    const created = await this.getClaim(claimId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted claim could not be read back");
    await this.emitEvent("claim_acquired", entityTable, entityId, actor, { reason: note });
    return created;
  }

  async releaseClaim(id: ClaimId, reason?: string): Promise<void | RepositoryError> {
    const current = await this.getClaim(id);
    if (!current) return { code: "NOT_FOUND", message: `Claim ${id} not found` };
    if (current.status === "released") {
      return { code: "INVALID_TRANSITION", message: `Cannot release claim in status ${current.status}` };
    }
    this.db.prepare(
      "UPDATE claims SET status = 'released', released_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    ).run(id);
    await this.emitEvent("claim_released", current.entityTable, current.entityId, current.actorId, { reason });
  }

  async getClaim(id: ClaimId): Promise<Claim | null> {
    const row = this.db.prepare("SELECT * FROM claims WHERE id = ?").get(id) as Row | undefined;
    return row ? claimFromRow(row) : null;
  }

  async listClaims(filters?: { entityTable?: string; entityId?: number; status?: ClaimStatus }): Promise<Claim[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.entityTable) {
      clauses.push("entity_table = ?");
      params.push(filters.entityTable);
    }
    if (filters?.entityId != null) {
      clauses.push("entity_id = ?");
      params.push(filters.entityId);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM claims ${where} ORDER BY created_at DESC`).all(...params) as Row[];
    return rows.map(claimFromRow);
  }

  async registerDomain(domain: Omit<Domain, "id">): Promise<Domain> {
    const result = this.db.prepare(
      "INSERT INTO domains (scope, name, concern, notion_page_id) VALUES (?, ?, ?, ?)"
    ).run(domain.scope, domain.name, domain.concern, domain.notionPageId ?? null);
    const created = await this.getDomain(domainId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted domain could not be read back");
    return created;
  }

  async getDomain(id: DomainId): Promise<Domain | null> {
    const row = this.db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as Row | undefined;
    return row ? domainFromRow(row) : null;
  }

  async listDomains(): Promise<Domain[]> {
    const rows = this.db.prepare("SELECT * FROM domains ORDER BY scope, name").all() as Row[];
    return rows.map(domainFromRow);
  }

  async registerContract(contract: ContractCreate): Promise<Contract | RepositoryError> {
    const existingOpen = this.db.prepare(
      "SELECT * FROM contracts WHERE key = ? AND status IN ('draft', 'active') ORDER BY version DESC LIMIT 1"
    ).get(contract.key) as Row | undefined;
    if (existingOpen) {
      return {
        code: "CONFLICT",
        message: `Contract '${contract.key}' already has an open ${String(existingOpen.status)} revision`,
      };
    }

    const result = this.db.prepare(
      `INSERT INTO contracts
       (key, kind, scope, domain_id, parent_key, title, body, status, version, custodian_actor_id,
        governing_contract_key, mandate_ref, content_hash, supersedes, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      contract.key,
      contract.kind,
      contract.scope,
      contract.domainId ?? null,
      contract.parentKey ?? null,
      contract.title,
      contract.body,
      contract.status ?? "active",
      contract.version ?? 1,
      contract.custodianActorId,
      contract.governingContractKey ?? null,
      contract.mandateRef ?? null,
      contract.contentHash,
      contract.supersedes ?? null,
      contract.supersededBy ?? null
    );
    const created = await this.getContract(contractId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted contract could not be read back");
    await this.emitEvent("contract_registered", "contracts", created.id, created.custodianActorId, {
      scope: created.scope,
      snapshot: contractEventSnapshot(created),
    });
    return created;
  }

  async getContract(id: ContractId): Promise<Contract | null> {
    const row = this.db.prepare("SELECT * FROM contracts WHERE id = ?").get(id) as Row | undefined;
    return row ? contractFromRow(row) : null;
  }

  async getContractByKey(key: string, status?: ContractStatus): Promise<Contract | null> {
    const row = status
      ? this.db.prepare("SELECT * FROM contracts WHERE key = ? AND status = ? ORDER BY version DESC LIMIT 1").get(key, status) as Row | undefined
      : this.db.prepare("SELECT * FROM contracts WHERE key = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(key) as Row | undefined;
    return row ? contractFromRow(row) : null;
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
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.key) {
      clauses.push("key = ?");
      params.push(filters.key);
    }
    if (filters?.kind) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters?.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters?.domainId) {
      clauses.push("domain_id = ?");
      params.push(filters.domainId);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.parentKey) {
      clauses.push("parent_key = ?");
      params.push(filters.parentKey);
    }
    if (filters?.governingContractKey) {
      clauses.push("governing_contract_key = ?");
      params.push(filters.governingContractKey);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM contracts ${where} ORDER BY key, version DESC`).all(...params) as Row[];
    return rows.map(contractFromRow);
  }

  async supersedeContract(
    id: ContractId,
    replacement: ContractSupersedeInput,
    reason: string
  ): Promise<{ old: Contract; replacement: Contract } | RepositoryError> {
    const current = await this.getContract(id);
    if (!current) return { code: "NOT_FOUND", message: `Contract ${id} not found` };
    if (current.status === "superseded" || current.status === "retired") {
      return { code: "INVALID_TRANSITION", message: `Cannot supersede contract in status ${current.status}` };
    }

    try {
      this.db.exec("BEGIN");
      this.db.prepare(
        "UPDATE contracts SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
      ).run(id);
      const result = this.db.prepare(
        `INSERT INTO contracts
         (key, kind, scope, domain_id, parent_key, title, body, status, version, custodian_actor_id,
          governing_contract_key, mandate_ref, content_hash, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        current.key,
        current.kind,
        current.scope,
        replacement.domainId ?? current.domainId ?? null,
        current.parentKey ?? null,
        replacement.title ?? current.title,
        replacement.body,
        replacement.status ?? "active",
        current.version + 1,
        replacement.custodianActorId,
        replacement.governingContractKey ?? current.governingContractKey ?? null,
        replacement.mandateRef ?? null,
        replacement.contentHash,
        id
      );
      const replacementId = contractId(Number(result.lastInsertRowid));
      this.db.prepare("UPDATE contracts SET superseded_by = ? WHERE id = ?").run(replacementId, id);
      this.db.exec("COMMIT");

      const old = await this.getContract(id);
      const replacementContract = await this.getContract(replacementId);
      if (!old || !replacementContract) return { code: "INVALID_STATE", message: "Contract supersession readback failed" };
      await this.emitEvent("contract_superseded", "contracts", id, replacement.custodianActorId, {
        scope: current.scope,
        reason,
        snapshot: contractEventSnapshot(old),
      });
      await this.emitEvent("contract_registered", "contracts", replacementId, replacement.custodianActorId, {
        scope: replacementContract.scope,
        snapshot: contractEventSnapshot(replacementContract),
      });
      return { old, replacement: replacementContract };
    } catch (error) {
      this.db.exec("ROLLBACK");
      return { code: "INVALID_STATE", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async registerActor(actor: ActorCreate): Promise<Actor> {
    const result = this.db.prepare(
      `INSERT INTO actors
       (name, role, provider, actor_type, capability_namespace, session_id, default_scope, status,
        contract_key, default_contract_key, contract_ref, context_ref, context_policy, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      actor.name,
      actor.role,
      actor.provider,
      actor.actorType ?? null,
      actor.capabilityNamespace,
      actor.sessionId ?? null,
      actor.defaultScope,
      actor.status ?? "active",
      actor.contractKey ?? null,
      actor.defaultContractKey ?? null,
      actor.contractRef ?? null,
      actor.contextRef ?? null,
      actor.contextPolicy ?? null,
      actor.description ?? null
    );
    const created = await this.getActor(actorId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted actor could not be read back");
    return created;
  }

  async updateActor(id: ActorId, updates: Partial<Omit<Actor, "id" | "createdAt">>): Promise<Actor | RepositoryError> {
    const current = await this.getActor(id);
    if (!current) return { code: "NOT_FOUND", message: `Actor ${id} not found` };
    this.db.prepare(
      `UPDATE actors
       SET name = ?, role = ?, provider = ?, actor_type = ?, capability_namespace = ?, session_id = ?, default_scope = ?,
           status = ?, contract_key = ?, default_contract_key = ?, contract_ref = ?, context_ref = ?, context_policy = ?, description = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      updates.name ?? current.name,
      updates.role ?? current.role,
      updates.provider ?? current.provider,
      "actorType" in updates ? updates.actorType ?? null : current.actorType ?? null,
      updates.capabilityNamespace ?? current.capabilityNamespace,
      "sessionId" in updates ? updates.sessionId ?? null : current.sessionId ?? null,
      updates.defaultScope ?? current.defaultScope,
      updates.status ?? current.status,
      "contractKey" in updates ? updates.contractKey ?? null : current.contractKey ?? null,
      "defaultContractKey" in updates ? updates.defaultContractKey ?? null : current.defaultContractKey ?? null,
      "contractRef" in updates ? updates.contractRef ?? null : current.contractRef ?? null,
      "contextRef" in updates ? updates.contextRef ?? null : current.contextRef ?? null,
      "contextPolicy" in updates ? updates.contextPolicy ?? null : current.contextPolicy ?? null,
      "description" in updates ? updates.description ?? null : current.description ?? null,
      id
    );
    const updated = await this.getActor(id);
    if (!updated) return { code: "NOT_FOUND", message: `Actor ${id} not found after update` };
    return updated;
  }

  async getActor(id: ActorId): Promise<Actor | null> {
    const row = this.db.prepare("SELECT * FROM actors WHERE id = ?").get(id) as Row | undefined;
    return row ? actorFromRow(row) : null;
  }

  async getActorByName(name: string): Promise<Actor | null> {
    const row = this.db.prepare("SELECT * FROM actors WHERE name = ?").get(name) as Row | undefined;
    return row ? actorFromRow(row) : null;
  }

  async listActors(filters?: { status?: ActorStatus; provider?: string }): Promise<Actor[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.provider) {
      clauses.push("provider = ?");
      params.push(filters.provider);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM actors ${where} ORDER BY id`).all(...params) as Row[];
    return rows.map(actorFromRow);
  }

  async registerRole(role: GovernanceRoleCreate): Promise<GovernanceRole> {
    const result = this.db.prepare(
      `INSERT INTO roles (name, status, contract_key, contract_ref, context_ref, policy_ref, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         status = excluded.status,
         contract_key = excluded.contract_key,
         contract_ref = excluded.contract_ref,
         context_ref = excluded.context_ref,
         policy_ref = excluded.policy_ref,
         description = excluded.description,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).run(
      role.name,
      role.status ?? "active",
      role.contractKey ?? null,
      role.contractRef ?? null,
      role.contextRef ?? null,
      role.policyRef ?? null,
      role.description ?? null
    );
    const created = await this.getRoleByName(role.name);
    if (!created) throw new Error("Inserted role could not be read back");
    return created;
  }

  async getRole(id: RoleId): Promise<GovernanceRole | null> {
    const row = this.db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as Row | undefined;
    return row ? roleFromRow(row) : null;
  }

  async getRoleByName(name: string): Promise<GovernanceRole | null> {
    const row = this.db.prepare("SELECT * FROM roles WHERE name = ?").get(name) as Row | undefined;
    return row ? roleFromRow(row) : null;
  }

  async listRoles(filters?: { status?: GovernanceRoleStatus }): Promise<GovernanceRole[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM roles ${where} ORDER BY id`).all(...params) as Row[];
    return rows.map(roleFromRow);
  }

  async bindActorRole(binding: ActorRoleBindingCreate): Promise<ActorRoleBinding> {
    this.db.prepare(
      `INSERT INTO actor_role_bindings (actor_id, role_id, surface, provider, credential_ref, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_id, role_id, surface, credential_ref) DO UPDATE SET
         provider = excluded.provider,
         status = excluded.status,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).run(
      binding.actorId,
      binding.roleId,
      binding.surface,
      binding.provider,
      binding.credentialRef ?? null,
      binding.status ?? "active"
    );
    const row = this.db.prepare(
      `SELECT * FROM actor_role_bindings
       WHERE actor_id = ? AND role_id = ? AND surface = ? AND credential_ref IS ?`
    ).get(binding.actorId, binding.roleId, binding.surface, binding.credentialRef ?? null) as Row | undefined;
    if (!row) throw new Error("Inserted actor-role binding could not be read back");
    return actorRoleBindingFromRow(row);
  }

  async listActorRoleBindings(filters?: {
    actorId?: ActorId;
    roleId?: RoleId;
    surface?: string;
    status?: ActorRoleBindingStatus;
  }): Promise<ActorRoleBinding[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.actorId) {
      clauses.push("actor_id = ?");
      params.push(filters.actorId);
    }
    if (filters?.roleId) {
      clauses.push("role_id = ?");
      params.push(filters.roleId);
    }
    if (filters?.surface) {
      clauses.push("surface = ?");
      params.push(filters.surface);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM actor_role_bindings ${where} ORDER BY id`).all(...params) as Row[];
    return rows.map(actorRoleBindingFromRow);
  }

  async openActorSession(session: ActorSessionCreate): Promise<ActorSession> {
    const result = this.db.prepare(
      `INSERT INTO actor_sessions
       (actor_id, session_ref, surface, provider, status, transcript_ref)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_id, session_ref) DO UPDATE SET
         status = 'active',
         surface = excluded.surface,
         provider = excluded.provider,
         transcript_ref = excluded.transcript_ref,
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         ended_at = NULL`
    ).run(
      session.actorId,
      session.sessionRef,
      session.surface,
      session.provider,
      session.status ?? "active",
      session.transcriptRef ?? null
    );
    const row = this.db.prepare(
      "SELECT * FROM actor_sessions WHERE actor_id = ? AND session_ref = ?"
    ).get(session.actorId, session.sessionRef) as Row | undefined;
    if (!row) throw new Error(`Actor session '${session.sessionRef}' could not be read back`);
    return actorSessionFromRow(row);
  }

  async heartbeatActorSession(sessionRef: string, actor: ActorId): Promise<ActorSession | RepositoryError> {
    const current = this.db.prepare(
      "SELECT * FROM actor_sessions WHERE actor_id = ? AND session_ref = ? AND status = 'active'"
    ).get(actor, sessionRef) as Row | undefined;
    if (!current) return { code: "NOT_FOUND", message: `Active session '${sessionRef}' not found for actor ${actor}` };
    this.db.prepare(
      "UPDATE actor_sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
    ).run(current.id as SqlParam);
    const updated = this.db.prepare("SELECT * FROM actor_sessions WHERE id = ?").get(current.id as SqlParam) as Row | undefined;
    if (!updated) return { code: "NOT_FOUND", message: `Session ${current.id} not found after heartbeat` };
    return actorSessionFromRow(updated);
  }

  async closeActorSession(sessionRef: string, actor: ActorId): Promise<ActorSession | RepositoryError> {
    const current = this.db.prepare(
      "SELECT * FROM actor_sessions WHERE actor_id = ? AND session_ref = ? AND status = 'active'"
    ).get(actor, sessionRef) as Row | undefined;
    if (!current) return { code: "NOT_FOUND", message: `Active session '${sessionRef}' not found for actor ${actor}` };
    this.db.prepare(
      `UPDATE actor_sessions
       SET status = 'closed',
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           ended_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(current.id as SqlParam);
    const updated = this.db.prepare("SELECT * FROM actor_sessions WHERE id = ?").get(current.id as SqlParam) as Row | undefined;
    if (!updated) return { code: "NOT_FOUND", message: `Session ${current.id} not found after close` };
    return actorSessionFromRow(updated);
  }

  async listActorSessions(filters?: { actorId?: ActorId; status?: ActorSessionStatus }): Promise<ActorSession[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.actorId) {
      clauses.push("actor_id = ?");
      params.push(filters.actorId);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM actor_sessions ${where} ORDER BY last_seen_at DESC`).all(...params) as Row[];
    return rows.map(actorSessionFromRow);
  }

  async registerScope(scope: string): Promise<string> {
    this.db.prepare("INSERT OR IGNORE INTO scopes (name, description) VALUES (?, ?)").run(scope, scope);
    return scope;
  }

  async listScopes(): Promise<string[]> {
    const rows = this.db.prepare("SELECT name FROM scopes ORDER BY name").all() as Row[];
    return rows.map((row) => String(row.name));
  }

  async registerExpertiseSignal(
    signal: Omit<ExpertiseSignalRecord, "id" | "createdAt">
  ): Promise<ExpertiseSignalRecord> {
    const result = this.db.prepare(
      "INSERT INTO expertise_signals (intent_id, domain_id, actor_id, signal, note) VALUES (?, ?, ?, ?, ?)"
    ).run(signal.intentId, signal.domainId, signal.actorId, signal.signal, signal.note ?? null);
    const row = this.db.prepare("SELECT * FROM expertise_signals WHERE id = ?").get(result.lastInsertRowid) as Row | undefined;
    if (!row) throw new Error("Inserted expertise signal could not be read back");
    const created = expertiseFromRow(row);
    await this.emitEvent("expertise_signal_registered", "expertise_signals", created.id, created.actorId);
    return created;
  }

  async listExpertiseSignals(intentId: IntentId): Promise<ExpertiseSignalRecord[]> {
    const rows = this.db.prepare("SELECT * FROM expertise_signals WHERE intent_id = ? ORDER BY created_at DESC")
      .all(intentId) as Row[];
    return rows.map(expertiseFromRow);
  }

  async registerReport(report: ReportCreate): Promise<Report> {
    const result = this.db.prepare(
      `INSERT INTO reports
       (scope, kind, title, summary, body_ref, actor_id, assumed_role, invoked_skill_ref, policy_ref, domain_id, intent_id, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      report.scope,
      report.kind,
      report.title,
      report.summary,
      report.bodyRef ?? null,
      report.actorId,
      report.assumedRole ?? null,
      report.invokedSkillRef ?? null,
      report.policyRef ?? null,
      report.domainId ?? null,
      report.intentId ?? null,
      report.sourceRef ?? null
    );
    const created = await this.getReport(reportId(Number(result.lastInsertRowid)));
    if (!created) throw new Error("Inserted report could not be read back");
    await this.emitEvent("report_created", "reports", created.id, created.actorId, {
      scope: created.scope,
      snapshot: created as unknown as Record<string, unknown>,
    });
    return created;
  }

  async getReport(id: ReportId): Promise<Report | null> {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
    return row ? reportFromRow(row) : null;
  }

  async listReports(filters?: {
    scope?: string;
    kind?: string;
    intentId?: IntentId;
    domainId?: DomainId;
    actorId?: ActorId;
  }): Promise<Report[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters?.kind) {
      clauses.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters?.intentId) {
      clauses.push("intent_id = ?");
      params.push(filters.intentId);
    }
    if (filters?.domainId) {
      clauses.push("domain_id = ?");
      params.push(filters.domainId);
    }
    if (filters?.actorId) {
      clauses.push("actor_id = ?");
      params.push(filters.actorId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC`).all(...params) as Row[];
    return rows.map(reportFromRow);
  }

  async emitEvent(
    eventType: EventType,
    entityTable: string,
    entityId: number,
    eventActorId: ActorId,
    context?: { scope?: string; reason?: string; snapshot?: Record<string, unknown> }
  ): Promise<Event> {
    const result = this.db.prepare(
      `INSERT INTO events (scope, event_type, entity_table, entity_id, actor_id, reason, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      context?.scope ?? "default",
      eventType,
      entityTable,
      entityId,
      eventActorId,
      context?.reason ?? null,
      context?.snapshot ? JSON.stringify(context.snapshot) : null
    );
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid) as Row | undefined;
    if (!row) throw new Error("Inserted event could not be read back");
    return eventFromRow(row);
  }

  async listEvents(filters?: { scope?: string; entityTable?: string }): Promise<Event[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filters?.scope) {
      clauses.push("scope = ?");
      params.push(filters.scope);
    }
    if (filters?.entityTable) {
      clauses.push("entity_table = ?");
      params.push(filters.entityTable);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC`).all(...params) as Row[];
    return rows.map(eventFromRow);
  }
}
