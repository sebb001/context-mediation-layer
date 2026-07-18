/**
 * Governance Inspection — CLI-facing read compositions.
 *
 * Thin composition functions over GovernanceService reads that build
 * operator-legible views of governance state. Used before execution
 * (deciding whether to act) and for general browsing.
 *
 * Same pattern as execute-and-inspect: composes existing services,
 * returns plain-number output suitable for CLI JSON rendering.
 * Not a new service.
 */

import { GovernanceService, ServiceResponse, ServiceResult } from "../governance/service.js";
import {
  Intent,
  IntentId,
  IntentEnriched,
  Interpretation,
  InterpretationEnriched,
  Action,
  Event,
  Claim,
  ExpertiseSignalRecord,
} from "../governance/domain.js";

// ============================================================
// Intent inspection
// ============================================================

/** Full operator view of an intent and everything attached to it. */
export interface IntentInspection {
  intent: {
    id: number;
    scope: string;
    description: string;
    status: string;
    version: number;
    source: string;
    addressedTo?: number;
    parentId?: number;
    createdAt: string;
    updatedAt: string;
    resolutionNotes?: string;
  };
  interpretations: Array<{
    id: number;
    title: string;
    status: string;
    alignment: string;
    actorId: number;
    domainId: number;
    createdAt: string;
  }>;
  actions: Array<{
    id: number;
    description: string;
    outcome?: string;
    actorId: number;
    interpretationId?: number;
    createdAt: string;
  }>;
  reports: Array<{
    id: number;
    kind: string;
    title: string;
    summary: string;
    actorId: number;
    assumedRole?: string;
    sourceRef?: string;
    createdAt: string;
  }>;
  claims: Array<{
    id: number;
    actorId: number;
    status: string;
    note?: string;
  }>;
  expertiseSignals: Array<{
    domainId: number;
    actorId: number;
    signal: string;
    note?: string;
  }>;
  recentEvents: Array<{
    id: number;
    type: string;
    reason?: string;
    createdAt: string;
  }>;
  summary: {
    interpretationCount: number;
    activeClaimCount: number;
    actionCount: number;
    reportCount: number;
    domainsCovered: number;
  };
}

/**
 * Build a complete inspection of an intent for operator use.
 * Composes multiple GovernanceService reads into one report.
 */
export async function inspectIntent(
  intentId: number,
  service: GovernanceService
): Promise<{ ok: true; data: IntentInspection } | { ok: false; error: string }> {
  // Enriched intent (includes interpretationCount, expertiseSignals, activeClaims)
  const intentRes = await service.getIntent(intentId);
  if (!intentRes.ok) return { ok: false, error: intentRes.error.message };
  const enriched = intentRes.data;

  // Interpretations for this intent
  const interpRes = await service.listInterpretations({ intentId, limit: 100 });
  const interpretations = interpRes.ok ? interpRes.data : [];

  // Actions for this intent
  const actionsRes = await service.listActions({ intentId, limit: 100 });
  const actions = actionsRes.ok ? actionsRes.data : [];

  // Reports for this intent
  const reportsRes = await service.listReports({ intentId, limit: 100 });
  const reports = reportsRes.ok ? reportsRes.data : [];

  // Event history
  const eventsRes = await service.getEntityHistory({
    entityTable: "intents",
    entityId: intentId,
    limit: 30,
  });
  const events = eventsRes.ok ? eventsRes.data : [];

  return {
    ok: true,
    data: {
      intent: {
        id: enriched.id as number,
        scope: enriched.scope,
        description: enriched.description,
        status: enriched.status,
        version: enriched.version,
        source: enriched.source,
        addressedTo: enriched.addressedTo as number | undefined,
        parentId: enriched.parentId as number | undefined,
        createdAt: enriched.createdAt.toISOString(),
        updatedAt: enriched.updatedAt.toISOString(),
        resolutionNotes: enriched.resolutionNotes,
      },
      interpretations: interpretations.map((i) => ({
        id: i.id as number,
        title: i.title,
        status: i.status,
        alignment: i.alignment,
        actorId: i.actorId as number,
        domainId: i.domainId as number,
        createdAt: i.createdAt.toISOString(),
      })),
      actions: actions.map((a) => ({
        id: a.id as number,
        description: a.description,
        outcome: a.outcome,
        actorId: a.actorId as number,
        interpretationId: a.interpretationId as number | undefined,
        createdAt: a.createdAt.toISOString(),
      })),
      reports: reports.map((r) => ({
        id: r.id as number,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        actorId: r.actorId as number,
        assumedRole: r.assumedRole,
        sourceRef: r.sourceRef,
        createdAt: r.createdAt.toISOString(),
      })),
      claims: enriched.activeClaims.map((c) => ({
        id: c.id as number,
        actorId: c.actorId as number,
        status: c.status,
        note: c.note,
      })),
      expertiseSignals: enriched.expertiseSignals.map((s) => ({
        domainId: s.domainId as number,
        actorId: s.actorId as number,
        signal: s.signal,
        note: s.note,
      })),
      recentEvents: events.map((e) => ({
        id: e.id as number,
        type: e.eventType,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
      summary: {
        interpretationCount: enriched.interpretationCount,
        activeClaimCount: enriched.activeClaims.length,
        actionCount: actions.length,
        reportCount: reports.length,
        domainsCovered: new Set(enriched.expertiseSignals.map((s) => s.domainId)).size,
      },
    },
  };
}

// ============================================================
// Interpretation inspection
// ============================================================

/** Full operator view of an interpretation in its governance context. */
export interface InterpretationInspection {
  interpretation: {
    id: number;
    title: string;
    status: string;
    alignment: string;
    actorId: number;
    domainId: number;
    scopeAssumption?: string;
    sourceRef?: string;
    supersededBy?: number;
    createdAt: string;
    updatedAt: string;
  };
  intent: {
    id: number;
    description: string;
    status: string;
  };
  actions: Array<{
    id: number;
    description: string;
    outcome?: string;
    actorId: number;
    createdAt: string;
  }>;
  recentEvents: Array<{
    id: number;
    type: string;
    reason?: string;
    createdAt: string;
  }>;
  summary: {
    actionCount: number;
    isSuperseded: boolean;
    isActionable: boolean;
  };
}

/**
 * Build a complete inspection of an interpretation for operator use.
 */
export async function inspectInterpretation(
  interpretationId: number,
  service: GovernanceService
): Promise<{ ok: true; data: InterpretationInspection } | { ok: false; error: string }> {
  const interpRes = await service.getInterpretation(interpretationId);
  if (!interpRes.ok) return { ok: false, error: interpRes.error.message };
  const enriched = interpRes.data;

  // Event history for this interpretation
  const eventsRes = await service.getEntityHistory({
    entityTable: "interpretations",
    entityId: interpretationId,
    limit: 20,
  });
  const events = eventsRes.ok ? eventsRes.data : [];

  return {
    ok: true,
    data: {
      interpretation: {
        id: enriched.id as number,
        title: enriched.title,
        status: enriched.status,
        alignment: enriched.alignment,
        actorId: enriched.actorId as number,
        domainId: enriched.domainId as number,
        scopeAssumption: enriched.scopeAssumption,
        sourceRef: enriched.sourceRef,
        supersededBy: enriched.supersededBy as number | undefined,
        createdAt: enriched.createdAt.toISOString(),
        updatedAt: enriched.updatedAt.toISOString(),
      },
      intent: {
        id: enriched.intent.id as number,
        description: enriched.intent.description,
        status: enriched.intent.status,
      },
      actions: enriched.actions.map((a) => ({
        id: a.id as number,
        description: a.description,
        outcome: a.outcome,
        actorId: a.actorId as number,
        createdAt: a.createdAt.toISOString(),
      })),
      recentEvents: events.map((e) => ({
        id: e.id as number,
        type: e.eventType,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
      })),
      summary: {
        actionCount: enriched.actions.length,
        isSuperseded: enriched.status === "superseded",
        isActionable: enriched.status !== "superseded" && enriched.status !== "fyi",
      },
    },
  };
}

// ============================================================
// Sub-intent tree inspection
// ============================================================

/** A node in the sub-intent delegation tree. */
export interface IntentTreeNode {
  id: number;
  description: string;
  status: string;
  addressedTo?: number;
  interpretationCount: number;
  actionCount: number;
  children: IntentTreeNode[];
}

/** Complete sub-intent tree rooted at a given intent. */
export interface IntentTree {
  root: IntentTreeNode;
  /** Total number of intents in the tree (root + all descendants). */
  totalIntents: number;
  /** Counts by status across the whole tree. */
  statusCounts: Record<string, number>;
}

/**
 * Build the full sub-intent delegation tree for an intent.
 *
 * Walks parentId relationships to assemble the tree. If the given intent
 * has a parentId, the tree is still rooted at the given intent (not the
 * ultimate ancestor). Use this to inspect delegation from any point.
 */
export async function inspectIntentTree(
  rootIntentId: number,
  service: GovernanceService
): Promise<{ ok: true; data: IntentTree } | { ok: false; error: string }> {
  const rootRes = await service.getIntent(rootIntentId);
  if (!rootRes.ok) return { ok: false, error: rootRes.error.message };

  // Fetch all intents in the same scope — the in-memory store is small enough
  // that filtering client-side is fine. A real DB would use a recursive CTE.
  const allRes = await service.listIntents({
    scope: rootRes.data.scope,
    limit: 100,
  });
  const allIntents = allRes.ok ? allRes.data : [];

  // Also fetch actions per intent for counts
  const allActionsRes = await service.listActions({ limit: 100 });
  const allActions = allActionsRes.ok ? allActionsRes.data : [];

  // Build a lookup of children by parentId
  const childrenOf = new Map<number, Intent[]>();
  for (const intent of allIntents) {
    if (intent.parentId != null) {
      const parentNum = intent.parentId as number;
      const siblings = childrenOf.get(parentNum) ?? [];
      siblings.push(intent);
      childrenOf.set(parentNum, siblings);
    }
  }

  // Action count lookup by intentId
  const actionCountOf = new Map<number, number>();
  for (const action of allActions) {
    const iid = action.intentId as number;
    actionCountOf.set(iid, (actionCountOf.get(iid) ?? 0) + 1);
  }

  // Interpretation count: we need enriched reads for each node.
  // For now, use the enriched root and count from allIntents for children.
  const interpCountOf = new Map<number, number>();
  // Root has enriched data
  interpCountOf.set(rootIntentId, rootRes.data.interpretationCount);
  // For children, count interpretations by listing per intent
  for (const intent of allIntents) {
    const iid = intent.id as number;
    if (iid !== rootIntentId) {
      const interpRes = await service.listInterpretations({ intentId: iid, limit: 1 });
      if (interpRes.ok) {
        // We asked for limit 1 — use meta.count if available, else use data length
        // Actually listInterpretations returns the full filtered set then paginates,
        // so meta.count reflects the page size. We need the full count.
        const fullRes = await service.listInterpretations({ intentId: iid, limit: 100 });
        interpCountOf.set(iid, fullRes.ok ? fullRes.data.length : 0);
      }
    }
  }

  // Recursive tree builder
  function buildNode(intent: Intent): IntentTreeNode {
    const id = intent.id as number;
    const children = (childrenOf.get(id) ?? []).map(buildNode);
    return {
      id,
      description: intent.description,
      status: intent.status,
      addressedTo: intent.addressedTo as number | undefined,
      interpretationCount: interpCountOf.get(id) ?? 0,
      actionCount: actionCountOf.get(id) ?? 0,
      children,
    };
  }

  const root = buildNode(rootRes.data);

  // Collect stats
  const statusCounts: Record<string, number> = {};
  let totalIntents = 0;
  function walk(node: IntentTreeNode) {
    totalIntents++;
    statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1;
    for (const child of node.children) walk(child);
  }
  walk(root);

  return {
    ok: true,
    data: { root, totalIntents, statusCounts },
  };
}
