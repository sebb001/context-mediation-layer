/**
 * Governance Domain Model
 *
 * Core CML primitives. Governance-owned types, never mixed with runtime/knowledge
 * or Local ontology. These types form the canonical coordination vocabulary.
 */

export type IntentId = number & { readonly __brand: "IntentId" };
export type InterpretationId = number & { readonly __brand: "InterpretationId" };
export type ActionId = number & { readonly __brand: "ActionId" };
export type ClaimId = number & { readonly __brand: "ClaimId" };
export type DomainId = number & { readonly __brand: "DomainId" };
export type ActorId = number & { readonly __brand: "ActorId" };
export type RoleId = number & { readonly __brand: "RoleId" };
export type ActorRoleBindingId = number & { readonly __brand: "ActorRoleBindingId" };
export type ActorSessionId = number & { readonly __brand: "ActorSessionId" };
export type EventId = number & { readonly __brand: "EventId" };
export type ExpertiseSignalId = number & { readonly __brand: "ExpertiseSignalId" };
export type ReportId = number & { readonly __brand: "ReportId" };
export type ContractId = number & { readonly __brand: "ContractId" };

export function intendId(n: number): IntentId {
  return n as IntentId;
}
export function interpretationId(n: number): InterpretationId {
  return n as InterpretationId;
}
export function actionId(n: number): ActionId {
  return n as ActionId;
}
export function claimId(n: number): ClaimId {
  return n as ClaimId;
}
export function domainId(n: number): DomainId {
  return n as DomainId;
}
export function actorId(n: number): ActorId {
  return n as ActorId;
}
export function roleId(n: number): RoleId {
  return n as RoleId;
}
export function actorRoleBindingId(n: number): ActorRoleBindingId {
  return n as ActorRoleBindingId;
}
export function actorSessionId(n: number): ActorSessionId {
  return n as ActorSessionId;
}
export function eventId(n: number): EventId {
  return n as EventId;
}
export function expertiseSignalId(n: number): ExpertiseSignalId {
  return n as ExpertiseSignalId;
}
export function reportId(n: number): ReportId {
  return n as ReportId;
}
export function contractId(n: number): ContractId {
  return n as ContractId;
}

// ============================================================
// Actors and Domains
// ============================================================

export type ActorRole = "human" | "agent";
export type ActorProvider = "human" | "claude-code" | "openai-codex" | "claude-cowork" | string;
export type ActorStatus = "active" | "suspended" | "retired";
export type GovernanceRoleStatus = "active" | "suspended" | "retired";
export type ActorRoleBindingStatus = "active" | "suspended" | "retired";
export type ActorSessionStatus = "active" | "closed";

export interface Actor {
  id: ActorId;
  name: string; // unique
  role: ActorRole;
  provider: ActorProvider;
  actorType?: string; // optional reusable actor type, e.g. build-agent or project-advisor
  capabilityNamespace: string; // provisioned contract surface
  defaultScope: string;
  status: ActorStatus;
  contractKey?: string; // canonical contract registry key defining the actor contract
  defaultContractKey?: string; // baseline contract used when an action has no more specific governing contract
  contractRef?: string; // legacy locator only; not authoritative contract matter
  contextRef?: string; // local doc/path/URL defining the actor's provisioned context pack
  contextPolicy?: string; // compact rationing rules for what context this actor should receive
  description?: string;
  sessionId?: string; // legacy metadata; accountable sessions live in actor_sessions
  createdAt: Date;
  updatedAt: Date;
}

export interface GovernanceRole {
  id: RoleId;
  name: string;
  status: GovernanceRoleStatus;
  contractKey?: string; // canonical contract registry key defining the role contract
  contractRef?: string; // legacy locator only; not authoritative contract matter
  contextRef?: string;
  policyRef?: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActorRoleBinding {
  id: ActorRoleBindingId;
  actorId: ActorId;
  roleId: RoleId;
  surface: string;
  provider: ActorProvider;
  credentialRef?: string;
  status: ActorRoleBindingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActorSession {
  id: ActorSessionId;
  actorId: ActorId;
  sessionRef: string;
  surface: string;
  provider: ActorProvider;
  status: ActorSessionStatus;
  transcriptRef?: string;
  startedAt: Date;
  lastSeenAt: Date;
  endedAt?: Date;
}

export interface Domain {
  id: DomainId;
  scope: string;
  name: string; // unique within scope
  concern: string; // what this domain is responsible for
  notionPageId?: string; // optional reference to Notion documentation
}

// ============================================================
// Contracts
// ============================================================

export type ContractKind = "root" | "system" | "role" | "actor" | "actor_type" | "skill" | "policy" | "process";
export type ContractStatus = "draft" | "active" | "superseded" | "retired";

export interface Contract {
  id: ContractId;
  key: string; // stable hierarchy key, e.g. root:agent-bootstrap or skill:reagent-reading-composer
  kind: ContractKind;
  scope: string;
  domainId?: DomainId; // optional domain owner/concern; not an access fence
  parentKey?: string; // optional active parent contract key in the contract hierarchy
  title: string;
  body: string; // canonical contract matter; there are no writable projection contracts
  status: ContractStatus;
  version: number;
  custodianActorId: ActorId;
  governingContractKey?: string; // optional contract authorizing this revision; advisory, not an ACL
  mandateRef?: string; // optional CML/INT/RPT or build mandate that authorized this revision
  contentHash: string;
  supersedes?: ContractId;
  supersededBy?: ContractId;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// Intents
// ============================================================

export type IntentStatus = "draft" | "active" | "closed" | "superseded";

export interface Intent {
  id: IntentId;
  scope: string;
  description: string; // the goal/directive
  status: IntentStatus;
  version: number; // incremented on each update
  source: string; // who seeded it (channel/person)
  addressedTo?: ActorId; // optional routing to a specific actor
  parentId?: IntentId; // null = top-level directive, set = delegation sub-intent
  createdAt: Date;
  updatedAt: Date;
  resolutionNotes?: string; // why it was closed/superseded
}

/** Enriched read: getIntent returns linked counts and signals */
export interface IntentEnriched extends Intent {
  interpretationCount: number;
  expertiseSignals: ExpertiseSignalRecord[];
  activeClaims: Claim[];
}

// ============================================================
// Interpretations
// ============================================================

export type InterpretationStatus = "fyi" | "clarifying" | "proposed" | "flagged" | "superseded";
export type InterpretationAlignment = "aligned" | "uncertain" | "divergent" | "superseded";

export interface Interpretation {
  id: InterpretationId;
  intentId: IntentId;
  domainId: DomainId;
  actorId: ActorId;
  title: string; // what the domain understood the intent to mean
  scopeAssumption?: string; // what was assumed in/out of scope
  alignment: InterpretationAlignment;
  status: InterpretationStatus;
  resolverId?: ActorId; // actor responsible for resolving
  resolveBy?: Date; // deadline if one is set
  supersededBy?: InterpretationId; // link to replacement if superseded
  sourceRef?: string; // thread/session that emitted this
  createdAt: Date;
  updatedAt: Date;
}

/** Enriched read: getInterpretation returns linked intent and actions */
export interface InterpretationEnriched extends Interpretation {
  intent: Intent;
  actions: Action[];
}

// ============================================================
// Actions
// ============================================================

export interface Action {
  id: ActionId;
  intentId: IntentId;
  interpretationId?: InterpretationId; // which interpretation triggered this
  actorId: ActorId;
  domainId?: DomainId; // optional authority/context signpost, not an access fence
  governingContractKey?: string; // optional active contract key this action claims to act under
  assumedRole?: string;
  invokedSkillRef?: string;
  policyRef?: string;
  description: string; // what was done
  outcome?: string; // result or verification
  createdAt: Date;
}

// ============================================================
// Claims
// ============================================================

export type ClaimStatus = "active" | "released";

export interface Claim {
  id: ClaimId;
  entityTable: string; // "intents", "interpretations", etc.
  entityId: number; // which entity is claimed
  actorId: ActorId;
  status: ClaimStatus;
  note?: string; // why the claim was made
  createdAt: Date;
  releasedAt?: Date;
}

// ============================================================
// Expertise Signals
// ============================================================

export type ExpertiseSignal = "concerned" | "not_concerned" | "blocked";

export interface ExpertiseSignalRecord {
  id: ExpertiseSignalId;
  intentId: IntentId;
  domainId: DomainId;
  actorId: ActorId;
  signal: ExpertiseSignal;
  note?: string; // brief context
  createdAt: Date;
}

// ============================================================
// Reports
// ============================================================

export interface Report {
  id: ReportId;
  scope: string;
  kind: string;
  title: string;
  summary: string;
  bodyRef?: string;
  actorId: ActorId;
  assumedRole?: string;
  invokedSkillRef?: string;
  policyRef?: string;
  domainId?: DomainId;
  intentId?: IntentId;
  sourceRef?: string;
  createdAt: Date;
}

// ============================================================
// Events (Append-only Decision Trail)
// ============================================================

/**
 * Event types are open strings — the governance schema does not constrain them.
 * Common values observed in coordination operations listed here for reference only.
 */
export type EventType = string;

export interface Event {
  id: EventId;
  scope: string;
  eventType: EventType;
  entityTable: string; // "intents", "interpretations", etc.
  entityId: number; // which entity this event concerns
  actorId: ActorId; // who triggered the event
  reason?: string; // why it happened
  snapshot?: Record<string, unknown>; // optional state snapshot
  createdAt: Date;
}

// ============================================================
// Claim Lifecycle
// ============================================================

/** Claims can only transition from active to released. This is in the governance schema. */
export function isValidClaimTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  return from === "active" && to === "released";
}
