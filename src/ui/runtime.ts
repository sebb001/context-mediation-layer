import { createHash } from "node:crypto";
import type { Action, Actor, Claim, Domain, Event, ExpertiseSignalRecord, Intent, Interpretation, Report } from "../governance/domain.js";
import type { GovernanceRepository } from "../governance/repository.js";
import { GovernanceService } from "../governance/service.js";

export type OperatorRuntimeMode = "remote-http" | "mcp-sandbox";

export interface OperatorSurfaceContext {
  repo: GovernanceRepository;
  service: GovernanceService;
  defaultActor?: string;
  defaultActorId?: number;
  publicMcpBaseUrl?: string;
  uiPublicUrls?: string[];
}

export interface AttentionItem {
  id: string;
  entityType: "intent" | "interpretation" | "claim" | "event";
  entityId: number;
  intentId?: number;
  tone: "red" | "amber" | "green" | "blue";
  label: string;
  title: string;
  createdAt?: Date | string;
}

export interface DivergenceGroup {
  id: string;
  intentId: number;
  interpretationIds: number[];
  count: number;
  title: string;
  updatedAt?: Date | string;
}

export interface SupersessionChain {
  currentId: number;
  predecessorIds: number[];
  depth: number;
}

export interface OperatorSummary {
  activeIntentCount: number;
  draftIntentCount: number;
  closedIntentCount: number;
  supersededIntentCount: number;
  interpretationCount: number;
  divergentInterpretationCount: number;
  divergenceGroupCount: number;
  reportCount: number;
  actionCount: number;
  activeClaimCount: number;
  eventCount: number;
  actorCount: number;
  domainCount: number;
}

export interface OperatorSurfaceState {
  schemaVersion: 1;
  generatedAt: string;
  actor?: Actor;
  intents: Intent[];
  interpretations: Interpretation[];
  actions: Action[];
  reports: Report[];
  claims: Claim[];
  events: Event[];
  actors: Actor[];
  domains: Domain[];
  expertiseSignals: ExpertiseSignalRecord[];
  attention: AttentionItem[];
  divergenceGroups: DivergenceGroup[];
  supersessionChains: SupersessionChain[];
  summary: OperatorSummary;
}

export interface OperatorRuntime {
  mediaType: "text/html";
  html: string;
  sha256: string;
  version: string;
}

export interface OperatorUiManifest {
  name: string;
  version: string;
  sha256: string;
  mediaType: "text/html";
  sizeBytes: number;
  availableUiUrls: string[];
  publicMcpUrl?: string;
  runtimeModes: OperatorRuntimeMode[];
  exposedCapabilities: string[];
  requiredMcpTools: string[];
  actionDescriptors: Record<string, McpActionDescriptor>;
}

export interface McpActionDescriptor {
  tool: string;
  title: string;
  description: string;
  entityTypes?: string[];
  required?: string[];
}

export const OPERATOR_RUNTIME_NAME = "cml-operator-sidebar";
export const OPERATOR_RUNTIME_VERSION = "1.0.0";
export const OPERATOR_RUNTIME_MEDIA_TYPE = "text/html" as const;
export const DEFAULT_PUBLIC_MCP_BASE_URL = "https://mcp.example";
export const MEDIATION_CENTRE_RUNTIME_NAME = "cml-mediation-centre";
export const MEDIATION_CENTRE_RUNTIME_VERSION = "0.1.0";
export const HUMAN_SURFACE_RUNTIME_NAME = MEDIATION_CENTRE_RUNTIME_NAME;
export const HUMAN_SURFACE_RUNTIME_VERSION = MEDIATION_CENTRE_RUNTIME_VERSION;

export const OPERATOR_REQUIRED_MCP_TOOLS = [
  "ui_manifest",
  "ui_runtime_get",
  "operator_state_get",
  "intent_create",
  "intent_update",
  "interpretation_create",
  "interpretation_update",
  "interpretation_supersede",
  "action_log",
  "claim_create",
  "claim_release",
  "expertise_register",
  "event_list",
] as const;

export const MCP_ACTION_DESCRIPTORS: Record<string, McpActionDescriptor> = {
  focus_emit: {
    tool: "operator_state_get",
    title: "Emit focus",
    description: "Remote HTTP persists focus through /api/focus; MCP sandbox stages a focus payload beside the current state.",
    entityTypes: ["intent", "interpretation", "divergence_group"],
  },
  intent_create: {
    tool: "intent_create",
    title: "Create intent",
    description: "Register a canonical intent. Divergence resolve uses this descriptor, not a fake resolve primitive.",
    required: ["description"],
  },
  intent_update: {
    tool: "intent_update",
    title: "Update intent",
    description: "Update status, description, resolution notes, or addressed actor for an existing intent.",
    entityTypes: ["intent"],
    required: ["id", "reason"],
  },
  interpretation_create: {
    tool: "interpretation_create",
    title: "Create interpretation",
    description: "Register a canonical interpretation on an intent.",
    entityTypes: ["intent"],
    required: ["intentId", "domainId", "title"],
  },
  interpretation_update: {
    tool: "interpretation_update",
    title: "Update interpretation",
    description: "Update status, alignment, resolver, deadline, or scope assumption for an interpretation.",
    entityTypes: ["interpretation"],
    required: ["id", "reason"],
  },
  interpretation_supersede: {
    tool: "interpretation_supersede",
    title: "Supersede interpretation",
    description: "Create a replacement interpretation and mark the prior interpretation superseded.",
    entityTypes: ["interpretation"],
    required: ["id", "newTitle", "reason"],
  },
  action_log: {
    tool: "action_log",
    title: "Log action",
    description: "Log a governed action against an intent, optionally linked to an interpretation.",
    required: ["intentId", "description"],
  },
  claim_create: {
    tool: "claim_create",
    title: "Create claim",
    description: "Acquire an advisory claim on an entity.",
    required: ["entityId"],
  },
  claim_release: {
    tool: "claim_release",
    title: "Release claim",
    description: "Release an advisory claim.",
    required: ["id"],
  },
  expertise_register: {
    tool: "expertise_register",
    title: "Register expertise",
    description: "Register an expertise signal for an actor/domain on an intent.",
    required: ["intentId", "domainId", "signal"],
  },
};

export async function buildOperatorSurfaceState(context: OperatorSurfaceContext): Promise<OperatorSurfaceState> {
  const [
    actor,
    activeIntents,
    draftIntents,
    closedIntents,
    supersededIntents,
    interpretations,
    reports,
    actions,
    claims,
    events,
    actors,
    domains,
  ] = await Promise.all([
    resolveDefaultActor(context),
    context.service.listIntents({ status: "active", limit: 100 }),
    context.service.listIntents({ status: "draft", limit: 100 }),
    context.service.listIntents({ status: "closed", limit: 100 }),
    context.service.listIntents({ status: "superseded", limit: 100 }),
    context.service.listInterpretations({ limit: 100 }),
    context.service.listReports({ limit: 100 }),
    context.service.listActions({ limit: 100 }),
    context.service.listClaims({ status: "active", limit: 100 }),
    context.service.listEvents({ limit: 100 }),
    context.service.listActors({ status: "active" }),
    context.service.listDomains(),
  ]);

  const intentData = uniqueById([
    ...(activeIntents.ok ? activeIntents.data : []),
    ...(draftIntents.ok ? draftIntents.data : []),
    ...(closedIntents.ok ? closedIntents.data : []),
    ...(supersededIntents.ok ? supersededIntents.data : []),
  ]);
  const interpretationData = interpretations.ok ? interpretations.data : [];
  const actionData = actions.ok ? actions.data : [];
  const reportData = reports.ok ? reports.data : [];
  const claimData = claims.ok ? claims.data : [];
  const eventData = events.ok ? events.data : [];
  const actorData = actors.ok ? actors.data : [];
  const domainData = domains.ok ? domains.data : [];
  const expertiseSignals = await collectExpertiseSignals(context.service, intentData);
  const divergenceGroups = buildDivergenceGroups(intentData, interpretationData);
  const supersessionChains = buildSupersessionChains(interpretationData);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    actor,
    intents: intentData,
    interpretations: interpretationData,
    actions: actionData,
    reports: reportData,
    claims: claimData,
    events: eventData,
    actors: actorData,
    domains: domainData,
    expertiseSignals,
    attention: buildAttention(intentData, interpretationData, claimData, eventData),
    divergenceGroups,
    supersessionChains,
    summary: {
      activeIntentCount: activeIntents.ok ? activeIntents.data.length : 0,
      draftIntentCount: draftIntents.ok ? draftIntents.data.length : 0,
      closedIntentCount: closedIntents.ok ? closedIntents.data.length : 0,
      supersededIntentCount: supersededIntents.ok ? supersededIntents.data.length : 0,
      interpretationCount: interpretationData.length,
      divergentInterpretationCount: interpretationData.filter((item) => item.alignment === "divergent").length,
      divergenceGroupCount: divergenceGroups.length,
      reportCount: reportData.length,
      actionCount: actionData.length,
      activeClaimCount: claimData.length,
      eventCount: eventData.length,
      actorCount: actorData.length,
      domainCount: domainData.length,
    },
  };
}

export function renderOperatorRuntime(
  state: OperatorSurfaceState | undefined,
  options: {
    mode?: OperatorRuntimeMode;
    includeState?: boolean;
    publicMcpBaseUrl?: string;
    uiPublicUrls?: string[];
  } = {}
): OperatorRuntime {
  const mode = options.mode ?? "remote-http";
  const includeState = options.includeState ?? true;
  const publicMcpBaseUrl = sanitizePublicUrl(options.publicMcpBaseUrl ?? DEFAULT_PUBLIC_MCP_BASE_URL);
  const uiPublicUrls = sanitizePublicUrls(options.uiPublicUrls ?? []);
  const bootstrap = {
    name: OPERATOR_RUNTIME_NAME,
    version: OPERATOR_RUNTIME_VERSION,
    mode,
    state: includeState ? state ?? null : null,
    publicMcpBaseUrl,
    uiPublicUrls,
    actionDescriptors: MCP_ACTION_DESCRIPTORS,
    requiredMcpTools: OPERATOR_REQUIRED_MCP_TOOLS,
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CML Operator Surface Sidebar</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #131416;
      --panel: #1d2024;
      --panel-2: #252a30;
      --panel-3: #181b1f;
      --line: #39414a;
      --line-soft: #2d333a;
      --text: #f2f0ea;
      --muted: #abb1b8;
      --faint: #747d86;
      --focus: #d2a45f;
      --focus-soft: rgba(210, 164, 95, 0.18);
      --green: #79b884;
      --red: #d66f67;
      --blue: #7da2d6;
      --violet: #b49ad7;
      --shadow: rgba(0, 0, 0, 0.36);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body {
      width: min(380px, 100vw);
      min-height: 100vh;
      overflow: hidden;
      font-family: Inter, "Avenir Next", "Segoe UI", system-ui, sans-serif;
      letter-spacing: 0;
    }
    button, input, select, textarea { font: inherit; letter-spacing: 0; }
    button {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      padding: 6px 8px;
      cursor: pointer;
      font-size: 12px;
      line-height: 1.2;
    }
    button.primary { background: var(--focus); border-color: var(--focus); color: #1b1204; font-weight: 700; }
    button.icon { width: 28px; height: 28px; padding: 0; display: inline-grid; place-items: center; }
    button:disabled { opacity: 0.45; cursor: default; }
    input, select, textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-3);
      color: var(--text);
      padding: 7px 8px;
      outline: none;
      font-size: 12px;
    }
    textarea { min-height: 72px; resize: vertical; }
    .app { width: min(380px, 100vw); height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto auto; background: var(--bg); }
    .top { padding: 10px 10px 8px; border-bottom: 1px solid var(--line); background: #17191c; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .brand { min-width: 0; }
    .brand strong { display: block; font-size: 14px; line-height: 1.15; }
    .brand span { color: var(--muted); font-size: 11px; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px rgba(121, 184, 132, 0.7); }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin-top: 8px; }
    .metric { border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px; background: var(--panel); min-width: 0; }
    .metric span { display: block; color: var(--faint); font-size: 9px; text-transform: uppercase; }
    .metric strong { display: block; font-size: 15px; line-height: 1.2; margin-top: 2px; }
    .attention { border-bottom: 1px solid var(--line); padding: 7px 10px; background: #15171a; min-height: 50px; }
    .attention-card { border-left: 3px solid var(--focus); padding-left: 8px; min-height: 34px; display: grid; gap: 2px; }
    .attention-card.red { border-left-color: var(--red); }
    .attention-card.amber { border-left-color: var(--focus); }
    .attention-card.blue { border-left-color: var(--blue); }
    .attention-card .label { color: var(--muted); font-size: 10px; text-transform: uppercase; }
    .attention-card .title { font-size: 12px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--bg); }
    .tab { background: transparent; color: var(--muted); }
    .tab.active { background: var(--panel-2); color: var(--text); border-color: var(--focus); }
    .main { min-height: 0; overflow: hidden; position: relative; }
    .list { height: 100%; overflow: auto; padding: 8px 10px 12px; display: grid; align-content: start; gap: 7px; }
    .card, .block, .activity-item { border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel); box-shadow: 0 8px 18px var(--shadow); }
    .card { padding: 8px; cursor: pointer; position: relative; }
    .card.selected { border-color: var(--focus); background: #222323; }
    .card.unread::before { content: ""; position: absolute; left: -1px; top: 10px; width: 6px; height: 6px; border-radius: 50%; background: var(--blue); }
    .card.dragging { opacity: 0.6; }
    .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .between { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
    .id { color: var(--faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; flex: 0 0 auto; }
    .title { font-size: 12px; line-height: 1.3; margin: 5px 0; overflow-wrap: anywhere; }
    .small { font-size: 11px; line-height: 1.3; color: var(--muted); overflow-wrap: anywhere; }
    .pill { border: 1px solid var(--line); border-radius: 999px; color: var(--muted); padding: 2px 6px; font-size: 10px; line-height: 1.2; white-space: nowrap; background: #17191c; }
    .pill.active, .pill.aligned { border-color: var(--green); color: #cfe8d3; }
    .pill.draft, .pill.proposed, .pill.clarifying, .pill.uncertain { border-color: var(--focus); color: #f0d6a5; }
    .pill.closed, .pill.superseded { border-color: var(--faint); color: var(--faint); }
    .pill.divergent, .pill.flagged, .pill.red { border-color: var(--red); color: #f0beb9; }
    .actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
    .expanded { display: grid; gap: 7px; margin-top: 8px; }
    .interp { border: 1px solid var(--line-soft); border-radius: 6px; padding: 7px; background: var(--panel-3); }
    .interp.selected { border-color: var(--focus); }
    .block { padding: 7px; border-left: 3px solid var(--red); background: #211c1d; }
    .block.selected { border-color: var(--red); box-shadow: inset 0 0 0 1px rgba(214, 111, 103, 0.35); }
    .block-head { color: #f0beb9; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
    .ghost-stack { display: grid; gap: 5px; margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--line); }
    .ghost { opacity: 0.66; font-size: 11px; border: 1px dashed var(--line); border-radius: 6px; padding: 5px; }
    .tree { margin-top: 6px; padding-left: 10px; border-left: 2px solid var(--line); display: grid; gap: 5px; }
    .report { border-top: 1px solid var(--line-soft); padding-top: 6px; margin-top: 6px; }
    .activity-item { padding: 8px; border-left: 3px solid var(--blue); animation: slide-in 160ms ease-out; }
    @keyframes slide-in { from { transform: translateX(10px); opacity: 0.3; } to { transform: translateX(0); opacity: 1; } }
    .logger { border-top: 1px solid var(--line); background: #17191c; padding: 8px 10px; display: grid; gap: 6px; }
    .logger-context { display: flex; justify-content: space-between; gap: 6px; min-width: 0; color: var(--muted); font-size: 11px; }
    .pills { display: flex; gap: 5px; overflow: auto; }
    .pills button.active { border-color: var(--focus); color: #1b1204; background: var(--focus); font-weight: 700; }
    .actor-bar { border-top: 1px solid var(--line); background: var(--panel-3); padding: 6px 10px; }
    .chips { display: flex; gap: 5px; overflow: auto; align-items: center; }
    .chip { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 4px 7px; font-size: 11px; color: var(--muted); background: var(--panel); }
    .chip.drop { border-color: var(--focus); background: var(--focus-soft); color: var(--text); }
    .chip .claim { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); margin-left: 4px; }
    .roster { display: none; margin-top: 7px; gap: 5px; }
    .actor-bar.open .roster { display: grid; }
    .roster-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--line-soft); border-radius: 6px; padding: 6px; font-size: 11px; }
    .overlay { position: absolute; inset: 8px; background: rgba(19, 20, 22, 0.96); border: 1px solid var(--line); border-radius: 8px; padding: 10px; display: none; z-index: 4; }
    .overlay.open { display: block; }
    .overlay h2 { margin: 0 0 8px; font-size: 14px; }
    .shortcuts { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; font-size: 11px; }
    .kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--focus); }
    .search { display: none; padding: 7px 10px; border-bottom: 1px solid var(--line); }
    .search.open { display: block; }
    .empty { color: var(--muted); font-size: 12px; border: 1px dashed var(--line); border-radius: 8px; padding: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="app">
    <header class="top">
      <div class="head">
        <div class="brand">
          <strong>CML</strong>
          <span id="actor-label">operator sidebar</span>
        </div>
        <div class="row">
          <button class="icon" id="shortcut-button" title="Keyboard shortcuts">?</button>
          <span class="pulse" title="runtime loaded"></span>
        </div>
      </div>
      <div class="metrics" id="metrics"></div>
    </header>
    <section class="attention" id="attention"></section>
    <section class="search" id="search-wrap"><input id="search" type="search" placeholder="Filter"></section>
    <nav class="tabs">
      <button class="tab active" data-tab="triage">Triage</button>
      <button class="tab" data-tab="activity">Activity</button>
    </nav>
    <main class="main">
      <section class="list" id="list"></section>
      <section class="overlay" id="overlay">
        <div class="between"><h2>Shortcuts</h2><button class="icon" id="overlay-close">x</button></div>
        <div class="shortcuts">
          <span class="kbd">j / k</span><span>next or previous card</span>
          <span class="kbd">n i</span><span>new intent</span>
          <span class="kbd">n r</span><span>new interpretation on selected intent</span>
          <span class="kbd">n a</span><span>log action</span>
          <span class="kbd">n p</span><span>register report</span>
          <span class="kbd">s</span><span>supersede selected interpretation</span>
          <span class="kbd">/</span><span>filter</span>
          <span class="kbd">Esc</span><span>deselect or discard active draft</span>
        </div>
      </section>
    </main>
    <section class="logger" id="logger"></section>
    <section class="actor-bar" id="actor-bar"></section>
  </div>
  <script id="operator-bootstrap" type="application/json">${jsonForScript(bootstrap)}</script>
  <script>
  (() => {
    const boot = JSON.parse(document.getElementById("operator-bootstrap").textContent);
    const runtimeMode = boot.mode;
    const actionDescriptors = boot.actionDescriptors;
    const stagedCalls = [];
    window.__CML_STAGED_CALLS = stagedCalls;
    let state = boot.state;
    let activeTab = "triage";
    let selected = null;
    let expanded = new Set();
    let reportOpen = new Set();
    let chainOpen = new Set();
    let actorOpen = false;
    let activeAction = "update";
    let attentionIndex = 0;
    let pendingPrefix = null;
    let searchOpen = false;
    let query = "";

    const $ = (id) => document.getElementById(id);
    const byId = (items) => new Map((items || []).map((item) => [Number(item.id), item]));
    const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const short = (value, length = 118) => {
      const text = String(value || "");
      return text.length > length ? text.slice(0, length - 1) + "..." : text;
    };
    const intentId = (intent) => "INTENT-" + intent.id;
    const interpId = (interp) => "INT-" + interp.id;
    const reportId = (report) => "RPT-" + report.id;
    const draftKey = () => selected ? "draft:" + selected.type + ":" + selected.id + ":" + activeAction : "";
    const now = () => Date.now();

    function saveDraft(reason, body) {
      if (!selected) return;
      const payload = { reason, body, savedAt: now() };
      localStorage.setItem(draftKey(), JSON.stringify(payload));
      renderLogger();
    }

    function loadDraft() {
      if (!selected) return { reason: "", body: "", hasDraft: false };
      try {
        const raw = localStorage.getItem(draftKey());
        if (!raw) return { reason: "", body: "", hasDraft: false };
        const parsed = JSON.parse(raw);
        if (!parsed.savedAt || now() - parsed.savedAt > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(draftKey());
          return { reason: "", body: "", hasDraft: false };
        }
        return { reason: parsed.reason || "", body: parsed.body || "", hasDraft: true };
      } catch {
        return { reason: "", body: "", hasDraft: false };
      }
    }

    function discardDraft() {
      if (selected) localStorage.removeItem(draftKey());
      renderLogger();
    }

    function setSelected(next, options = {}) {
      selected = next;
      if (next && next.type === "intent") expanded.add(String(next.id));
      if (next && next.type === "interpretation") activeAction = "update";
      if (next && next.type === "divergence_group") activeAction = "resolve";
      if (!next) activeAction = "update";
      emitFocus(options.pendingAction || activeAction);
      render();
    }

    async function emitFocus(pendingAction) {
      if (!selected) return;
      const draft = loadDraft();
      const payload = {
        entityType: selected.type,
        entityId: selected.id,
        pendingAction,
        parentIntentId: selected.intentId,
        alignment: selected.alignment,
        hasDraft: draft.hasDraft,
      };
      if (runtimeMode === "remote-http") {
        try {
          await fetch("/api/focus", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch {}
      } else {
        stageCall("focus_emit", payload);
      }
    }

    function stageCall(actionKey, argumentsObject) {
      const descriptor = actionDescriptors[actionKey];
      const call = {
        descriptor: actionKey,
        tool: descriptor ? descriptor.tool : actionKey,
        arguments: argumentsObject,
        stagedAt: new Date().toISOString(),
      };
      stagedCalls.push(call);
      window.dispatchEvent(new CustomEvent("cml:mcp-call-staged", { detail: call }));
      return { ok: true, staged: true, call };
    }

    async function callAction(actionKey, argumentsObject, httpRequest) {
      if (runtimeMode !== "remote-http") return stageCall(actionKey, argumentsObject);
      const response = await fetch(httpRequest.path, {
        method: httpRequest.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(httpRequest.body || argumentsObject),
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error && body.error.message ? body.error.message : "Write failed");
      await refreshState();
      return body;
    }

    async function refreshState() {
      if (runtimeMode !== "remote-http") return;
      const response = await fetch("/api/operator-state");
      const body = await response.json();
      state = body.data;
      render();
    }

    function renderMetrics() {
      const summary = state && state.summary ? state.summary : {};
      const metrics = [
        ["active", summary.activeIntentCount || 0],
        ["draft", summary.draftIntentCount || 0],
        ["diverge", summary.divergenceGroupCount || 0],
        ["claims", summary.activeClaimCount || 0],
        ["events", summary.eventCount || 0],
      ];
      $("metrics").innerHTML = metrics.map(([label, value]) => '<div class="metric"><span>' + label + '</span><strong>' + value + '</strong></div>').join("");
      $("actor-label").textContent = state && state.actor ? state.actor.name : runtimeMode;
    }

    function renderAttention() {
      const items = state && state.attention ? state.attention : [];
      if (!items.length) {
        $("attention").innerHTML = '<div class="attention-card blue"><div class="label">clear</div><div class="title">No flagged divergence or unresolved attention item in the snapshot.</div></div>';
        return;
      }
      const item = items[attentionIndex % items.length];
      $("attention").innerHTML = '<div class="attention-card ' + item.tone + '"><div class="label">' + esc(item.label) + '</div><div class="title">' + esc(item.title) + '</div></div>';
    }

    function filteredIntents() {
      const intents = (state && state.intents ? state.intents : []).filter((intent) => intent.status === "active" || intent.status === "draft");
      if (!query) return intents;
      const q = query.toLowerCase();
      return intents.filter((intent) => (intentId(intent) + " " + intent.description + " " + intent.status).toLowerCase().includes(q));
    }

    function renderTriage() {
      const intents = filteredIntents();
      if (!intents.length) return '<div class="empty">No intents match the current filter.</div>';
      return intents.filter((intent) => intent.parentId == null).map((intent) => renderIntentCard(intent, 0)).join("");
    }

    function renderIntentCard(intent, level) {
      const interps = (state.interpretations || []).filter((item) => Number(item.intentId) === Number(intent.id));
      const reports = (state.reports || []).filter((item) => Number(item.intentId) === Number(intent.id));
      const children = (state.intents || []).filter((item) => Number(item.parentId) === Number(intent.id));
      const groups = (state.divergenceGroups || []).filter((group) => Number(group.intentId) === Number(intent.id));
      const claims = (state.claims || []).filter((claim) => claim.entityTable === "intents" && Number(claim.entityId) === Number(intent.id));
      const isSelected = selected && selected.type === "intent" && Number(selected.id) === Number(intent.id);
      const isOpen = expanded.has(String(intent.id));
      const unread = hasUnread("intents", intent.id);
      const prefix = level > 0 ? "sub-" : "";
      return '<article class="card ' + (isSelected ? "selected " : "") + (unread ? "unread" : "") + '" draggable="true" data-type="intent" data-id="' + intent.id + '">' +
        '<div class="between"><span class="id">' + prefix + intentId(intent) + '</span>' + statusPicker("intent", intent.id, intent.status) + '</div>' +
        '<div class="title">' + esc(short(intent.description, 190)) + '</div>' +
        '<div class="between small"><span>' + interps.length + ' interpretations</span><span>' + reports.length + ' reports</span></div>' +
        '<div class="actions">' +
          '<button data-act="select-intent" data-id="' + intent.id + '">' + (isOpen ? "collapse" : "open") + '</button>' +
          '<button data-act="copy" data-type="intent" data-id="' + intent.id + '">copy md</button>' +
          '<button data-act="claim" data-type="intent" data-id="' + intent.id + '">claim</button>' +
          (claims.length ? '<span class="pill active">' + claims.length + ' claimed</span>' : '') +
        '</div>' +
        (isOpen ? '<div class="expanded">' + groups.map(renderDivergenceBlock).join("") + renderInterpretations(interps, groups) + renderReports(intent.id, reports) + renderChildren(children, level) + '</div>' : '') +
      '</article>';
    }

    function renderDivergenceBlock(group) {
      const isSelected = selected && selected.type === "divergence_group" && String(selected.id) === String(group.id);
      const interps = (state.interpretations || []).filter((item) => group.interpretationIds.includes(Number(item.id)));
      return '<section class="block ' + (isSelected ? "selected" : "") + '" data-type="divergence_group" data-id="' + esc(group.id) + '" data-intent-id="' + group.intentId + '">' +
        '<div class="block-head">divergence - ' + group.count + ' interpretations</div>' +
        interps.map((interp) => renderInterpretation(interp, true)).join("") +
        '<div class="actions"><button data-act="resolve-divergence" data-id="' + esc(group.id) + '" data-intent-id="' + group.intentId + '">create resolution intent</button></div>' +
      '</section>';
    }

    function renderInterpretations(interps, groups) {
      const grouped = new Set(groups.flatMap((group) => group.interpretationIds.map(Number)));
      return interps.filter((interp) => !grouped.has(Number(interp.id))).map((interp) => renderInterpretation(interp, false)).join("");
    }

    function renderInterpretation(interp, compact) {
      const isSelected = selected && selected.type === "interpretation" && Number(selected.id) === Number(interp.id);
      const chain = (state.supersessionChains || []).find((item) => Number(item.currentId) === Number(interp.id));
      const predecessors = chain ? chain.predecessorIds.map((id) => (state.interpretations || []).find((item) => Number(item.id) === Number(id))).filter(Boolean) : [];
      const chainKey = String(interp.id);
      return '<article class="interp ' + (isSelected ? "selected" : "") + '" data-type="interpretation" data-id="' + interp.id + '">' +
        '<div class="between"><span class="id">' + interpId(interp) + '</span>' + statusPicker("interpretation", interp.id, interp.status) + '</div>' +
        '<div class="title">' + esc(short(interp.title, compact ? 100 : 150)) + '</div>' +
        '<div class="row"><span class="pill ' + esc(interp.alignment) + '">' + esc(interp.alignment) + '</span><span class="pill ' + esc(interp.status) + '">' + esc(interp.status) + '</span></div>' +
        (interp.scopeAssumption && !compact ? '<div class="small">' + esc(short(interp.scopeAssumption, 180)) + '</div>' : '') +
        '<div class="actions">' +
          '<button data-act="select-interpretation" data-id="' + interp.id + '">focus</button>' +
          '<button data-act="copy" data-type="interpretation" data-id="' + interp.id + '">copy md</button>' +
          '<button data-act="supersede" data-id="' + interp.id + '">supersede</button>' +
          (predecessors.length ? '<button data-act="toggle-chain" data-id="' + interp.id + '">' + predecessors.length + ' superseded</button>' : '') +
        '</div>' +
        (predecessors.length && chainOpen.has(chainKey) ? '<div class="ghost-stack">' + predecessors.map((old) => '<div class="ghost"><span class="id">' + interpId(old) + '</span> ' + esc(short(old.title, 92)) + '</div>').join("") + '</div>' : '') +
      '</article>';
    }

    function renderReports(intentIdValue, reports) {
      if (!reports.length) return "";
      const key = String(intentIdValue);
      const open = reportOpen.has(key);
      return '<section class="report"><button data-act="toggle-reports" data-id="' + key + '">' + reports.length + ' reports</button>' +
        (open ? reports.map((report) => '<div class="small"><span class="id">' + reportId(report) + '</span> ' + esc(report.title) + '</div>').join("") : "") +
      '</section>';
    }

    function renderChildren(children, level) {
      if (!children.length || level >= 2) return children.length ? '<div class="tree small">' + children.length + ' more sub-intents</div>' : "";
      return '<div class="tree">' + children.map((child) => renderIntentCard(child, level + 1)).join("") + '</div>';
    }

    function renderActivity() {
      const events = state && state.events ? state.events : [];
      const reports = (state && state.reports ? state.reports : []).filter((report) => report.intentId == null);
      const reportItems = reports.map((report) => ({ kind: "report", createdAt: report.createdAt, item: report }));
      const eventItems = events.map((event) => ({ kind: "event", createdAt: event.createdAt, item: event }));
      const items = [...reportItems, ...eventItems].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 80);
      if (!items.length) return '<div class="empty">No activity in the current snapshot.</div>';
      return items.map((entry) => {
        if (entry.kind === "report") {
          const report = entry.item;
          return '<article class="activity-item"><div class="between"><span class="id">' + reportId(report) + '</span><span class="pill">report</span></div><div class="title">' + esc(report.title) + '</div><div class="small">' + esc(short(report.summary, 140)) + '</div></article>';
        }
        const event = entry.item;
        return '<article class="activity-item" data-entity-table="' + esc(event.entityTable) + '" data-entity-id="' + event.entityId + '">' +
          '<div class="between"><span class="id">EVT-' + event.id + '</span><span class="pill">' + esc(event.eventType) + '</span></div>' +
          '<div class="small">' + esc(event.entityTable) + ' #' + event.entityId + (event.reason ? ' - ' + esc(short(event.reason, 96)) : '') + '</div>' +
        '</article>';
      }).join("");
    }

    function statusPicker(type, id, status) {
      const values = type === "intent" ? ["draft", "active", "closed", "superseded"] : ["fyi", "clarifying", "proposed", "flagged", "superseded"];
      return '<select class="pill ' + esc(status) + '" data-act="status" data-type="' + type + '" data-id="' + id + '">' +
        values.map((value) => '<option value="' + value + '"' + (value === status ? " selected" : "") + '>' + value + '</option>').join("") +
      '</select>';
    }

    function renderLogger() {
      const draft = loadDraft();
      const selectedLabel = selected ? selected.type + " " + selected.id : "nothing selected";
      const allowed = selected && selected.type === "divergence_group" ? ["resolve", "action"] : selected && selected.type === "interpretation" ? ["update", "supersede", "action"] : ["update", "action"];
      if (!allowed.includes(activeAction)) activeAction = allowed[0];
      const needsReason = ["update", "supersede", "resolve"].includes(activeAction);
      $("logger").innerHTML =
        '<div class="logger-context"><span>' + esc(selectedLabel) + '</span><span>' + (draft.hasDraft ? 'draft' : runtimeMode) + '</span></div>' +
        '<div class="pills">' + allowed.map((action) => '<button data-act="logger-action" data-action="' + action + '" class="' + (activeAction === action ? "active" : "") + '">' + action + '</button>').join("") + '</div>' +
        (needsReason ? '<input id="reason" placeholder="Reason" value="' + esc(draft.reason) + '">' : '') +
        '<textarea id="body" placeholder="Body">' + esc(draft.body) + '</textarea>' +
        '<div class="between"><button data-act="discard-draft">discard</button><button class="primary" data-act="submit">commit</button></div>';
    }

    function renderActors() {
      const actors = state && state.actors ? state.actors : [];
      const claimCounts = {};
      (state.claims || []).forEach((claim) => { claimCounts[claim.actorId] = (claimCounts[claim.actorId] || 0) + 1; });
      $("actor-bar").className = "actor-bar" + (actorOpen ? " open" : "");
      $("actor-bar").innerHTML =
        '<div class="between"><div class="chips">' + actors.slice(0, 8).map((actor) => chip(actor, claimCounts[actor.id] || 0)).join("") + '</div><button class="icon" data-act="toggle-roster">' + (actorOpen ? "v" : "^") + '</button></div>' +
        '<div class="roster">' + actors.map((actor) => '<div class="roster-row" data-actor-id="' + actor.id + '"><span>' + esc(actor.name) + '</span><span class="small">' + esc(actor.defaultScope || "") + ' / ' + (claimCounts[actor.id] || 0) + ' claims</span></div>').join("") + '</div>';
    }

    function chip(actor, claims) {
      const initials = actor.name.split(/[-_\\s]+/).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
      return '<span class="chip" data-actor-id="' + actor.id + '" title="' + esc(actor.name) + '">' + esc(initials) + (claims ? '<span class="claim"></span>' : '') + '</span>';
    }

    function render() {
      if (!state) {
        $("list").innerHTML = '<div class="empty">No state snapshot embedded.</div>';
        return;
      }
      renderMetrics();
      renderAttention();
      $("list").innerHTML = activeTab === "triage" ? renderTriage() : renderActivity();
      renderLogger();
      renderActors();
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === activeTab));
      $("search-wrap").classList.toggle("open", searchOpen);
    }

    function hasUnread(entityTable, entityId) {
      const last = Number(localStorage.getItem("focus:" + entityTable + ":" + entityId) || 0);
      return (state.events || []).some((event) => event.entityTable === entityTable && Number(event.entityId) === Number(entityId) && new Date(event.createdAt).getTime() > last);
    }

    function markFocused(entityTable, entityId) {
      localStorage.setItem("focus:" + entityTable + ":" + entityId, String(now()));
    }

    function currentIntentId() {
      if (!selected) return undefined;
      if (selected.type === "intent") return Number(selected.id);
      if (selected.intentId != null) return Number(selected.intentId);
      const interp = (state.interpretations || []).find((item) => Number(item.id) === Number(selected.id));
      return interp ? Number(interp.intentId) : undefined;
    }

    function markdownFor(type, id) {
      const item = type === "intent" ? (state.intents || []).find((row) => Number(row.id) === Number(id))
        : type === "interpretation" ? (state.interpretations || []).find((row) => Number(row.id) === Number(id))
        : undefined;
      if (!item) return "";
      if (type === "intent") return "## " + intentId(item) + "\\n\\nStatus: " + item.status + "\\n\\n" + item.description;
      return "## " + interpId(item) + "\\n\\nStatus: " + item.status + "\\nAlignment: " + item.alignment + "\\n\\n" + item.title + "\\n\\n" + (item.scopeAssumption || "");
    }

    async function copyMarkdown(type, id) {
      const text = markdownFor(type, id);
      if (navigator.clipboard) await navigator.clipboard.writeText(text);
      else stageCall("copy_markdown", { type, id, markdown: text });
    }

    async function updateStatus(type, id, status) {
      const reason = "Operator status picker";
      if (type === "intent") {
        await callAction("intent_update", { id: Number(id), status, reason }, { method: "PATCH", path: "/api/intents/" + id, body: { status, reason } });
      } else {
        await callAction("interpretation_update", { id: Number(id), status, reason }, { method: "PATCH", path: "/api/interpretations/" + id, body: { status, reason } });
      }
    }

    async function claimEntity(type, id) {
      await callAction("claim_create", { entityTable: type === "intent" ? "intents" : "interpretations", entityId: Number(id) }, {
        path: "/api/claims",
        body: { entityTable: type === "intent" ? "intents" : "interpretations", entityId: Number(id), note: "Claimed from operator sidebar" },
      });
    }

    async function submitLogger() {
      if (!selected) return;
      const reasonInput = $("reason");
      const bodyInput = $("body");
      const reason = reasonInput ? reasonInput.value.trim() : "Operator write";
      const body = bodyInput ? bodyInput.value.trim() : "";
      if (["update", "supersede", "resolve"].includes(activeAction) && !reason) return;
      if (selected.type === "divergence_group" && activeAction === "resolve") {
        const description = body || ("Resolve divergence on INTENT-" + selected.intentId + " from " + selected.id);
        await callAction("intent_create", { description, source: "operator-sidebar", parentId: Number(selected.intentId), status: "draft" }, {
          path: "/api/intents",
          body: { description, source: "operator-sidebar", parentId: Number(selected.intentId), status: "draft" },
        });
      } else if (selected.type === "intent" && activeAction === "update") {
        await callAction("intent_update", { id: Number(selected.id), reason, resolutionNotes: body || undefined }, {
          method: "PATCH",
          path: "/api/intents/" + selected.id,
          body: { reason, resolutionNotes: body || undefined },
        });
      } else if (selected.type === "interpretation" && activeAction === "update") {
        await callAction("interpretation_update", { id: Number(selected.id), reason, scopeAssumption: body || undefined }, {
          method: "PATCH",
          path: "/api/interpretations/" + selected.id,
          body: { reason, scopeAssumption: body || undefined },
        });
      } else if (selected.type === "interpretation" && activeAction === "supersede") {
        await callAction("interpretation_supersede", { id: Number(selected.id), newTitle: body.split("\\n")[0] || "Superseded interpretation", reason, newScopeAssumption: body || undefined }, {
          path: "/api/interpretations/" + selected.id + "/supersede",
          body: { newTitle: body.split("\\n")[0] || "Superseded interpretation", reason, newScopeAssumption: body || undefined },
        });
      } else {
        const intent = currentIntentId();
        if (!intent) return;
        await callAction("action_log", { intentId: intent, interpretationId: selected.type === "interpretation" ? Number(selected.id) : undefined, description: body || reason, outcome: reason }, {
          path: "/api/actions",
          body: { intentId: intent, interpretationId: selected.type === "interpretation" ? Number(selected.id) : undefined, description: body || reason, outcome: reason },
        });
      }
      discardDraft();
    }

    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) {
        const card = event.target.closest("[data-type][data-id]");
        if (card) selectFromElement(card);
        return;
      }
      const act = target.dataset.act;
      try {
        if (act === "select-intent") {
          const id = Number(target.dataset.id);
          expanded.has(String(id)) ? expanded.delete(String(id)) : expanded.add(String(id));
          setSelected({ type: "intent", id });
          markFocused("intents", id);
        } else if (act === "select-interpretation") {
          const interp = (state.interpretations || []).find((item) => Number(item.id) === Number(target.dataset.id));
          setSelected({ type: "interpretation", id: Number(target.dataset.id), intentId: interp && Number(interp.intentId), alignment: interp && interp.alignment });
          markFocused("interpretations", Number(target.dataset.id));
        } else if (act === "resolve-divergence") {
          setSelected({ type: "divergence_group", id: target.dataset.id, intentId: Number(target.dataset.intentId) }, { pendingAction: "resolve" });
        } else if (act === "copy") {
          await copyMarkdown(target.dataset.type, target.dataset.id);
        } else if (act === "claim") {
          await claimEntity(target.dataset.type, target.dataset.id);
        } else if (act === "toggle-chain") {
          const id = String(target.dataset.id);
          chainOpen.has(id) ? chainOpen.delete(id) : chainOpen.add(id);
          render();
        } else if (act === "toggle-reports") {
          const id = String(target.dataset.id);
          reportOpen.has(id) ? reportOpen.delete(id) : reportOpen.add(id);
          render();
        } else if (act === "logger-action") {
          activeAction = target.dataset.action;
          emitFocus(activeAction);
          renderLogger();
        } else if (act === "discard-draft") {
          discardDraft();
        } else if (act === "submit") {
          await submitLogger();
        } else if (act === "toggle-roster") {
          actorOpen = !actorOpen;
          renderActors();
        }
      } catch (error) {
        window.dispatchEvent(new CustomEvent("cml:operator-error", { detail: String(error && error.message ? error.message : error) }));
      }
    });

    document.addEventListener("change", async (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.act === "status") {
        await updateStatus(target.dataset.type, target.dataset.id, target.value);
      }
    });

    document.addEventListener("input", (event) => {
      if (event.target && event.target.id === "search") {
        query = event.target.value;
        render();
        $("search").focus();
      }
      if (event.target && (event.target.id === "reason" || event.target.id === "body")) {
        const reason = $("reason") ? $("reason").value : "";
        const body = $("body") ? $("body").value : "";
        clearTimeout(window.__draftTimer);
        window.__draftTimer = setTimeout(() => saveDraft(reason, body), 300);
      }
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        render();
      });
    });

    $("shortcut-button").addEventListener("click", () => $("overlay").classList.add("open"));
    $("overlay-close").addEventListener("click", () => $("overlay").classList.remove("open"));

    document.addEventListener("dragstart", (event) => {
      const card = event.target.closest('[data-type="intent"][data-id]');
      if (!card) return;
      card.classList.add("dragging");
      event.dataTransfer.setData("text/plain", card.dataset.id);
      event.dataTransfer.effectAllowed = "move";
    });
    document.addEventListener("dragend", () => document.querySelectorAll(".dragging").forEach((node) => node.classList.remove("dragging")));
    document.addEventListener("dragover", (event) => {
      const chip = event.target.closest("[data-actor-id]");
      if (!chip) return;
      event.preventDefault();
      chip.classList.add("drop");
    });
    document.addEventListener("dragleave", (event) => {
      const chip = event.target.closest("[data-actor-id]");
      if (chip) chip.classList.remove("drop");
    });
    document.addEventListener("drop", async (event) => {
      const chip = event.target.closest("[data-actor-id]");
      if (!chip) return;
      event.preventDefault();
      chip.classList.remove("drop");
      const intent = Number(event.dataTransfer.getData("text/plain"));
      const actor = Number(chip.dataset.actorId);
      await callAction("intent_update", { id: intent, addressedTo: actor, reason: "Drag-to-address from operator sidebar" }, {
        method: "PATCH",
        path: "/api/intents/" + intent,
        body: { addressedTo: actor, reason: "Drag-to-address from operator sidebar" },
      });
    });

    function selectFromElement(element) {
      const type = element.dataset.type;
      const id = element.dataset.id;
      if (type === "intent") setSelected({ type, id: Number(id) });
      if (type === "interpretation") {
        const interp = (state.interpretations || []).find((item) => Number(item.id) === Number(id));
        setSelected({ type, id: Number(id), intentId: interp && Number(interp.intentId), alignment: interp && interp.alignment });
      }
      if (type === "divergence_group") setSelected({ type, id, intentId: Number(element.dataset.intentId) }, { pendingAction: "resolve" });
    }

    document.addEventListener("keydown", (event) => {
      if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) {
        if (event.key !== "Escape") return;
      }
      if (pendingPrefix === "n") {
        const key = event.key.toLowerCase();
        pendingPrefix = null;
        if (key === "i") {
          setSelected({ type: "intent", id: "new" });
          activeAction = "update";
          stageCall("intent_create", { description: "", source: "operator-sidebar" });
        } else if (key === "r" && currentIntentId()) {
          stageCall("interpretation_create", { intentId: currentIntentId(), title: "", domainId: (state.domains[0] && state.domains[0].id) || undefined });
        } else if (key === "a" && currentIntentId()) {
          activeAction = "action";
          renderLogger();
        } else if (key === "p") {
          stageCall("report_create", { intentId: currentIntentId(), title: "", summary: "" });
        }
        return;
      }
      if (event.key === "n") {
        pendingPrefix = "n";
        setTimeout(() => { pendingPrefix = null; }, 1200);
      } else if (event.key === "j" || event.key === "k") {
        const intents = filteredIntents();
        if (!intents.length) return;
        const current = selected && selected.type === "intent" ? intents.findIndex((item) => Number(item.id) === Number(selected.id)) : -1;
        const next = event.key === "j" ? Math.min(intents.length - 1, current + 1) : Math.max(0, current - 1);
        setSelected({ type: "intent", id: Number(intents[next].id) });
      } else if (event.key === "s" && selected && selected.type === "interpretation") {
        activeAction = "supersede";
        renderLogger();
      } else if (event.key === "/") {
        event.preventDefault();
        searchOpen = true;
        render();
        $("search").focus();
      } else if (event.key === "?") {
        $("overlay").classList.add("open");
      } else if (event.key === "Escape") {
        if ($("overlay").classList.contains("open")) $("overlay").classList.remove("open");
        else if (selected) { discardDraft(); selected = null; render(); }
      }
    });

    setInterval(() => {
      attentionIndex += 1;
      renderAttention();
    }, 5000);

    if (!state && runtimeMode === "remote-http") refreshState();
    else render();
  })();
  </script>
</body>
</html>`;
  const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
  return { mediaType: OPERATOR_RUNTIME_MEDIA_TYPE, html, sha256, version: OPERATOR_RUNTIME_VERSION };
}

export function renderMediationCentreRuntime(
  state: OperatorSurfaceState | undefined,
  options: {
    includeState?: boolean;
    setupError?: { code: string; message: string };
  } = {}
): OperatorRuntime {
  const includeState = options.includeState ?? true;
  const bootstrap = {
    name: MEDIATION_CENTRE_RUNTIME_NAME,
    version: MEDIATION_CENTRE_RUNTIME_VERSION,
    state: includeState ? state ?? null : null,
    setupError: options.setupError ?? null,
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CML Mediation Centre</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --rail: #20242b;
      --rail-2: #2b3038;
      --surface: #ffffff;
      --surface-2: #f9fafb;
      --line: #d9dee7;
      --line-soft: #e8ebf0;
      --text: #171b21;
      --muted: #667085;
      --faint: #98a2b3;
      --blue: #3977d4;
      --green: #2e9b61;
      --amber: #c7831e;
      --red: #d14c42;
      --violet: #7a5cc7;
      --blue-soft: #eef5ff;
      --green-soft: #e9f8ef;
      --amber-soft: #fff7e8;
      --red-soft: #fff1f0;
      --glass: rgba(255, 255, 255, 0.9);
      --shadow: rgba(15, 23, 42, 0.12);
      --paper: #fffdfa;
      --teal: #06697a;
      --teal-soft: #dceff1;
      --teal-edge: #abd3d8;
      --berry: #9d3c60;
      --berry-soft: #fae3ec;
      --chrome-height: 72px;
      --mode-height: 30px;
      --detail-drawer-width: 480px;
      --detail-drawer-space: min(var(--detail-drawer-width), 42vw);
      --font-sans: Inter, "Avenir Next", "Segoe UI", system-ui, sans-serif;
      --font-mono: "JetBrains Mono", "SF Mono", "IBM Plex Mono", ui-monospace, monospace;
    }
    @supports (color: color-mix(in oklab, white, black)) {
      :root {
        --surface-2: color-mix(in oklab, var(--surface) 82%, #eef3fb);
        --line-soft: color-mix(in oklab, var(--line) 54%, white);
        --blue-soft: color-mix(in oklab, var(--blue) 12%, white);
        --green-soft: color-mix(in oklab, var(--green) 12%, white);
        --amber-soft: color-mix(in oklab, var(--amber) 12%, white);
        --red-soft: color-mix(in oklab, var(--red) 11%, white);
        --glass: color-mix(in oklab, var(--surface) 88%, transparent);
        --shadow: color-mix(in oklab, #101828 16%, transparent);
      }
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; scroll-behavior: smooth; scrollbar-gutter: stable; }
    body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body {
      font-family: var(--font-sans);
      font-weight: 400;
      letter-spacing: 0;
      overflow: auto;
      accent-color: var(--blue);
      text-rendering: optimizeLegibility;
    }
    ::selection { background: var(--blue-soft); color: var(--text); }
    button, input, select, textarea { font: inherit; letter-spacing: 0; }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      min-width: 0;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.2;
      cursor: pointer;
      transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
    }
    button:hover:not(:disabled) { box-shadow: 0 1px 0 rgba(16, 24, 40, 0.04); transform: translateY(-1px); }
    button.primary { background: var(--blue); border-color: var(--blue); color: #fff; font-weight: 600; }
    button.ghost { background: transparent; }
    button.mutate { border-color: rgba(199, 131, 30, 0.48); background: var(--amber-soft); color: #8a5a12; }
    button.icon { width: 30px; height: 30px; padding: 0; display: inline-grid; place-items: center; }
    button:disabled, select:disabled, input:disabled, textarea:disabled { opacity: 0.48; cursor: default; }
    input, select, textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 8px 9px;
      outline: none;
      font-size: 12px;
      line-height: 1.25;
    }
    textarea { min-height: 84px; resize: vertical; }
    input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid rgba(57, 119, 212, 0.28); outline-offset: 1px; }
    @supports (outline-color: color-mix(in oklab, white, black)) {
      input:focus, select:focus, textarea:focus, button:focus-visible { outline-color: color-mix(in oklab, var(--blue) 34%, transparent); }
    }
    .mediation-centre { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; background: var(--bg); }
    .actor-chip { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .avatar { width: 26px; height: 26px; border-radius: 6px; background: #f5f7fb; color: var(--rail); display: inline-grid; place-items: center; font-weight: 600; font-size: 11px; flex: 0 0 auto; }
    .main { container: main / inline-size; min-width: 0; min-height: 100vh; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); }
    .toolbar { min-height: var(--chrome-height); background: var(--glass); border-bottom: 1px solid var(--line); padding: 10px 16px; display: grid; grid-template-columns: minmax(180px, 0.5fr) minmax(340px, 1fr) minmax(360px, 0.82fr); align-items: center; gap: 14px; min-width: 0; backdrop-filter: blur(14px) saturate(1.12); position: sticky; top: 0; z-index: 16; transition: margin-right 240ms cubic-bezier(.2,.7,.2,1); }
    .title-block { min-width: 0; }
    .title-block h1 { margin: 0; font-size: 22px; line-height: 1.15; font-weight: 500; }
    .title-block span { display: block; color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .header-menu { min-width: 0; display: flex; align-items: center; gap: 6px; overflow-x: auto; scrollbar-width: none; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-2); padding: 4px; }
    .header-menu::-webkit-scrollbar { display: none; }
    .header-menu button { flex: 0 0 auto; border-radius: 999px; border-color: transparent; background: transparent; color: var(--muted); font-family: var(--font-mono); font-size: 11px; font-weight: 500; padding: 7px 11px; }
    .header-menu button.active { background: var(--teal); border-color: var(--teal); color: #fffdfa; }
    .toolbar-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .search-wrap { position: relative; flex: 1 1 auto; }
    .search-wrap input { padding-left: 30px; }
    .search-wrap span { position: absolute; left: 10px; top: 8px; color: var(--faint); font-size: 12px; }
    .brand-lockup { flex: 0 0 auto; display: grid; gap: 1px; justify-items: end; border-left: 1px solid var(--line); padding-left: 12px; color: var(--text); }
    .brand-lockup strong { font-size: 13px; line-height: 1; letter-spacing: 0; font-weight: 600; }
    .brand-lockup span { color: var(--muted); font-size: 10px; line-height: 1.1; }
    .live-stripe { min-height: var(--mode-height); background: #fbfcfe; border-bottom: 1px solid var(--line); color: var(--muted); display: flex; align-items: center; gap: 8px; padding: 5px 16px; font-size: 11px; transition: margin-right 240ms cubic-bezier(.2,.7,.2,1); }
    .live-stripe::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--amber); flex: 0 0 auto; }
    .live-stripe.ok::before { background: var(--green); }
    .live-stripe.error::before { background: var(--red); }
    .state-strip { background: var(--glass); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; align-items: center; gap: 8px; overflow: auto; backdrop-filter: blur(14px) saturate(1.08); }
    .filter-set { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
    .filter-chip { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 6px 8px; font-size: 11px; font-weight: 500; color: var(--muted); }
    .filter-chip.active { border-color: var(--blue); color: var(--blue); background: var(--blue-soft); font-weight: 600; }
    .rail-meta { flex: 0 0 auto; color: var(--muted); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
    .board-wrap { min-height: 0; overflow: visible; padding: 14px 16px 22px; }
    .setup-panel, .empty-board { border: 1px dashed var(--line); border-radius: 8px; background: var(--surface); padding: 20px; color: var(--muted); display: grid; gap: 8px; }
    .setup-panel strong, .empty-board strong { color: var(--text); }
    .group { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; overflow: hidden; box-shadow: 0 8px 18px rgba(15, 23, 42, 0.04); content-visibility: auto; contain-intrinsic-size: auto 320px; }
    .group-head { height: 38px; display: grid; grid-template-columns: 4px 1fr auto; align-items: center; border-bottom: 1px solid var(--line); background: #fbfcfe; }
    .group-bar.needs { background: var(--red); height: 100%; }
    .group-bar.active { background: var(--green); height: 100%; }
    .group-bar.draft { background: var(--amber); height: 100%; }
    .group-bar.closed { background: var(--faint); height: 100%; }
    .group-title { display: flex; align-items: center; gap: 8px; padding: 0 10px; font-size: 15px; font-weight: 500; }
    .group-count { color: var(--muted); padding-right: 12px; font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }
    .table { min-width: 800px; }
    .table-row, .table-head { display: grid; grid-template-columns: 28px minmax(170px, 1.4fr) 78px 86px 68px 82px 48px 48px minmax(72px, 0.7fr) 64px; align-items: stretch; }
    .table-head { background: var(--surface-2); color: var(--muted); font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; font-weight: 500; letter-spacing: 0.06em; border-bottom: 1px solid var(--line-soft); }
    .table-head div, .cell { border-right: 1px solid var(--line-soft); min-width: 0; }
    .table-head div { padding: 8px 9px; }
    .table-row { min-height: 48px; border-bottom: 1px solid var(--line-soft); background: var(--surface); cursor: pointer; transition: background-color 150ms ease, box-shadow 150ms ease; }
    .table-row:last-child { border-bottom: 0; }
    .table-row:hover { background: #fbfdff; }
    .table-row.selected { background: var(--blue-soft); box-shadow: inset 3px 0 0 var(--blue); }
    .cell { padding: 8px 9px; display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12px; }
    .cell.center { justify-content: center; }
    .intent-title { display: grid; gap: 2px; min-width: 0; }
    .intent-title strong { font-size: 13px; line-height: 1.25; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .intent-title span, .tiny { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .id { color: var(--faint); font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }
    .status-select, .alignment-select { font-size: 11px; font-weight: 500; border-radius: 6px; padding: 6px 7px; }
    .mutate-control { border-color: rgba(199, 131, 30, 0.48); box-shadow: inset 0 0 0 1px rgba(199, 131, 30, 0.08); }
    .status-select.active, .pill.active { background: var(--green-soft); color: var(--green); border-color: rgba(46, 155, 97, 0.32); }
    .status-select.draft, .pill.draft, .pill.uncertain, .pill.proposed, .pill.clarifying { background: var(--amber-soft); color: var(--amber); border-color: rgba(199, 131, 30, 0.36); }
    .status-select.closed, .status-select.superseded, .pill.closed, .pill.superseded { background: #f1f3f6; color: var(--muted); border-color: var(--line); }
    .pill.divergent, .pill.flagged { background: var(--red-soft); color: var(--red); border-color: rgba(209, 76, 66, 0.34); }
    .pill.aligned { background: var(--green-soft); color: var(--green); border-color: rgba(46, 155, 97, 0.32); }
    .pill { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 4px 7px; font-size: 11px; font-weight: 500; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--surface-2); }
    .num-cell { color: var(--text); font-family: var(--font-mono); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
    .num-cell.zero { color: var(--faint); opacity: 0.55; }
    .swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; background: var(--faint); }
    .swatch.aligned { background: var(--green); }
    .swatch.uncertain { background: var(--amber); }
    .swatch.divergent, .swatch.flagged { background: var(--red); }
    .swatch.superseded { background: var(--faint); }
    .domain-stack, .mini-stack { display: flex; gap: 4px; overflow: hidden; min-width: 0; }
    .domain { max-width: 86px; border-radius: 6px; padding: 3px 6px; background: #eef2f7; color: #344054; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .drawer-scrim { position: fixed; inset: var(--chrome-height) 0 0 0; z-index: 14; background: rgba(15, 23, 42, 0.34); display: none; opacity: 0; transition: opacity 180ms ease; }
    .drawer { position: fixed; inset: 0 0 0 auto; z-index: 17; width: min(var(--detail-drawer-width), 92vw); height: 100vh; background: var(--paper); border-left: 1px solid var(--line); display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; transform: translateX(100%); transition: transform 240ms cubic-bezier(.2,.7,.2,1), box-shadow 240ms ease; box-shadow: -12px 0 42px -34px rgba(23, 23, 23, 0.45); }
    .drawer::before { content: ""; position: absolute; left: 0; top: var(--chrome-height); bottom: 0; width: 0; background: transparent; transition: width 180ms ease; }
    .drawer.bucket-needs::before { width: 3px; background: var(--red); }
    .drawer.bucket-active::before { width: 3px; background: var(--green); }
    .drawer.bucket-draft::before { width: 3px; background: var(--amber); }
    body.detail-open .drawer { transform: translateX(0); }
    .drawer-head { border-bottom: 1px solid var(--line); display: grid; align-items: start; }
    .drawer-rail { min-height: var(--chrome-height); border-bottom: 1px solid var(--line); background: var(--glass); padding: 10px 14px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; backdrop-filter: blur(14px) saturate(1.12); }
    .drawer-close { width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; }
    .drawer-close:hover:not(:disabled) { background: var(--bg); color: var(--text); }
    .drawer-tabs { min-width: 0; display: flex; flex-wrap: nowrap; gap: 5px; overflow-x: auto; padding: 2px 0; scrollbar-width: none; }
    .drawer-tabs::-webkit-scrollbar { display: none; }
    .drawer-tabs .tab { flex: 0 0 auto; border-radius: 999px; background: transparent; color: var(--muted); padding: 6px 10px; font-family: var(--font-mono); font-size: 11px; font-weight: 500; }
    .drawer-tabs .tab.active { color: var(--berry); border-color: rgba(157, 60, 96, 0.28); background: var(--berry-soft); }
    .drawer-brand { border-left: 1px solid var(--line); padding-left: 12px; }
    .drawer-summary { display: grid; gap: 10px; min-width: 0; }
    .drawer-head .drawer-summary { padding: 14px 15px 12px; }
    .drawer-title { display: grid; gap: 5px; min-width: 0; }
    .drawer-title h2 { margin: 0; font-size: 17px; line-height: 1.25; font-weight: 500; text-wrap: balance; }
    .drawer-breadcrumb { color: var(--muted); font-family: var(--font-mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; }
    .drawer-actions { display: flex; gap: 7px; flex-wrap: wrap; }
    .drawer-body { min-height: 0; overflow: auto; padding: 12px 15px 18px; display: grid; align-content: start; gap: 12px; }
    .detail-block, .interp-card, .composer, .event-card { border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 10px; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .detail-block { min-width: 0; }
    .detail-block.wide { grid-column: 1 / -1; }
    .detail-block span { display: block; color: var(--muted); font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; font-weight: 500; letter-spacing: 0.06em; margin-bottom: 5px; }
    .detail-block p { margin: 0; font-size: 14px; line-height: 1.35; color: var(--text); overflow-wrap: anywhere; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 500; }
    .interp-card { display: grid; gap: 8px; }
    .interp-card strong, .event-card strong { font-weight: 500; }
    .interp-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .interp-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .composer { display: grid; gap: 8px; background: #fbfcfe; }
    .button-row { display: flex; gap: 6px; flex-wrap: wrap; }
    .event-card { border-left: 3px solid var(--blue); display: grid; gap: 3px; }
    body.modal-open { overflow: hidden; }
    .modal-layer { position: fixed; inset: 0; z-index: 20; display: none; place-items: center; padding: 18px; }
    .modal-layer.open { display: grid; }
    .modal-backdrop { position: absolute; inset: 0; background: rgba(15, 23, 42, 0.34); backdrop-filter: blur(7px); }
    .modal-card { position: relative; width: min(680px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 32px)); overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 22px 70px rgba(15, 23, 42, 0.22); }
    .modal-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .modal-head h2 { margin: 0; font-size: 18px; line-height: 1.2; }
    .modal-head span { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
    .modal-body { padding: 16px 18px; display: grid; gap: 12px; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .field { display: grid; gap: 6px; min-width: 0; }
    .field.full { grid-column: 1 / -1; }
    .field label { color: var(--muted); font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; font-weight: 500; letter-spacing: 0.06em; }
    .field-row { display: flex; align-items: center; gap: 8px; }
    .field-meta, .modal-error { font-size: 11px; line-height: 1.35; }
    .field-meta { color: var(--muted); }
    .modal-error { color: var(--red); border: 1px solid rgba(209, 76, 66, 0.34); background: var(--red-soft); border-radius: 6px; padding: 8px 9px; }
    .modal-foot { padding: 12px 18px 16px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .message { position: fixed; left: 16px; bottom: 16px; max-width: 620px; z-index: 19; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); box-shadow: 0 12px 30px var(--shadow); padding: 10px 12px; font-size: 12px; color: var(--text); display: none; opacity: 0; transform: translateY(8px); }
    .message button { margin-left: 10px; padding: 5px 8px; }
    .message.show { display: block; opacity: 1; transform: translateY(0); }
    @supports (transition-behavior: allow-discrete) {
      .message { transition: opacity 160ms ease, transform 160ms ease, display 160ms allow-discrete; }
      @starting-style {
        .message.show { opacity: 0; transform: translateY(8px); }
      }
    }
    @supports (selector(:has(*))) {
      .group:has(.table-row.selected) .group-head { background: linear-gradient(90deg, var(--blue-soft), #fbfcfe 42%); }
    }
    @supports (animation-timeline: view()) {
      @media (prefers-reduced-motion: no-preference) {
        .group {
          animation: group-reveal both ease-out;
          animation-timeline: view();
          animation-range: entry 0% cover 22%;
        }
      }
    }
    @keyframes group-reveal {
      from { opacity: 0.68; transform: translateY(8px) scale(0.996); }
      to { opacity: 1; transform: none; }
    }
    @supports (view-transition-name: none) {
      .toolbar { view-transition-name: mediation-toolbar; }
      .drawer { view-transition-name: mediation-drawer; contain: layout; }
    }
    @media (min-width: 1101px) {
      .state-strip, .board-wrap { transition: margin-right 240ms cubic-bezier(.2,.7,.2,1); }
      body.detail-open .toolbar, body.detail-open .live-stripe, body.detail-open .state-strip, body.detail-open .board-wrap { margin-right: var(--detail-drawer-space); }
      body.detail-open .toolbar { background: color-mix(in oklab, var(--surface) 88%, transparent); }
      body.detail-open .toolbar-actions { justify-content: flex-end; }
      body.detail-open .toolbar-actions .search-wrap { display: none; }
      body.detail-open #refresh-button { display: none; }
      body.detail-open #create-intent-button { display: none; }
      body.detail-open .toolbar .brand-lockup { display: none; }
      .live-stripe { position: sticky; top: var(--chrome-height); z-index: 9; }
      .state-strip { position: sticky; top: calc(var(--chrome-height) + var(--mode-height)); z-index: 8; box-shadow: 0 1px 0 var(--line), 0 12px 24px rgba(15, 23, 42, 0.04); }
    }
    @container main (max-width: 820px) {
      .toolbar-actions { min-width: 0; }
      .table { min-width: 720px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.001ms !important;
      }
    }
    @media (max-width: 1100px) {
      body { overflow: auto; }
      .mediation-centre { min-height: 100vh; height: auto; grid-template-columns: minmax(0, 1fr); }
      .drawer, .drawer-scrim { inset: 0 0 0 auto; height: 100vh; }
      .drawer-scrim { inset: 0; }
      body.detail-open .drawer-scrim { display: block; opacity: 1; }
      .toolbar { min-height: 0; align-items: stretch; grid-template-columns: 1fr; }
      .header-menu { width: 100%; }
      .toolbar-actions { width: 100%; min-width: 0; flex-wrap: wrap; }
      .toolbar-actions .search-wrap { flex: 1 0 100%; }
      .toolbar-actions button { flex: 1 1 130px; }
      .brand-lockup { justify-items: start; border-left: 0; border-top: 1px solid var(--line); padding: 8px 0 0; width: 100%; }
      .table { min-width: 0; }
      .table-row, .table-head { grid-template-columns: 24px minmax(160px, 1fr) 74px 86px 68px; }
      .table-head div:nth-child(n+6), .table-row .cell:nth-child(n+6) { display: none; }
      .form-grid { grid-template-columns: 1fr; }
      .message { left: 16px; right: 16px; }
    }
  </style>
</head>
<body>
  <div class="mediation-centre">
    <main class="main">
      <header class="toolbar">
        <div class="title-block">
          <h1>Mediation Centre</h1>
          <span id="board-subtitle">Live CML coordination board</span>
        </div>
        <nav class="header-menu" id="header-menu" aria-label="Mediation centre views"></nav>
        <div class="toolbar-actions">
          <div class="search-wrap"><span>/</span><input id="search" type="search" placeholder="Search intents, reports, events"></div>
          <button class="ghost" id="refresh-button">Refresh</button>
          <button class="primary" id="create-intent-button" data-act="open-create-intent">Create Intent</button>
          <div class="brand-lockup" aria-label="CML"><strong>CML</strong><span>coordination</span></div>
        </div>
      </header>
      <div class="live-stripe" id="live-stripe"></div>
      <section class="state-strip" id="state-strip"></section>
      <section class="board-wrap" id="board"></section>
    </main>
    <aside class="drawer" id="drawer"></aside>
    <div class="drawer-scrim" data-act="close-detail-drawer" aria-hidden="true"></div>
  </div>
  <div class="modal-layer" id="intent-modal" aria-hidden="true"></div>
  <div class="message" id="message"></div>
  <script id="human-bootstrap" type="application/json">${jsonForScript(bootstrap)}</script>
  <script>
  (() => {
    const boot = JSON.parse(document.getElementById("human-bootstrap").textContent);
    let state = boot.state;
    let setupError = boot.setupError;
    let selectedIntentId = null;
    let drawerTab = "mediate";
    let query = "";
    let statusFilter = "all";
    let workspaceView = "home";
    let detailOpen = false;
    const collapsedGroups = new Set();
    let intentModalOpen = false;
    let intentModalBusy = false;
    let intentModalError = "";
    let intentDraft = { headline: "", body: "", status: "draft", parentId: "", addressedTo: "" };
    let messageTimer = null;
    let pendingUndo = null;

    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const short = (value, max = 120) => {
      const text = String(value || "");
      return text.length > max ? text.slice(0, max - 1) + "..." : text;
    };
    const byNumberId = (items) => new Map((items || []).map((item) => [Number(item.id), item]));
    const canWrite = () => Boolean(state && state.actor);
    const domainsById = () => byNumberId(state ? state.domains : []);
    const actorsById = () => byNumberId(state ? state.actors : []);
    const intentCode = (intent) => "INTENT-" + intent.id;
    const interpCode = (interp) => "INT-" + interp.id;
    const reportCode = (report) => "RPT-" + report.id;
    const dateLabel = (value) => {
      if (!value) return "No event";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "No event";
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    };

    function showMessage(text, undo) {
      const node = $("message");
      pendingUndo = undo || null;
      node.innerHTML = esc(text) + (undo ? '<button data-act="undo-write">Undo</button>' : "");
      node.classList.add("show");
      clearTimeout(messageTimer);
      messageTimer = setTimeout(() => {
        node.classList.remove("show");
        pendingUndo = null;
      }, undo ? 10000 : 4200);
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        method: options.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        const error = body.error && body.error.message ? body.error.message : "Request failed";
        throw new Error(error);
      }
      return body;
    }

    async function refreshState() {
      try {
        const response = await fetch("/api/operator-state");
        const body = await response.json();
        if (!response.ok || !body.ok) {
          setupError = body.error || { code: "STATE_UNAVAILABLE", message: "Could not read operator state" };
          render();
          return;
        }
        state = body.data;
        setupError = null;
        selectDefaultIntent();
        render();
      } catch (error) {
        setupError = { code: "STATE_UNAVAILABLE", message: String(error && error.message ? error.message : error) };
        render();
      }
    }

    function selectDefaultIntent() {
      if (!state || !state.intents || !state.intents.length) {
        selectedIntentId = null;
        return;
      }
      const visible = visibleGroups().flatMap((group) => group.items);
      if (selectedIntentId && visible.some((intent) => Number(intent.id) === Number(selectedIntentId))) return;
      const first = visible[0] || state.intents[0];
      selectedIntentId = Number(first.id);
    }

    function intentInterpretations(intent) {
      return (state && state.interpretations ? state.interpretations : []).filter((item) => Number(item.intentId) === Number(intent.id));
    }

    function intentReports(intent) {
      return (state && state.reports ? state.reports : []).filter((item) => Number(item.intentId) === Number(intent.id));
    }

    function intentClaims(intent) {
      return (state && state.claims ? state.claims : []).filter((claim) => claim.status === "active" && claim.entityTable === "intents" && Number(claim.entityId) === Number(intent.id));
    }

    function intentEvents(intent) {
      const interps = new Set(intentInterpretations(intent).map((item) => Number(item.id)));
      return (state && state.events ? state.events : []).filter((event) =>
        (event.entityTable === "intents" && Number(event.entityId) === Number(intent.id)) ||
        (event.entityTable === "interpretations" && interps.has(Number(event.entityId)))
      ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    function hasMediationNeed(intent) {
      const groups = (state && state.divergenceGroups ? state.divergenceGroups : []).filter((group) => Number(group.intentId) === Number(intent.id));
      if (groups.length) return true;
      return intentInterpretations(intent).some((interp) =>
        interp.alignment === "divergent" ||
        interp.alignment === "uncertain" ||
        interp.status === "flagged" ||
        interp.status === "clarifying"
      );
    }

    function alignmentTone(intent) {
      const interps = intentInterpretations(intent);
      if (!interps.length) return "uncertain";
      if (interps.some((item) => item.alignment === "divergent" || item.status === "flagged")) return "divergent";
      if (interps.some((item) => item.alignment === "uncertain" || item.status === "clarifying")) return "uncertain";
      if (interps.every((item) => item.alignment === "aligned")) return "aligned";
      return "uncertain";
    }

    function nextAction(intent) {
      if (hasMediationNeed(intent)) return "Mediate";
      if (intent.status === "draft") return "Clarify";
      if (intent.status === "closed" || intent.status === "superseded") return "Review";
      return "Log Action";
    }

    function rowActionLabel(intent) {
      return intent.status === "closed" || intent.status === "superseded" ? "Review" : "Open";
    }

    function bucketForIntent(intent) {
      if (!intent) return { key: "none", title: "No bucket" };
      if (hasMediationNeed(intent) && intent.status !== "closed" && intent.status !== "superseded") return { key: "needs", title: "Needs Mediation" };
      if (intent.status === "active") return { key: "active", title: "Active Planning" };
      if (intent.status === "draft") return { key: "draft", title: "Draft / Intake" };
      return { key: "closed", title: "Recently Closed" };
    }

    function groupedIntents() {
      const all = state && state.intents ? [...state.intents] : [];
      const q = query.trim().toLowerCase();
      const filtered = all.filter((intent) => {
        if (statusFilter !== "all" && intent.status !== statusFilter) return false;
        if (!q) return true;
        const haystack = [
          intentCode(intent),
          intent.description,
          intent.resolutionNotes,
          intent.status,
          alignmentTone(intent),
          intentReports(intent).map((report) => report.title).join(" "),
          intentInterpretations(intent).map((interp) => interp.title).join(" "),
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
      const sortByUpdated = (items) => items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return [
        { key: "needs", title: "Needs Mediation", items: sortByUpdated(filtered.filter((intent) => hasMediationNeed(intent) && intent.status !== "closed" && intent.status !== "superseded")) },
        { key: "active", title: "Active Planning", items: sortByUpdated(filtered.filter((intent) => intent.status === "active" && !hasMediationNeed(intent))) },
        { key: "draft", title: "Draft / Intake", items: sortByUpdated(filtered.filter((intent) => intent.status === "draft" && !hasMediationNeed(intent))) },
        { key: "closed", title: "Recently Closed", items: sortByUpdated(filtered.filter((intent) => intent.status === "closed" || intent.status === "superseded")).slice(0, 25) },
      ];
    }

    function visibleGroups() {
      const groups = groupedIntents();
      if (workspaceView === "mediation") return groups.filter((group) => group.key === "needs");
      return groups;
    }

    function renderNav() {
      const menu = $("header-menu");
      if (!menu) return;
      const views = [
        ["home", "Home"],
        ["intents", "Intents"],
        ["mediation", "Mediation"],
        ["reports", "Reports"],
        ["events", "Events"],
      ];
      const viewHtml = views.map(([view, label]) =>
        '<button class="' + (view === workspaceView ? "active" : "") + '" data-act="nav-view" data-nav-view="' + view + '">' + label + '</button>'
      ).join("");
      menu.innerHTML = viewHtml;
    }

    function renderRail() {
      if (!$("rail-footer")) return;
      const actor = state && state.actor;
      const initials = actor ? actor.name.split(/[-_\\s]+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() : "--";
      $("rail-footer").innerHTML = '<div class="actor-chip"><span class="avatar">' + esc(initials) + '</span><span>' + esc(actor ? actor.name : "No actor configured") + '</span></div>' +
        '<div>' + esc(actor ? actor.defaultScope : "Writes disabled until actor is set") + '</div>';
    }

    function renderStateStrip() {
      const summary = state && state.summary ? state.summary : {};
      const statusClass = setupError ? "error" : canWrite() ? "ok" : "warn";
      const statusText = setupError
        ? setupError.code + ": " + setupError.message
        : canWrite()
          ? "You're working in the live store; changes save instantly."
          : "Read-only preview. Set CML_ACTOR or CML_ACTOR_ID to enable governed writes.";
      const filters = ["all", "active", "draft", "closed", "superseded"];
      const allIntents = state && state.intents ? state.intents : [];
      const statusCount = (filter) => filter === "all" ? allIntents.length : allIntents.filter((intent) => intent.status === filter).length;
      $("live-stripe").className = "live-stripe " + statusClass;
      $("live-stripe").textContent = statusText;
      $("state-strip").innerHTML =
        '<div class="filter-set" aria-label="Intent status filters">' +
          filters.map((filter) => '<button class="filter-chip ' + (statusFilter === filter ? "active" : "") + '" data-act="filter" data-filter="' + filter + '">' + filter + ' <span class="num-cell">' + statusCount(filter) + '</span></button>').join("") +
        '</div>' +
        '<span class="rail-meta">divergence ' + (summary.divergenceGroupCount || 0) + ' / claims ' + (summary.activeClaimCount || 0) + '</span>';
      $("board-subtitle").textContent = state && state.generatedAt ? "Snapshot " + dateLabel(state.generatedAt) : "Setup required before live state can load";
    }

    function renderBoard() {
      if (setupError && !state) {
        $("board").innerHTML = '<section class="setup-panel"><strong>CML needs a governance database before live data can load.</strong><span>' + esc(setupError.message) + '</span><span class="tiny">Run cml init or set CML_DB_PATH, then refresh this surface.</span></section>';
        return;
      }
      if (!state || !state.intents || !state.intents.length) {
        $("board").innerHTML = '<section class="empty-board"><strong>No intents in the current live snapshot.</strong><span>Create Intent starts a draft record when an actor is configured.</span></section>';
        return;
      }
      const groups = visibleGroups();
      const html = groups.map((group) => renderGroup(group)).join("");
      $("board").innerHTML = html || '<section class="empty-board"><strong>No intents match this view.</strong><span>Clear search or filters to return to the full board.</span></section>';
    }

    function renderGroup(group) {
      const collapsed = collapsedGroups.has(group.key);
      return '<section class="group ' + (collapsed ? "collapsed" : "") + '" data-group="' + group.key + '">' +
        '<header class="group-head"><span class="group-bar ' + group.key + '"></span><div class="group-title"><button class="icon ghost" data-act="toggle-group" data-group="' + group.key + '" aria-expanded="' + (!collapsed) + '" aria-label="' + (collapsed ? "Expand " : "Collapse ") + esc(group.title) + '">' + (collapsed ? ">" : "v") + '</button>' + esc(group.title) + '</div><span class="group-count">' + group.items.length + ' items</span></header>' +
        (collapsed ? "" : '<div class="table">' +
          '<div class="table-head"><div></div><div>Intent</div><div>Status</div><div>Alignment</div><div>Owner</div><div>Domain</div><div title="Interpretations on file">Int</div><div>Rpt</div><div>Action</div><div>Last</div></div>' +
          (group.items.length ? group.items.map(renderIntentRow).join("") : '<div class="table-row"><div class="cell"></div><div class="cell" style="grid-column: span 9;"><span class="tiny">No items in this group.</span></div></div>') +
        '</div>') +
      '</section>';
    }

    function renderIntentRow(intent) {
      const interps = intentInterpretations(intent);
      const reports = intentReports(intent);
      const claims = intentClaims(intent);
      const events = intentEvents(intent);
      const domainMap = domainsById();
      const domainIds = [...new Set(interps.map((interp) => Number(interp.domainId)))];
      const tone = alignmentTone(intent);
      const selected = Number(selectedIntentId) === Number(intent.id);
      const claim = claims[0];
      const actorMap = actorsById();
      const claimLabel = claim ? (actorMap.get(Number(claim.actorId))?.name || "claimed") : "unclaimed";
      const firstDomain = domainIds.length ? domainMap.get(domainIds[0])?.name || ("domain " + domainIds[0]) : "none";
      const extraDomains = domainIds.length > 1 ? " +" + (domainIds.length - 1) : "";
      return '<div class="table-row ' + (selected ? "selected" : "") + '" data-act="select-intent" data-id="' + intent.id + '">' +
        '<div class="cell center"><input type="checkbox" ' + (selected ? "checked" : "") + ' aria-label="Select ' + esc(intentCode(intent)) + '"></div>' +
        '<div class="cell"><div class="intent-title"><span class="id">' + intentCode(intent) + ' / ' + esc(claimLabel) + '</span><strong>' + esc(short(intent.description, 96)) + '</strong>' + (hasMediationNeed(intent) && interps[0] ? '<span class="tiny">' + esc(short(interps[0].title, 88)) + '</span>' : '') + '</div></div>' +
        '<div class="cell">' + statusSelect("intent", intent.id, intent.status) + '</div>' +
        '<div class="cell"><span class="pill ' + tone + '"><span class="swatch ' + tone + '"></span>' + tone + '</span></div>' +
        '<div class="cell">' + (claim ? '<button class="mutate" data-act="release-claim" data-id="' + claim.id + '" title="' + esc(claimLabel) + '">' + esc(short(claimLabel, 12)) + '</button>' : '<button class="mutate" data-act="claim" data-id="' + intent.id + '"' + (!canWrite() ? " disabled" : "") + '>Claim</button>') + '</div>' +
        '<div class="cell"><span class="domain" title="' + esc(firstDomain + extraDomains) + '">' + esc(short(firstDomain, 16) + extraDomains) + '</span></div>' +
        '<div class="cell center"><span class="num-cell ' + (interps.length ? "" : "zero") + '">' + interps.length + '</span></div>' +
        '<div class="cell center"><span class="num-cell ' + (reports.length ? "" : "zero") + '">' + reports.length + '</span></div>' +
        '<div class="cell"><button data-act="next-action" data-id="' + intent.id + '">' + esc(rowActionLabel(intent)) + '</button></div>' +
        '<div class="cell"><span class="tiny">' + esc(events[0] ? events[0].eventType + " / " + dateLabel(events[0].createdAt) : dateLabel(intent.updatedAt)) + '</span></div>' +
      '</div>';
    }

    function statusSelect(type, id, value) {
      const values = type === "intent" ? ["draft", "active", "closed", "superseded"] : ["fyi", "clarifying", "proposed", "flagged", "superseded"];
      return '<select class="status-select mutate-control ' + esc(value) + '" data-act="status" data-type="' + type + '" data-id="' + id + '" data-current="' + esc(value) + '"' + (!canWrite() ? " disabled" : "") + '>' +
        values.map((option) => '<option value="' + option + '"' + (option === value ? " selected" : "") + '>' + option + '</option>').join("") +
      '</select>';
    }

    function alignmentSelect(id, value) {
      const values = ["aligned", "uncertain", "divergent", "superseded"];
      return '<select class="alignment-select pill mutate-control ' + esc(value) + '" data-act="alignment" data-id="' + id + '" data-current="' + esc(value) + '"' + (!canWrite() ? " disabled" : "") + '>' +
        values.map((option) => '<option value="' + option + '"' + (option === value ? " selected" : "") + '>' + option + '</option>').join("") +
      '</select>';
    }

    function selectedIntent() {
      if (!state || !state.intents) return undefined;
      return state.intents.find((intent) => Number(intent.id) === Number(selectedIntentId));
    }

    function renderDrawer() {
      const intent = selectedIntent();
      const drawer = $("drawer");
      const bucket = bucketForIntent(intent);
      drawer.className = "drawer" + (intent ? " bucket-" + bucket.key : "");
      drawer.setAttribute("aria-hidden", String(!detailOpen || !intent));
      if (!intent) {
        drawer.innerHTML =
          '<header class="drawer-head"><div class="drawer-rail"><button class="drawer-close" data-act="close-detail-drawer" aria-label="Close detail pane">x</button><nav class="drawer-tabs" role="tablist" aria-label="Detail sections"></nav><div class="brand-lockup drawer-brand" aria-label="CML"><strong>CML</strong><span>coordination</span></div></div><div class="drawer-summary"><div class="drawer-title"><span class="id">No selection</span><h2>Select an intent</h2></div></div></header>' +
          '<div class="drawer-body"><section class="empty-board"><strong>Mediation drawer</strong><span>Pick a row to inspect interpretations, events, and governed write controls.</span></section></div>';
        return;
      }
      const claims = intentClaims(intent);
      const claim = claims[0];
      const claimButton = claim
        ? '<button class="mutate" data-act="release-claim" data-id="' + claim.id + '"' + (!canWrite() ? " disabled" : "") + '>Release Claim</button>'
        : '<button class="mutate" data-act="claim" data-id="' + intent.id + '"' + (!canWrite() ? " disabled" : "") + '>Claim</button>';
      const tabLabels = { mediate: "Mediate", updates: "Updates", events: "Trail" };
      drawer.innerHTML =
        '<header class="drawer-head">' +
          '<div class="drawer-rail">' +
            '<button class="drawer-close" data-act="close-detail-drawer" aria-label="Close detail pane">x</button>' +
            '<nav class="drawer-tabs" role="tablist" aria-label="Detail sections">' + ["mediate", "updates", "events"].map((tab) => '<button class="tab ' + (drawerTab === tab ? "active" : "") + '" data-act="drawer-tab" data-tab="' + tab + '" role="tab" aria-selected="' + (drawerTab === tab) + '">' + tabLabels[tab] + '</button>').join("") + '</nav>' +
            '<div class="brand-lockup drawer-brand" aria-label="CML"><strong>CML</strong><span>coordination</span></div>' +
          '</div>' +
          '<div class="drawer-summary">' +
            '<div class="drawer-title"><span class="drawer-breadcrumb">' + esc(bucket.title) + ' / ' + intentCode(intent) + '</span><h2>' + esc(short(intent.description, 120)) + '</h2></div>' +
            '<div class="drawer-actions">' + statusSelect("intent", intent.id, intent.status) + claimButton + '<button data-act="focus-composer">Log Action</button><button data-act="focus-report">Create Report</button></div>' +
          '</div>' +
        '</header>' +
        '<div class="drawer-body">' + (drawerTab === "mediate" ? renderMediateTab(intent) : drawerTab === "updates" ? renderUpdatesTab(intent) : renderEventsTab(intent)) + '</div>';
    }

    function renderMediateTab(intent) {
      const interps = intentInterpretations(intent);
      const reports = intentReports(intent);
      const tone = alignmentTone(intent);
      const unresolved = hasMediationNeed(intent)
        ? interps.filter((item) => item.alignment !== "aligned" || item.status === "flagged" || item.status === "clarifying").length + " open interpretation signals"
        : "No active divergence signal";
      return '<section class="detail-grid">' +
          detailBlock("Observed", "Status " + intent.status + ", version " + intent.version + ", " + interps.length + " interpretations, " + reports.length + " reports.") +
          detailBlock("Inferred", "Next useful move: " + nextAction(intent) + ". Current alignment reads " + tone + ".") +
          detailBlock("Unresolved", unresolved) +
          detailBlock("Proposed", "Use the composer below for a governed update, action, or report.") +
          (intent.resolutionNotes ? detailBlock("Body", intent.resolutionNotes, true) : "") +
        '</section>' +
        '<section>' +
          '<div class="section-title"><span>Interpretations</span><button data-act="focus-interpretation">Add</button></div>' +
          '<div style="display:grid;gap:8px;margin-top:8px;">' + (interps.length ? interps.map(renderInterpretationCard).join("") : '<div class="empty-board"><strong>No interpretations yet.</strong><span>Add one to make assumptions explicit.</span></div>') + '</div>' +
        '</section>' +
        renderComposer(intent) +
        renderAddInterpretation(intent);
    }

    function detailBlock(label, text, wide) {
      return '<article class="detail-block ' + (wide ? "wide" : "") + '"><span>' + esc(label) + '</span><p>' + esc(text) + '</p></article>';
    }

    function renderInterpretationCard(interp) {
      const domain = domainsById().get(Number(interp.domainId));
      return '<article class="interp-card">' +
        '<div class="interp-top"><div><span class="id">' + interpCode(interp) + '</span><div class="tiny">' + esc(domain ? domain.name : "domain " + interp.domainId) + '</div></div><button class="mutate" data-act="supersede" data-id="' + interp.id + '"' + (!canWrite() ? " disabled" : "") + '>Supersede</button></div>' +
        '<strong style="font-size:13px;line-height:1.3;font-weight:500;">' + esc(short(interp.title, 120)) + '</strong>' +
        (interp.scopeAssumption ? '<div class="tiny">' + esc(short(interp.scopeAssumption, 140)) + '</div>' : '') +
        '<div class="interp-controls">' + statusSelect("interpretation", interp.id, interp.status) + alignmentSelect(interp.id, interp.alignment) + '</div>' +
      '</article>';
    }

    function renderComposer(intent) {
      return '<section class="composer" id="composer">' +
        '<div class="section-title"><span>Divergence Composer</span><span class="tiny">write-through</span></div>' +
        '<input id="write-title" placeholder="Reason, action outcome, or report title" ' + (!canWrite() ? "disabled" : "") + '>' +
        '<textarea id="write-body" placeholder="Write the update, action description, or report summary" ' + (!canWrite() ? "disabled" : "") + '></textarea>' +
        '<div class="button-row">' +
          '<button class="mutate" data-act="update-intent" data-id="' + intent.id + '"' + (!canWrite() ? " disabled" : "") + '>Update Intent</button>' +
          '<button class="primary" data-act="log-action" data-id="' + intent.id + '"' + (!canWrite() ? " disabled" : "") + '>Log Action</button>' +
          '<button data-act="create-report" data-id="' + intent.id + '"' + (!canWrite() ? " disabled" : "") + '>Create Report</button>' +
        '</div>' +
        (!canWrite() ? '<div class="tiny">Set CML_ACTOR or CML_ACTOR_ID to enable governed writes.</div>' : '') +
      '</section>';
    }

    function renderAddInterpretation(intent) {
      const domains = state && state.domains ? state.domains : [];
      return '<section class="composer" id="interpretation-composer">' +
        '<div class="section-title"><span>Add Interpretation</span><span class="tiny">domain scoped</span></div>' +
        '<select id="new-interpretation-domain" ' + (!canWrite() ? "disabled" : "") + '>' + domains.map((domain) => '<option value="' + domain.id + '">' + esc(domain.name) + '</option>').join("") + '</select>' +
        '<input id="new-interpretation-title" placeholder="What this domain understands the intent to mean" ' + (!canWrite() ? "disabled" : "") + '>' +
        '<textarea id="new-interpretation-scope" placeholder="Scope assumption" ' + (!canWrite() ? "disabled" : "") + '></textarea>' +
        '<button data-act="create-interpretation" data-id="' + intent.id + '"' + (!canWrite() || !domains.length ? " disabled" : "") + '>Add Interpretation</button>' +
      '</section>';
    }

    function renderUpdatesTab(intent) {
      const reports = intentReports(intent);
      const actions = (state && state.actions ? state.actions : []).filter((action) => Number(action.intentId) === Number(intent.id));
      const items = [
        ...reports.map((item) => ({ kind: "report", at: item.createdAt, html: '<article class="event-card"><span class="id">' + reportCode(item) + '</span><strong>' + esc(item.title) + '</strong><span class="tiny">' + esc(short(item.summary, 160)) + '</span></article>' })),
        ...actions.map((item) => ({ kind: "action", at: item.createdAt, html: '<article class="event-card"><span class="id">ACTION-' + item.id + '</span><strong>' + esc(short(item.description, 120)) + '</strong><span class="tiny">' + esc(short(item.outcome || "", 160)) + '</span></article>' })),
      ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return items.length ? items.map((item) => item.html).join("") : '<section class="empty-board"><strong>No updates linked to this intent.</strong><span>Use Log Action or Create Report from Mediate.</span></section>';
    }

    function renderEventsTab(intent) {
      const events = intentEvents(intent);
      return events.length ? events.map((event) =>
        '<article class="event-card"><span class="id">EVT-' + event.id + '</span><strong>' + esc(event.eventType) + '</strong><span class="tiny">' + esc(event.entityTable + " #" + event.entityId + " / " + dateLabel(event.createdAt)) + '</span>' + (event.reason ? '<span class="tiny">' + esc(short(event.reason, 140)) + '</span>' : '') + '</article>'
      ).join("") : '<section class="empty-board"><strong>No trail for this intent yet.</strong><span>Focus and write actions will appear here.</span></section>';
    }

    function composerValues() {
      return {
        title: ($("write-title") ? $("write-title").value.trim() : ""),
        body: ($("write-body") ? $("write-body").value.trim() : ""),
      };
    }

    function intentModalValues() {
      return {
        headline: ($("intent-headline") ? $("intent-headline").value.trim() : ""),
        body: ($("intent-body") ? $("intent-body").value.trim() : ""),
        status: ($("intent-status") ? $("intent-status").value : "draft"),
        parentId: ($("intent-parent") ? $("intent-parent").value : ""),
        addressedTo: ($("intent-addressed-to") ? $("intent-addressed-to").value : ""),
      };
    }

    function renderIntentModal() {
      const modal = $("intent-modal");
      if (!modal) return;
      if (!intentModalOpen) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        modal.innerHTML = "";
        document.body.classList.remove("modal-open");
        return;
      }
      const intents = state && state.intents ? state.intents : [];
      const actors = state && state.actors ? state.actors : [];
      const actor = state && state.actor ? state.actor : null;
      const disabled = intentModalBusy || !canWrite();
      const statuses = ["draft", "active", "closed", "superseded"];
      const selectedOption = (value, selected) => value === selected ? " selected" : "";
      modal.innerHTML =
        '<div class="modal-backdrop" data-act="close-intent-modal"></div>' +
        '<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="intent-modal-title">' +
          '<header class="modal-head"><div><h2 id="intent-modal-title">Create Intent</h2><span>Headline is required. Body is optional but recommended.</span></div><button class="icon ghost" data-act="close-intent-modal" aria-label="Close intent editor">x</button></header>' +
          '<div class="modal-body">' +
            (intentModalError ? '<div class="modal-error">' + esc(intentModalError) + '</div>' : '') +
            '<div class="form-grid">' +
              '<div class="field full"><label for="intent-headline">Headline required</label><input id="intent-headline" value="' + esc(intentDraft.headline) + '" placeholder="Outcome, question, or planning object" ' + (disabled ? "disabled" : "") + '></div>' +
              '<div class="field full"><label for="intent-body">Body</label><textarea id="intent-body" placeholder="Context, success shape, constraints, or mediation notes" ' + (disabled ? "disabled" : "") + '>' + esc(intentDraft.body) + '</textarea></div>' +
              '<div class="field"><label for="intent-status">Status</label><select id="intent-status" ' + (disabled ? "disabled" : "") + '>' + statuses.map((status) => '<option value="' + status + '"' + selectedOption(status, intentDraft.status) + '>' + status + '</option>').join("") + '</select></div>' +
              '<div class="field"><label for="intent-parent">Parent</label><select id="intent-parent" ' + (disabled ? "disabled" : "") + '><option value="">Top-level</option>' + intents.map((intent) => '<option value="' + intent.id + '"' + selectedOption(String(intent.id), String(intentDraft.parentId)) + '>' + esc(intentCode(intent) + " / " + short(intent.description, 64)) + '</option>').join("") + '</select></div>' +
              '<div class="field full"><label for="intent-addressed-to">Addressed to</label><div class="field-row"><select id="intent-addressed-to" ' + (disabled ? "disabled" : "") + '><option value="">Unassigned</option>' + actors.map((actor) => '<option value="' + actor.id + '"' + selectedOption(String(actor.id), String(intentDraft.addressedTo)) + '>' + esc(actor.name) + '</option>').join("") + '</select>' + (actor ? '<button type="button" data-act="assign-intent-to-me" ' + (disabled ? "disabled" : "") + '>Assign to me</button>' : '') + '</div></div>' +
            '</div>' +
            (!canWrite() ? '<div class="field-meta">Set CML_ACTOR or CML_ACTOR_ID to enable governed writes.</div>' : '') +
          '</div>' +
          '<footer class="modal-foot"><button data-act="close-intent-modal" ' + (intentModalBusy ? "disabled" : "") + '>Cancel</button><button class="primary" data-act="submit-intent-modal" ' + (disabled ? "disabled" : "") + '>' + (intentModalBusy ? "Creating..." : "Create Intent") + '</button></footer>' +
        '</section>';
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");
    }

    function openIntentModal() {
      if (!canWrite()) { showMessage("Create Intent needs an active actor."); return; }
      intentDraft = { headline: "", body: "", status: "draft", parentId: "", addressedTo: "" };
      intentModalError = "";
      intentModalBusy = false;
      intentModalOpen = true;
      renderIntentModal();
      setTimeout(() => $("intent-headline") && $("intent-headline").focus(), 0);
    }

    function closeIntentModal() {
      if (intentModalBusy) return;
      intentModalOpen = false;
      intentModalError = "";
      renderIntentModal();
    }

    async function submitIntentModal() {
      if (intentModalBusy) return;
      intentDraft = intentModalValues();
      if (!intentDraft.headline) {
        intentModalError = "Headline is required.";
        renderIntentModal();
        setTimeout(() => $("intent-headline") && $("intent-headline").focus(), 0);
        return;
      }
      intentModalBusy = true;
      intentModalError = "";
      renderIntentModal();
      const createBody = {
        description: intentDraft.headline,
        status: intentDraft.status,
        source: "mediation-centre",
      };
      if (intentDraft.parentId) createBody.parentId = Number(intentDraft.parentId);
      if (intentDraft.addressedTo) createBody.addressedTo = Number(intentDraft.addressedTo);
      const result = await writeAndRefresh(async () => {
        const created = await api("/api/intents", { body: createBody });
        const createdId = Number(created && created.data && created.data.id);
        if (createdId && intentDraft.body) {
          await api("/api/intents/" + createdId, {
            method: "PATCH",
            body: { reason: "Mediation Centre intake body", resolutionNotes: intentDraft.body },
          });
        }
        if (createdId) {
          selectedIntentId = createdId;
          workspaceView = "intents";
          statusFilter = "all";
          drawerTab = "mediate";
          detailOpen = true;
        }
        return created;
      });
      intentModalBusy = false;
      if (result) {
        intentModalOpen = false;
        intentDraft = { headline: "", body: "", status: "draft", parentId: "", addressedTo: "" };
      } else {
        intentModalError = "Create Intent did not complete.";
      }
      renderIntentModal();
    }

    function setWorkspaceView(view) {
      workspaceView = view || "home";
      if (workspaceView === "reports") drawerTab = "updates";
      else if (workspaceView === "events") drawerTab = "events";
      else drawerTab = "mediate";
      if (workspaceView === "home" || workspaceView === "intents" || workspaceView === "mediation") statusFilter = "all";
      if ((workspaceView === "reports" || workspaceView === "events") && selectedIntent()) detailOpen = true;
      render();
    }

    async function emitFocus(intentId) {
      if (!canWrite()) return;
      try {
        await api("/api/focus", { body: { entityType: "intent", entityId: Number(intentId), pendingAction: "mediate" } });
      } catch {
      }
    }

    async function selectIntent(id) {
      selectedIntentId = Number(id);
      detailOpen = true;
      await emitFocus(id);
      render();
    }

    async function writeAndRefresh(action, message, undo) {
      if (!canWrite()) {
        showMessage("Writes need CML_ACTOR or CML_ACTOR_ID.");
        return false;
      }
      try {
        const result = await action();
        await refreshState();
        showMessage(message || "Governed write recorded.", undo);
        return result || true;
      } catch (error) {
        showMessage(String(error && error.message ? error.message : error));
        render();
        return false;
      }
    }

    function render() {
      selectDefaultIntent();
      if (!selectedIntent()) detailOpen = false;
      document.body.classList.toggle("detail-open", detailOpen && Boolean(selectedIntent()));
      renderNav();
      renderRail();
      renderStateStrip();
      renderBoard();
      renderDrawer();
      renderIntentModal();
    }

    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      const act = target.dataset.act;
      event.stopPropagation();
      if (act === "open-create-intent") {
        openIntentModal();
      } else if (act === "assign-intent-to-me") {
        const actor = state && state.actor ? state.actor : null;
        if ($("intent-addressed-to") && actor) $("intent-addressed-to").value = String(actor.id);
      } else if (act === "close-intent-modal") {
        closeIntentModal();
      } else if (act === "submit-intent-modal") {
        await submitIntentModal();
      } else if (act === "undo-write") {
        if (!pendingUndo || !pendingUndo.run) return;
        const undo = pendingUndo;
        pendingUndo = null;
        clearTimeout(messageTimer);
        try {
          await undo.run();
          await refreshState();
          showMessage(undo.success || "Change undone.");
        } catch (error) {
          showMessage(String(error && error.message ? error.message : error));
        }
      } else if (act === "close-detail-drawer") {
        detailOpen = false;
        render();
      } else if (act === "nav-view") {
        setWorkspaceView(target.dataset.navView);
      } else if (act === "toggle-group") {
        const key = target.dataset.group;
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        renderBoard();
      } else if (act === "select-intent" || act === "next-action") {
        await selectIntent(target.dataset.id);
      } else if (act === "filter") {
        statusFilter = target.dataset.filter || "all";
        render();
      } else if (act === "drawer-tab") {
        drawerTab = target.dataset.tab || "mediate";
        render();
      } else if (act === "claim") {
        await writeAndRefresh(() => api("/api/claims", { body: { entityTable: "intents", entityId: Number(target.dataset.id), note: "Claimed from Mediation Centre" } }));
      } else if (act === "release-claim") {
        await writeAndRefresh(() => api("/api/claims/" + target.dataset.id + "/release", { body: { reason: "Released from Mediation Centre" } }));
      } else if (act === "update-intent") {
        const values = composerValues();
        await writeAndRefresh(() => api("/api/intents/" + target.dataset.id, { method: "PATCH", body: { reason: values.title || "Mediation Centre update", resolutionNotes: values.body || undefined } }));
      } else if (act === "log-action") {
        const values = composerValues();
        if (!values.body && !values.title) { showMessage("Log Action needs a description."); return; }
        await writeAndRefresh(() => api("/api/actions", { body: { intentId: Number(target.dataset.id), description: values.body || values.title, outcome: values.title || undefined } }));
      } else if (act === "create-report") {
        const values = composerValues();
        if (!values.title || !values.body) { showMessage("Create Report needs a title/reason and summary."); return; }
        await writeAndRefresh(() => api("/api/reports", { body: { intentId: Number(target.dataset.id), kind: "mediation-centre-note", title: values.title, summary: values.body } }));
      } else if (act === "create-interpretation") {
        const title = $("new-interpretation-title").value.trim();
        const scope = $("new-interpretation-scope").value.trim();
        const domainId = Number($("new-interpretation-domain").value);
        if (!title || !domainId) { showMessage("Add Interpretation needs a domain and title."); return; }
        await writeAndRefresh(() => api("/api/interpretations", { body: { intentId: Number(target.dataset.id), domainId, title, scopeAssumption: scope || undefined, status: "proposed", alignment: "uncertain" } }));
      } else if (act === "supersede") {
        const title = window.prompt("Replacement interpretation title");
        if (!title) return;
        const reason = window.prompt("Reason for supersession") || "Superseded from Mediation Centre";
        await writeAndRefresh(() => api("/api/interpretations/" + target.dataset.id + "/supersede", { body: { newTitle: title, reason, newStatus: "proposed" } }));
      } else if (act === "focus-composer") {
        drawerTab = "mediate";
        render();
        setTimeout(() => $("write-body") && $("write-body").focus(), 0);
      } else if (act === "focus-report") {
        drawerTab = "mediate";
        render();
        setTimeout(() => $("write-title") && $("write-title").focus(), 0);
      } else if (act === "focus-interpretation") {
        setTimeout(() => $("new-interpretation-title") && $("new-interpretation-title").focus(), 0);
      }
    });

    document.addEventListener("change", async (event) => {
      const target = event.target;
      if (!target || !target.dataset) return;
      if (target.dataset.act === "status") {
        const type = target.dataset.type;
        const id = target.dataset.id;
        const previous = target.dataset.current || "";
        const status = target.value;
        const path = type === "intent" ? "/api/intents/" + id : "/api/interpretations/" + id;
        await writeAndRefresh(
          () => api(path, { method: "PATCH", body: { status, reason: "Mediation Centre status update" } }),
          "Status changed from " + previous + " to " + status + ".",
          previous ? {
            run: () => api(path, { method: "PATCH", body: { status: previous, reason: "Undo Mediation Centre status update" } }),
            success: "Status restored to " + previous + ".",
          } : undefined
        );
      } else if (target.dataset.act === "alignment") {
        const id = target.dataset.id;
        const previous = target.dataset.current || "";
        const alignment = target.value;
        await writeAndRefresh(
          () => api("/api/interpretations/" + id, { method: "PATCH", body: { alignment, reason: "Mediation Centre alignment update" } }),
          "Alignment changed from " + previous + " to " + alignment + ".",
          previous ? {
            run: () => api("/api/interpretations/" + id, { method: "PATCH", body: { alignment: previous, reason: "Undo Mediation Centre alignment update" } }),
            success: "Alignment restored to " + previous + ".",
          } : undefined
        );
      }
    });

    $("search").addEventListener("input", (event) => {
      query = event.target.value;
      renderBoard();
    });
    $("refresh-button").addEventListener("click", refreshState);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && intentModalOpen) {
        event.preventDefault();
        closeIntentModal();
        return;
      } else if (event.key === "Escape" && detailOpen) {
        event.preventDefault();
        detailOpen = false;
        render();
        return;
      }
      if (event.key === "/" && event.target.tagName !== "INPUT" && event.target.tagName !== "TEXTAREA") {
        event.preventDefault();
        $("search").focus();
      } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && intentModalOpen) {
        event.preventDefault();
        submitIntentModal();
      }
    });

    if (!state) refreshState();
    else render();
  })();
  </script>
</body>
</html>`;
  const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
  return { mediaType: OPERATOR_RUNTIME_MEDIA_TYPE, html, sha256, version: MEDIATION_CENTRE_RUNTIME_VERSION };
}

export const renderHumanSurfaceRuntime = renderMediationCentreRuntime;

export function buildOperatorUiManifest(params: {
  runtime: OperatorRuntime;
  publicMcpBaseUrl?: string;
  uiPublicUrls?: string[];
}): OperatorUiManifest {
  return {
    name: OPERATOR_RUNTIME_NAME,
    version: OPERATOR_RUNTIME_VERSION,
    sha256: params.runtime.sha256,
    mediaType: OPERATOR_RUNTIME_MEDIA_TYPE,
    sizeBytes: Buffer.byteLength(params.runtime.html, "utf8"),
    availableUiUrls: sanitizePublicUrls(params.uiPublicUrls ?? []),
    publicMcpUrl: sanitizePublicUrl(params.publicMcpBaseUrl ?? DEFAULT_PUBLIC_MCP_BASE_URL),
    runtimeModes: ["remote-http", "mcp-sandbox"],
    exposedCapabilities: [
      "operator-state-read",
      "cml-primitive-write",
      "focus-events",
      "direct-manipulation",
      "mcp-sandbox-runtime",
    ],
    requiredMcpTools: [...OPERATOR_REQUIRED_MCP_TOOLS],
    actionDescriptors: MCP_ACTION_DESCRIPTORS,
  };
}

function uniqueById<T extends { id: number }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [Number(item.id), item])).values()];
}

async function resolveDefaultActor(context: OperatorSurfaceContext): Promise<Actor | undefined> {
  if (context.defaultActorId != null) return await context.repo.getActor(context.defaultActorId as Actor["id"]) ?? undefined;
  if (context.defaultActor) return await context.repo.getActorByName(context.defaultActor) ?? undefined;
  return undefined;
}

async function collectExpertiseSignals(service: GovernanceService, intents: Intent[]): Promise<ExpertiseSignalRecord[]> {
  const coverage = await Promise.all(intents.map((intent) => service.getExpertiseCoverage({ intentId: Number(intent.id) })));
  return coverage.flatMap((result) => result.ok ? result.data.signals : []);
}

function buildDivergenceGroups(intents: Intent[], interpretations: Interpretation[]): DivergenceGroup[] {
  const intentMap = new Map(intents.map((intent) => [Number(intent.id), intent]));
  const byIntent = new Map<number, Interpretation[]>();
  for (const interp of interpretations) {
    if (interp.alignment !== "divergent" || interp.status === "superseded") continue;
    const key = Number(interp.intentId);
    byIntent.set(key, [...(byIntent.get(key) ?? []), interp]);
  }
  return [...byIntent.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([intentIdValue, items]) => {
      const updatedAt = items
        .map((item) => new Date(item.updatedAt).getTime())
        .sort((a, b) => b - a)[0];
      return {
        id: `group:${intentIdValue}`,
        intentId: intentIdValue,
        interpretationIds: items.map((item) => Number(item.id)),
        count: items.length,
        title: intentMap.get(intentIdValue)?.description ?? `Divergence on intent ${intentIdValue}`,
        updatedAt: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      };
    });
}

function buildSupersessionChains(interpretations: Interpretation[]): SupersessionChain[] {
  const byId = new Map(interpretations.map((interp) => [Number(interp.id), interp]));
  const predecessorsByReplacement = new Map<number, number[]>();
  for (const interp of interpretations) {
    if (interp.supersededBy == null) continue;
    const replacement = Number(interp.supersededBy);
    predecessorsByReplacement.set(replacement, [...(predecessorsByReplacement.get(replacement) ?? []), Number(interp.id)]);
  }

  const chains: SupersessionChain[] = [];
  for (const interp of interpretations) {
    const currentId = Number(interp.id);
    const predecessorIds = collectPredecessors(currentId, predecessorsByReplacement, byId);
    if (predecessorIds.length > 0) {
      chains.push({ currentId, predecessorIds, depth: predecessorIds.length });
    }
  }
  return chains;
}

function collectPredecessors(
  currentId: number,
  predecessorsByReplacement: Map<number, number[]>,
  byId: Map<number, Interpretation>,
  seen = new Set<number>()
): number[] {
  const direct = predecessorsByReplacement.get(currentId) ?? [];
  const result: number[] = [];
  for (const id of direct) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    result.push(id, ...collectPredecessors(id, predecessorsByReplacement, byId, seen));
  }
  return result;
}

function buildAttention(
  intents: Intent[],
  interpretations: Interpretation[],
  claims: Claim[],
  events: Event[]
): AttentionItem[] {
  const intentMap = new Map(intents.map((intent) => [Number(intent.id), intent]));
  const interpretationItems: AttentionItem[] = interpretations
    .filter((interp) =>
      interp.status === "flagged" ||
      interp.status === "clarifying" ||
      interp.alignment === "divergent" ||
      interp.alignment === "uncertain"
    )
    .map((interp) => ({
      id: `interpretation:${interp.id}`,
      entityType: "interpretation" as const,
      entityId: Number(interp.id),
      intentId: Number(interp.intentId),
      tone: interp.alignment === "divergent" || interp.status === "flagged" ? "red" as const : "amber" as const,
      label: `${interp.status} / ${interp.alignment}`,
      title: interp.title,
      createdAt: interp.updatedAt,
    }));
  const claimItems: AttentionItem[] = claims.slice(0, 8).map((claim) => ({
    id: `claim:${claim.id}`,
    entityType: "claim" as const,
    entityId: Number(claim.id),
    intentId: claim.entityTable === "intents" ? Number(claim.entityId) : undefined,
    tone: "blue" as const,
    label: "active claim",
    title: `${claim.entityTable} #${claim.entityId}${claim.note ? ` - ${claim.note}` : ""}`,
    createdAt: claim.createdAt,
  }));
  const eventItems: AttentionItem[] = events
    .filter((event) => event.eventType.includes("superseded") || event.eventType.includes("updated"))
    .slice(0, 8)
    .map((event) => ({
      id: `event:${event.id}`,
      entityType: "event" as const,
      entityId: Number(event.id),
      intentId: event.entityTable === "intents" ? Number(event.entityId) : undefined,
      tone: event.eventType.includes("superseded") ? "amber" as const : "blue" as const,
      label: event.eventType,
      title: `${event.entityTable} #${event.entityId}${event.reason ? ` - ${event.reason}` : ""}`,
      createdAt: event.createdAt,
    }));

  return [...interpretationItems, ...claimItems, ...eventItems]
    .map((item) => item.intentId && intentMap.has(item.intentId)
      ? { ...item, title: `${item.title} (${truncate(intentMap.get(item.intentId)!.description, 48)})` }
      : item)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
    .slice(0, 12);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function sanitizePublicUrls(values: string[]): string[] {
  return values.map(sanitizePublicUrl).filter((value): value is string => Boolean(value));
}

function sanitizePublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.includes("token") || value.includes("secret") ? undefined : value;
  }
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
